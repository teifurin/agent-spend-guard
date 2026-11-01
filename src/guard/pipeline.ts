/**
 * The guard's decision pipeline for one purchase request:
 *
 *   request -> deterministic policy (engine) -> AI reviewer (may only tighten) -> decision row + status -> charge if AUTO_APPROVE
 *
 * Composition rules (DECISIONS D9): ALLOW -> AUTO_APPROVE, HOLD -> HOLD, BLOCK -> BLOCK; the reviewer can move a
 * decision only to the right (AUTO_APPROVE -> HOLD -> BLOCK); a reviewer failure or timeout means HOLD.
 * The policy runs twice: before the reviewer and again after it, because a review takes seconds and the rules, the
 * budget or the clock may have moved meanwhile; the tighter of the two policy verdicts counts (D16). It runs once more
 * when the owner approves a held request, and a BLOCK-level rule refuses the approval (D17).
 * A request repeated under the same intent id is answered with the request already made, never a second one (D17).
 * The reviewer is a plug-in: M1 ships a passthrough, M3 adds the LLM-backed one.
 */
import type { NewRequest, Repo } from '../db/repo.js';
import { normalizeName } from '../domain/normalize.js';
import type { Decision, FinalDecision, Payment, Policy, PolicyReason, PurchaseRequest, RequestStatus, ReviewRisk } from '../domain/types.js';
import { type BudgetSnapshot, evaluatePolicy, type PolicyResult } from '../policy/engine.js';
import { type PolicyVerdict, severityOf } from '../policy/reasons.js';
import { clampText } from '../review/text.js';
import type { PayPalExecutor } from './executor.js';

export interface ReviewInput {
  request: PurchaseRequest;
  policy: Policy | undefined;
  policyVerdict: PolicyVerdict;
  policyReasons: PolicyReason[];
  budget: BudgetSnapshot | null;
}

export interface ReviewOutcome {
  risk: ReviewRisk;
  flags: string[];
  explanation: string;
  /** The reviewer's own opinion; the pipeline keeps the tighter of this and the policy's decision. */
  recommendation: FinalDecision;
}

export type Reviewer = (input: ReviewInput, signal: AbortSignal) => Promise<ReviewOutcome>;

/** Default when no reviewer is wired in (unit tests): no AI, never tightens. The server and the e2e runs always wire one (src/review). */
export const passthroughReviewer: Reviewer = async () => ({
  risk: 'low',
  flags: [],
  explanation: 'No AI review performed (passthrough: no reviewer configured).',
  recommendation: 'AUTO_APPROVE',
});

/** Stands in for the reviewer when a request is recovered after a restart: its review never finished, so it holds (D17). */
const interruptedReviewer: Reviewer = async () => {
  throw new Error('the guard restarted while this request was under review');
};

const RANK: Record<FinalDecision, number> = { AUTO_APPROVE: 0, HOLD: 1, BLOCK: 2 };
const STATUS_FOR: Record<FinalDecision, RequestStatus> = { AUTO_APPROVE: 'AUTO_APPROVED', HOLD: 'HELD', BLOCK: 'BLOCKED' };

/** The tighter of two decisions. */
export const tighter = (a: FinalDecision, b: FinalDecision): FinalDecision => (RANK[a] >= RANK[b] ? a : b);

export const finalFromVerdict = (verdict: PolicyVerdict): FinalDecision => (verdict === 'ALLOW' ? 'AUTO_APPROVE' : verdict === 'HOLD' ? 'HOLD' : 'BLOCK');

/** A repeated request_purchase whose intent id already names a different purchase (D17). */
export class IntentConflictError extends Error {
  constructor(
    readonly existing: PurchaseRequest,
    readonly differences: string[],
  ) {
    super(`intent_id "${existing.intentId ?? ''}" already names request ${existing.id}, with a different ${differences.join(', ')}; use a new intent_id for a new purchase`);
    this.name = 'IntentConflictError';
  }
}

/** The owner tried to approve a held request that a BLOCK-level rule now forbids (D17). */
export class ApprovalRefusedError extends Error {
  constructor(readonly reasons: PolicyReason[]) {
    super(`cannot approve: ${reasons.map((r) => r.message).join('; ')}. Fix the rule, or deny the request.`);
    this.name = 'ApprovalRefusedError';
  }
}

/** Which of the fields that define a purchase differ between a stored request and a repeat of it. */
function intentDifferences(existing: PurchaseRequest, input: NewRequest): string[] {
  const differences: string[] = [];
  if (normalizeName(input.merchant) !== existing.merchantKey) differences.push('merchant');
  if (input.item !== existing.item) differences.push('item');
  if (normalizeName(input.category) !== normalizeName(existing.category)) differences.push('category');
  if (input.amountMinor !== existing.amountMinor) differences.push('amount');
  if (input.currency !== existing.currency) differences.push('currency');
  return differences;
}

export interface GuardDeps {
  repo: Repo;
  reviewer?: Reviewer;
  /** How long the reviewer may take before the request is held instead. */
  reviewTimeoutMs?: number;
  /** When present, AUTO_APPROVE and owner approval charge immediately. */
  executor?: PayPalExecutor;
  now?: () => number;
}

export interface GuardResult {
  replayed: false;
  request: PurchaseRequest;
  decision: Decision;
  policy: PolicyResult;
  review: ReviewOutcome | null;
  /** Present when a charge was attempted: COMPLETED, FAILED, or still CREATED when PayPal never confirmed the outcome (D16). */
  payment: Payment | null;
}

/** A request submitted again under the intent id of one already made: that request as it stands, nothing new decided (D17). */
export interface ReplayResult {
  replayed: true;
  request: PurchaseRequest;
  /** null while the first submission is still being decided. */
  decision: Decision | null;
  payment: Payment | null;
}

export type SubmitResult = GuardResult | ReplayResult;

export class Guard {
  private readonly repo: Repo;
  private readonly reviewer: Reviewer;
  private readonly reviewTimeoutMs: number;
  private readonly executor: PayPalExecutor | undefined;
  private readonly now: () => number;

  constructor(deps: GuardDeps) {
    this.repo = deps.repo;
    this.reviewer = deps.reviewer ?? passthroughReviewer;
    this.reviewTimeoutMs = deps.reviewTimeoutMs ?? 8_000;
    this.executor = deps.executor;
    this.now = deps.now ?? Date.now;
  }

  /**
   * What the MCP tool calls: records the request, decides it and (with an executor) charges it when auto-approved.
   * With an intent id the agent already used, nothing new is made: the request it names comes back as it stands
   * (`replayed: true`), or, when the repeat describes a different purchase, an IntentConflictError (D17). Without an
   * intent id the result is always a fresh decision.
   */
  submit(input: NewRequest & { intentId?: null | undefined }, actor?: string): Promise<GuardResult>;
  submit(input: NewRequest, actor?: string): Promise<SubmitResult>;
  async submit(input: NewRequest, actor: string = `agent:${input.agentId}`): Promise<SubmitResult> {
    const intentId = input.intentId ?? null;
    if (intentId !== null) {
      // Lookup and insert are both synchronous: within this process nothing can slip in between them.
      const existing = this.repo.requestByIntent(input.agentId, intentId);
      if (existing) {
        const differences = intentDifferences(existing, input);
        if (differences.length > 0) {
          this.repo.appendAudit({ actor, action: 'request.intent_conflict', requestId: existing.id, agentId: existing.agentId, details: { intentId, differences } });
          throw new IntentConflictError(existing, differences);
        }
        this.repo.appendAudit({ actor, action: 'request.replayed', requestId: existing.id, agentId: existing.agentId, details: { intentId } });
        return { replayed: true, request: existing, decision: this.repo.latestDecision(existing.id) ?? null, payment: this.repo.paymentForRequest(existing.id) ?? null };
      }
    }
    const request = this.repo.createRequest(input);
    this.repo.appendAudit({
      actor,
      action: 'request.created',
      requestId: request.id,
      agentId: request.agentId,
      details: { merchant: request.merchant, item: request.item, category: request.category, amountMinor: request.amountMinor, currency: request.currency, ...(intentId === null ? {} : { intentId }) },
    });
    return this.decide(request.id);
  }

  /** Decides an EVALUATING request. */
  async decide(requestId: string): Promise<GuardResult> {
    return this.decideWith(requestId, this.reviewer);
  }

  /**
   * Called once at start-up. Requests the previous process left EVALUATING (it died or was stopped during a review)
   * are decided now, oldest first, with the rules of this moment and a reviewer that reports the interruption: each
   * ends HELD for the owner (BLOCKED when the rules say so), nothing is charged, and none keeps counting as an older
   * sibling in the budget of the requests that follow (D17).
   */
  async recoverInterrupted(actor: string = 'system'): Promise<GuardResult[]> {
    const results: GuardResult[] = [];
    for (const request of this.repo.evaluatingRequests()) {
      this.repo.appendAudit({ actor, action: 'request.recovered', requestId: request.id, agentId: request.agentId, details: { reason: 'the guard restarted while this request was under review' } });
      results.push(await this.decideWith(request.id, interruptedReviewer));
    }
    return results;
  }

  /** The rules, budget and clock as they stand right now, for this request. */
  private evaluate(request: PurchaseRequest): PolicyResult {
    return evaluatePolicy({
      agent: this.repo.getAgent(request.agentId),
      policy: this.repo.getPolicy(request.agentId),
      request,
      context: this.repo.policyContext(request.agentId, this.now(), request.id),
    });
  }

  private async decideWith(requestId: string, reviewer: Reviewer): Promise<GuardResult> {
    const request = this.repo.getRequest(requestId);
    if (!request) throw new Error(`unknown request "${requestId}"`);
    if (request.status !== 'EVALUATING') throw new Error(`request "${requestId}" is ${request.status}; it was already decided`);

    // Rules, budget and clock are read fresh each time this runs: once now, once more after the reviewer.
    const evaluateNow = (): PolicyResult => this.evaluate(request);
    const policy = this.repo.getPolicy(request.agentId);
    let policyResult = evaluateNow();
    let policyFinal = finalFromVerdict(policyResult.verdict);

    let review: ReviewOutcome | null = null;
    let reviewFailure: string | undefined;
    let reviewerSays: FinalDecision = 'AUTO_APPROVE'; // adds nothing when the reviewer does not run (BLOCK)
    if (policyResult.verdict !== 'BLOCK') {
      try {
        review = await this.runReviewer(reviewer, { request, policy, policyVerdict: policyResult.verdict, policyReasons: policyResult.reasons, budget: policyResult.budget });
        reviewerSays = review.recommendation;
      } catch (err) {
        // Short and secret-free: this text reaches the dashboard, the audit log and the agent.
        reviewFailure = clampText(err instanceof Error ? err.message : String(err), 300);
        reviewerSays = 'HOLD';
      }
      // The review took time. A rule the owner tightened meanwhile, a sibling request decided first, or the allowed
      // hours ending all count: evaluate again and keep the tighter policy verdict, never the looser one (D9, D16).
      const again = evaluateNow();
      const againFinal = finalFromVerdict(again.verdict);
      if (RANK[againFinal] >= RANK[policyFinal]) {
        policyResult = again;
        policyFinal = againFinal;
      }
    }
    const final = tighter(policyFinal, reviewerSays);

    const decision = this.repo.transaction(() => {
      const recorded = this.repo.recordDecision({
        requestId,
        policyVerdict: policyResult.verdict,
        policyReasons: policyResult.reasons,
        reviewRisk: review?.risk ?? null,
        reviewFlags: review?.flags ?? (reviewFailure !== undefined ? ['REVIEWER_UNAVAILABLE'] : []),
        reviewExplanation: review?.explanation ?? (reviewFailure !== undefined ? `AI review failed, holding for the owner: ${reviewFailure}` : null),
        finalDecision: final,
        decidedBy: final === policyFinal ? 'policy' : 'reviewer',
      });
      this.repo.setRequestStatus(requestId, STATUS_FOR[final]);
      this.repo.appendAudit({
        actor: 'system',
        action: 'request.decided',
        requestId,
        agentId: request.agentId,
        details: {
          finalDecision: final,
          policyVerdict: policyResult.verdict,
          reasons: policyResult.reasons.map((r) => r.code),
          reviewRisk: recorded.reviewRisk,
          reviewFlags: recorded.reviewFlags,
          decidedBy: recorded.decidedBy,
        },
      });
      return recorded;
    });

    let payment: Payment | null = null;
    if (final === 'AUTO_APPROVE' && this.executor) payment = await this.executor.charge(requestId);
    return { replayed: false, request: this.requireRequest(requestId), decision, policy: policyResult, review, payment };
  }

  /**
   * The owner approves a HELD request; with an executor it is charged right away. The rules run once more first: the
   * soft ones (cap, budget, merchant, category, hours) are the owner's to override, which is what a hold is for, but a
   * BLOCK-level fact that appeared since the hold (the agent disabled, the hard ceiling lowered below the amount, the
   * policy gone) refuses the approval, and the request stays HELD for the owner to fix the rule or deny it (D17).
   */
  async approve(requestId: string, actor: string = 'owner'): Promise<{ request: PurchaseRequest; payment: Payment | null }> {
    const refused = this.repo.transaction(() => {
      const request = this.requireRequest(requestId);
      if (request.status !== 'HELD') throw new Error(`request "${requestId}" is ${request.status}, not HELD`);
      const hard = this.evaluate(request).reasons.filter((r) => severityOf(r.code) === 'BLOCK');
      if (hard.length > 0) return { request, hard };
      this.repo.setRequestStatus(requestId, 'APPROVED');
      this.repo.appendAudit({ actor, action: 'owner.approved', requestId, agentId: request.agentId, details: {} });
      return undefined;
    });
    if (refused) {
      // Written outside the transaction above, so the refusal stays on record.
      this.repo.appendAudit({ actor, action: 'owner.approve_refused', requestId, agentId: refused.request.agentId, details: { reasons: refused.hard.map((r) => r.code) } });
      throw new ApprovalRefusedError(refused.hard);
    }
    const payment = this.executor ? await this.executor.charge(requestId) : null;
    return { request: this.requireRequest(requestId), payment };
  }

  /**
   * The owner retries a charge PayPal never confirmed: the payment is still CREATED and the request still approved
   * (D16). The executor looks the recorded order up, or repeats the create under the same idempotency key, so a retry
   * cannot charge twice (D8).
   */
  async retryCharge(requestId: string, actor: string = 'owner'): Promise<Payment> {
    if (!this.executor) throw new Error('retrying a payment needs PayPal credentials (the guard runs keyless)');
    const request = this.requireRequest(requestId);
    if (request.status !== 'AUTO_APPROVED' && request.status !== 'APPROVED') {
      throw new Error(`request "${requestId}" is ${request.status}; only an approved request with an unsettled payment can be retried`);
    }
    this.repo.appendAudit({ actor, action: 'payment.retried', requestId, agentId: request.agentId, details: {} });
    return this.executor.charge(requestId);
  }

  /** The owner denies a HELD request. */
  deny(requestId: string, actor: string = 'owner', note?: string): PurchaseRequest {
    this.transition(requestId, 'HELD', 'DENIED', actor, 'owner.denied', note === undefined ? {} : { note });
    return this.requireRequest(requestId);
  }

  private transition(requestId: string, from: RequestStatus, to: RequestStatus, actor: string, action: string, details: Record<string, unknown> = {}): void {
    this.repo.transaction(() => {
      const request = this.requireRequest(requestId);
      if (request.status !== from) throw new Error(`request "${requestId}" is ${request.status}, not ${from}`);
      this.repo.setRequestStatus(requestId, to);
      this.repo.appendAudit({ actor, action, requestId, agentId: request.agentId, details });
    });
  }

  private requireRequest(id: string): PurchaseRequest {
    const request = this.repo.getRequest(id);
    if (!request) throw new Error(`unknown request "${id}"`);
    return request;
  }

  private async runReviewer(reviewer: Reviewer, input: ReviewInput): Promise<ReviewOutcome> {
    const ac = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort();
        reject(new Error(`reviewer timed out after ${this.reviewTimeoutMs} ms`));
      }, this.reviewTimeoutMs);
    });
    try {
      return await Promise.race([reviewer(input, ac.signal), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * The guard's decision pipeline for one purchase request:
 *
 *   request -> deterministic policy (engine) -> AI reviewer (may only tighten) -> decision row + status -> charge if AUTO_APPROVE
 *
 * Composition rules (DECISIONS D9): ALLOW -> AUTO_APPROVE, HOLD -> HOLD, BLOCK -> BLOCK; the reviewer can move a
 * decision only to the right (AUTO_APPROVE -> HOLD -> BLOCK); a reviewer failure or timeout means HOLD.
 * The reviewer is a plug-in: M1 ships a passthrough, M3 adds the LLM-backed one.
 */
import type { NewRequest, Repo } from '../db/repo.js';
import type { Decision, FinalDecision, Payment, Policy, PolicyReason, PurchaseRequest, RequestStatus, ReviewRisk } from '../domain/types.js';
import { type BudgetSnapshot, evaluatePolicy, type PolicyResult } from '../policy/engine.js';
import type { PolicyVerdict } from '../policy/reasons.js';
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

/** Default reviewer: no AI, never tightens. Keeps the pipeline runnable without any key (D4). */
export const passthroughReviewer: Reviewer = async () => ({
  risk: 'low',
  flags: [],
  explanation: 'No AI review performed (mock reviewer).',
  recommendation: 'AUTO_APPROVE',
});

const RANK: Record<FinalDecision, number> = { AUTO_APPROVE: 0, HOLD: 1, BLOCK: 2 };
const STATUS_FOR: Record<FinalDecision, RequestStatus> = { AUTO_APPROVE: 'AUTO_APPROVED', HOLD: 'HELD', BLOCK: 'BLOCKED' };

/** The tighter of two decisions. */
export const tighter = (a: FinalDecision, b: FinalDecision): FinalDecision => (RANK[a] >= RANK[b] ? a : b);

export const finalFromVerdict = (verdict: PolicyVerdict): FinalDecision => (verdict === 'ALLOW' ? 'AUTO_APPROVE' : verdict === 'HOLD' ? 'HOLD' : 'BLOCK');

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
  request: PurchaseRequest;
  decision: Decision;
  policy: PolicyResult;
  review: ReviewOutcome | null;
  /** Present when the request was charged (COMPLETED or FAILED). */
  payment: Payment | null;
}

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

  /** What the MCP tool calls: records the request, decides it and (with an executor) charges it when auto-approved. */
  async submit(input: NewRequest, actor: string = `agent:${input.agentId}`): Promise<GuardResult> {
    const request = this.repo.createRequest(input);
    this.repo.appendAudit({
      actor,
      action: 'request.created',
      requestId: request.id,
      agentId: request.agentId,
      details: { merchant: request.merchant, item: request.item, category: request.category, amountMinor: request.amountMinor, currency: request.currency },
    });
    return this.decide(request.id);
  }

  /** Decides an EVALUATING request. */
  async decide(requestId: string): Promise<GuardResult> {
    const request = this.repo.getRequest(requestId);
    if (!request) throw new Error(`unknown request "${requestId}"`);
    if (request.status !== 'EVALUATING') throw new Error(`request "${requestId}" is ${request.status}; it was already decided`);

    const agent = this.repo.getAgent(request.agentId);
    const policy = this.repo.getPolicy(request.agentId);
    const context = this.repo.policyContext(request.agentId, this.now());
    const policyResult = evaluatePolicy({ agent, policy, request, context });
    const policyFinal = finalFromVerdict(policyResult.verdict);

    let final = policyFinal;
    let review: ReviewOutcome | null = null;
    let reviewFailure: string | undefined;
    if (policyResult.verdict !== 'BLOCK') {
      try {
        review = await this.runReviewer({ request, policy, policyVerdict: policyResult.verdict, policyReasons: policyResult.reasons, budget: policyResult.budget });
        final = tighter(policyFinal, review.recommendation);
      } catch (err) {
        reviewFailure = err instanceof Error ? err.message : String(err);
        final = tighter(policyFinal, 'HOLD');
      }
    }

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
    return { request: this.requireRequest(requestId), decision, policy: policyResult, review, payment };
  }

  /** The owner approves a HELD request; with an executor it is charged right away. */
  async approve(requestId: string, actor: string = 'owner'): Promise<{ request: PurchaseRequest; payment: Payment | null }> {
    this.transition(requestId, 'HELD', 'APPROVED', actor, 'owner.approved');
    const payment = this.executor ? await this.executor.charge(requestId) : null;
    return { request: this.requireRequest(requestId), payment };
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

  private async runReviewer(input: ReviewInput): Promise<ReviewOutcome> {
    const ac = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort();
        reject(new Error(`reviewer timed out after ${this.reviewTimeoutMs} ms`));
      }, this.reviewTimeoutMs);
    });
    try {
      return await Promise.race([this.reviewer(input, ac.signal), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

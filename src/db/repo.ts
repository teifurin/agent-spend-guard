import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { normalizeName, normalizeNames } from '../domain/normalize.js';
import type {
  Agent,
  AgentStatus,
  AuditEntry,
  Decision,
  FinalDecision,
  Mandate,
  Payment,
  PaymentStatus,
  Policy,
  PolicyReason,
  PurchaseRequest,
  RequestStatus,
  ReviewRisk,
} from '../domain/types.js';
import type { PolicyContext } from '../policy/engine.js';
import type { PolicyVerdict } from '../policy/reasons.js';
import { monthBounds } from '../policy/time.js';
import { validatePolicy } from '../policy/validate.js';

type Row = Record<string, unknown>;

export interface NewAgent {
  id: string;
  name: string;
  status?: AgentStatus;
}

export interface NewRequest {
  agentId: string;
  merchant: string;
  item: string;
  category: string;
  amountMinor: number;
  currency: string;
  reason: string;
  sourceUrl?: string | null;
  /** Caller-chosen idempotency key, unique per agent (D17). */
  intentId?: string | null;
}

export interface NewDecision {
  requestId: string;
  policyVerdict: PolicyVerdict;
  policyReasons: PolicyReason[];
  reviewRisk?: ReviewRisk | null;
  reviewFlags?: string[];
  reviewExplanation?: string | null;
  finalDecision: FinalDecision;
  decidedBy: 'policy' | 'reviewer';
}

export interface NewPayment {
  requestId: string;
  agentId: string;
  amountMinor: number;
  currency: string;
  paypalOrderId?: string | null;
}

export type PaymentPatch = Partial<Pick<Payment, 'paypalOrderId' | 'paypalCaptureId' | 'paypalRefundId' | 'status' | 'capturedAt'>>;

export interface NewAuditEntry {
  actor: string;
  action: string;
  requestId?: string | null;
  agentId?: string | null;
  details?: Record<string, unknown>;
}

export interface RequestFilter {
  agentId?: string;
  /** Normalized merchant name, as stored in merchant_key. */
  merchantKey?: string;
  /** Any of these statuses; combined with `status` by AND if both are given. */
  statuses?: readonly RequestStatus[];
  status?: RequestStatus;
  limit?: number;
}

export interface NewMandate {
  paypalVaultId: string;
  paypalCustomerId?: string | null;
}

/** PayPal object ids known when a charge settles or fails. Never tokens. */
export interface PaymentOutcome {
  paypalOrderId?: string | null;
  paypalCaptureId?: string | null;
}

/** Amount is committed but not yet captured: counts against the budget (DECISIONS D10). */
const IN_FLIGHT_SQL = `('AUTO_APPROVED', 'APPROVED')`;
/** A merchant is "known" to an agent once a request to it was paid, refunded later or not. */
const PAID_SQL = `('PAID', 'REFUNDED')`;
/** Captures that count as spent: completed, or with a refund PayPal has not completed yet (D17). */
const SPENT_SQL = `('COMPLETED', 'REFUND_PENDING')`;

const newId = (prefix: string): string => `${prefix}_${randomBytes(6).toString('hex')}`;
const str = (v: unknown): string => String(v);
const num = (v: unknown): number => Number(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const jsonOr = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string') return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

/** Thin, synchronous data-access layer over node:sqlite. Every method maps rows to domain objects. */
export class Repo {
  constructor(
    readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  /** Runs fn inside BEGIN/COMMIT; rolls back and rethrows on error. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---------------------------------------------------------------- agents

  createAgent(input: NewAgent): Agent {
    const agent: Agent = { id: input.id, name: input.name, status: input.status ?? 'active', createdAt: this.now() };
    this.db.prepare('INSERT INTO agents (id, name, status, created_at) VALUES (?, ?, ?, ?)').run(agent.id, agent.name, agent.status, agent.createdAt);
    return agent;
  }

  getAgent(id: string): Agent | undefined {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
    return row ? toAgent(row) : undefined;
  }

  listAgents(): Agent[] {
    return this.db.prepare('SELECT * FROM agents ORDER BY created_at, id').all().map(toAgent);
  }

  setAgentStatus(id: string, status: AgentStatus): void {
    const result = this.db.prepare('UPDATE agents SET status = ? WHERE id = ?').run(status, id);
    if (result.changes === 0) throw new Error(`unknown agent "${id}"`);
  }

  // -------------------------------------------------------------- policies

  /** Validates, normalizes allowlists and upserts the agent's policy. */
  savePolicy(input: Omit<Policy, 'updatedAt'>): Policy {
    const problems = validatePolicy(input);
    if (problems.length > 0) throw new Error(`invalid policy: ${problems.join('; ')}`);
    const policy: Policy = {
      ...input,
      merchantAllowlist: input.merchantAllowlist === null ? null : normalizeNames(input.merchantAllowlist),
      categoryAllowlist: input.categoryAllowlist === null ? null : normalizeNames(input.categoryAllowlist),
      updatedAt: this.now(),
    };
    this.db
      .prepare(
        `INSERT INTO policies (agent_id, currency, max_tx_minor, hard_max_tx_minor, monthly_budget_minor, merchant_allowlist,
           category_allowlist, hours_start, hours_end, timezone, hold_new_merchants, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           currency = excluded.currency, max_tx_minor = excluded.max_tx_minor, hard_max_tx_minor = excluded.hard_max_tx_minor,
           monthly_budget_minor = excluded.monthly_budget_minor, merchant_allowlist = excluded.merchant_allowlist,
           category_allowlist = excluded.category_allowlist, hours_start = excluded.hours_start, hours_end = excluded.hours_end,
           timezone = excluded.timezone, hold_new_merchants = excluded.hold_new_merchants, updated_at = excluded.updated_at`,
      )
      .run(
        policy.agentId,
        policy.currency,
        policy.maxTxMinor,
        policy.hardMaxTxMinor,
        policy.monthlyBudgetMinor,
        policy.merchantAllowlist === null ? null : JSON.stringify(policy.merchantAllowlist),
        policy.categoryAllowlist === null ? null : JSON.stringify(policy.categoryAllowlist),
        policy.hours?.start ?? null,
        policy.hours?.end ?? null,
        policy.timezone,
        policy.holdNewMerchants ? 1 : 0,
        policy.updatedAt,
      );
    return policy;
  }

  getPolicy(agentId: string): Policy | undefined {
    const row = this.db.prepare('SELECT * FROM policies WHERE agent_id = ?').get(agentId);
    return row ? toPolicy(row) : undefined;
  }

  // -------------------------------------------------------------- requests

  createRequest(input: NewRequest): PurchaseRequest {
    const ts = this.now();
    const request: PurchaseRequest = {
      id: newId('req'),
      agentId: input.agentId,
      merchant: input.merchant,
      merchantKey: normalizeName(input.merchant),
      item: input.item,
      category: input.category,
      amountMinor: input.amountMinor,
      currency: input.currency,
      reason: input.reason,
      sourceUrl: input.sourceUrl ?? null,
      intentId: input.intentId ?? null,
      status: 'EVALUATING',
      createdAt: ts,
      updatedAt: ts,
    };
    this.db
      .prepare(
        `INSERT INTO requests (id, agent_id, merchant, merchant_key, item, category, amount_minor, currency, reason, source_url, intent_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        request.id,
        request.agentId,
        request.merchant,
        request.merchantKey,
        request.item,
        request.category,
        request.amountMinor,
        request.currency,
        request.reason,
        request.sourceUrl,
        request.intentId,
        request.status,
        request.createdAt,
        request.updatedAt,
      );
    return request;
  }

  getRequest(id: string): PurchaseRequest | undefined {
    const row = this.db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
    return row ? toRequest(row) : undefined;
  }

  /** The request this agent already made under this intent id, if any (D17). */
  requestByIntent(agentId: string, intentId: string): PurchaseRequest | undefined {
    const row = this.db.prepare('SELECT * FROM requests WHERE agent_id = ? AND intent_id = ?').get(agentId, intentId);
    return row ? toRequest(row) : undefined;
  }

  /** Requests still EVALUATING, oldest first: after a restart, the ones the previous process never finished deciding (D17). */
  evaluatingRequests(): PurchaseRequest[] {
    return this.db
      .prepare(`SELECT * FROM requests WHERE status = 'EVALUATING' ORDER BY rowid ASC`)
      .all()
      .map((row) => toRequest(row as Row));
  }

  setRequestStatus(id: string, status: RequestStatus): PurchaseRequest {
    const result = this.db.prepare('UPDATE requests SET status = ?, updated_at = ? WHERE id = ?').run(status, this.now(), id);
    if (result.changes === 0) throw new Error(`unknown request "${id}"`);
    const updated = this.getRequest(id);
    if (!updated) throw new Error(`request "${id}" vanished`);
    return updated;
  }

  /** Newest first. */
  listRequests(filter: RequestFilter = {}): PurchaseRequest[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter.agentId !== undefined) {
      where.push('agent_id = ?');
      params.push(filter.agentId);
    }
    if (filter.status !== undefined) {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.merchantKey !== undefined) {
      where.push('merchant_key = ?');
      params.push(filter.merchantKey);
    }
    if (filter.statuses !== undefined) {
      if (filter.statuses.length === 0) return [];
      where.push(`status IN (${filter.statuses.map(() => '?').join(', ')})`);
      params.push(...filter.statuses);
    }
    params.push(filter.limit ?? 100);
    const sql = `SELECT * FROM requests ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`;
    return this.db
      .prepare(sql)
      .all(...params)
      .map(toRequest);
  }

  // ------------------------------------------------------------- decisions

  recordDecision(input: NewDecision): Decision {
    const decidedAt = this.now();
    const result = this.db
      .prepare(
        `INSERT INTO decisions (request_id, policy_verdict, policy_reasons, review_risk, review_flags, review_explanation, final_decision, decided_by, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.requestId,
        input.policyVerdict,
        JSON.stringify(input.policyReasons),
        input.reviewRisk ?? null,
        JSON.stringify(input.reviewFlags ?? []),
        input.reviewExplanation ?? null,
        input.finalDecision,
        input.decidedBy,
        decidedAt,
      );
    return {
      id: Number(result.lastInsertRowid),
      requestId: input.requestId,
      policyVerdict: input.policyVerdict,
      policyReasons: input.policyReasons,
      reviewRisk: input.reviewRisk ?? null,
      reviewFlags: input.reviewFlags ?? [],
      reviewExplanation: input.reviewExplanation ?? null,
      finalDecision: input.finalDecision,
      decidedBy: input.decidedBy,
      decidedAt,
    };
  }

  latestDecision(requestId: string): Decision | undefined {
    const row = this.db.prepare('SELECT * FROM decisions WHERE request_id = ? ORDER BY id DESC LIMIT 1').get(requestId);
    return row ? toDecision(row) : undefined;
  }

  // -------------------------------------------------------------- payments

  createPayment(input: NewPayment): Payment {
    const ts = this.now();
    const payment: Payment = {
      id: newId('pay'),
      requestId: input.requestId,
      agentId: input.agentId,
      paypalOrderId: input.paypalOrderId ?? null,
      paypalCaptureId: null,
      paypalRefundId: null,
      amountMinor: input.amountMinor,
      currency: input.currency,
      status: 'CREATED',
      capturedAt: null,
      createdAt: ts,
      updatedAt: ts,
    };
    this.db
      .prepare(
        `INSERT INTO payments (id, request_id, agent_id, paypal_order_id, paypal_capture_id, paypal_refund_id, amount_minor, currency, status, captured_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        payment.id,
        payment.requestId,
        payment.agentId,
        payment.paypalOrderId,
        payment.paypalCaptureId,
        payment.paypalRefundId,
        payment.amountMinor,
        payment.currency,
        payment.status,
        payment.capturedAt,
        payment.createdAt,
        payment.updatedAt,
      );
    return payment;
  }

  updatePayment(id: string, patch: PaymentPatch): Payment {
    const columns: Record<keyof PaymentPatch, string> = {
      paypalOrderId: 'paypal_order_id',
      paypalCaptureId: 'paypal_capture_id',
      paypalRefundId: 'paypal_refund_id',
      status: 'status',
      capturedAt: 'captured_at',
    };
    const sets: string[] = [];
    const params: Array<string | number | null> = [];
    for (const key of Object.keys(columns) as Array<keyof PaymentPatch>) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${columns[key]} = ?`);
      params.push(value);
    }
    sets.push('updated_at = ?');
    params.push(this.now(), id);
    const result = this.db.prepare(`UPDATE payments SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    if (result.changes === 0) throw new Error(`unknown payment "${id}"`);
    const updated = this.getPayment(id);
    if (!updated) throw new Error(`payment "${id}" vanished`);
    return updated;
  }

  getPayment(id: string): Payment | undefined {
    const row = this.db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
    return row ? toPayment(row) : undefined;
  }

  paymentForRequest(requestId: string): Payment | undefined {
    const row = this.db.prepare('SELECT * FROM payments WHERE request_id = ?').get(requestId);
    return row ? toPayment(row) : undefined;
  }

  // -------------------------------------------------------------- mandates

  /** Stores the owner's one-time PayPal authorization and makes it the only active one. The vault id is never logged. */
  saveMandate(input: NewMandate): Mandate {
    const mandate: Mandate = {
      id: newId('mnd'),
      paypalVaultId: input.paypalVaultId,
      paypalCustomerId: input.paypalCustomerId ?? null,
      status: 'active',
      createdAt: this.now(),
    };
    this.transaction(() => {
      this.db.prepare(`UPDATE mandates SET status = 'revoked' WHERE status = 'active'`).run();
      this.db
        .prepare('INSERT INTO mandates (id, paypal_vault_id, paypal_customer_id, status, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(mandate.id, mandate.paypalVaultId, mandate.paypalCustomerId, mandate.status, mandate.createdAt);
    });
    return mandate;
  }

  activeMandate(): Mandate | undefined {
    const row = this.db.prepare(`SELECT * FROM mandates WHERE status = 'active' ORDER BY created_at DESC, rowid DESC LIMIT 1`).get();
    return row ? toMandate(row) : undefined;
  }

  revokeMandate(id: string): void {
    const result = this.db.prepare(`UPDATE mandates SET status = 'revoked' WHERE id = ?`).run(id);
    if (result.changes === 0) throw new Error(`unknown mandate "${id}"`);
  }

  /** Newest first. */
  listMandates(): Mandate[] {
    return this.db.prepare('SELECT * FROM mandates ORDER BY created_at DESC, rowid DESC').all().map(toMandate);
  }

  // ------------------------------------------ payment state changes (D10)
  // Each of these changes the request status and its payment row in ONE transaction, so a request is never
  // counted both as in flight and as captured. They must not be called from inside another transaction.

  /**
   * Opens the payment for an approved request, or returns the payment that already exists (re-entry after a crash).
   * The request must be AUTO_APPROVED or APPROVED.
   */
  beginPayment(requestId: string): Payment {
    return this.transaction(() => {
      const request = this.getRequest(requestId);
      if (!request) throw new Error(`unknown request "${requestId}"`);
      const existing = this.paymentForRequest(requestId);
      if (existing) return existing;
      if (request.status !== 'AUTO_APPROVED' && request.status !== 'APPROVED') {
        throw new Error(`request "${requestId}" is ${request.status}; only AUTO_APPROVED or APPROVED requests can be charged`);
      }
      return this.createPayment({ requestId, agentId: request.agentId, amountMinor: request.amountMinor, currency: request.currency });
    });
  }

  /** The capture succeeded: payment COMPLETED and request PAID. Calling it twice is harmless. */
  settlePayment(paymentId: string, outcome: { paypalOrderId: string; paypalCaptureId: string; capturedAt: number }): Payment {
    return this.transaction(() => {
      const payment = this.requirePayment(paymentId);
      if (payment.status === 'COMPLETED') return payment;
      if (payment.status !== 'CREATED') throw new Error(`payment "${paymentId}" is ${payment.status}; only CREATED payments can settle`);
      const updated = this.updatePayment(paymentId, { ...outcome, status: 'COMPLETED' });
      this.setRequestStatus(payment.requestId, 'PAID');
      return updated;
    });
  }

  /** The charge did not happen: payment FAILED and request PAYMENT_FAILED. Nothing counts against the budget any more. */
  failPayment(paymentId: string, outcome: PaymentOutcome = {}): Payment {
    return this.transaction(() => {
      const payment = this.requirePayment(paymentId);
      if (payment.status !== 'CREATED') throw new Error(`payment "${paymentId}" is ${payment.status}; only CREATED payments can fail`);
      const updated = this.updatePayment(paymentId, { ...outcome, status: 'FAILED' });
      this.setRequestStatus(payment.requestId, 'PAYMENT_FAILED');
      return updated;
    });
  }

  /** The capture was refunded: payment REFUNDED and request REFUNDED, which gives the budget back. */
  refundPayment(paymentId: string, paypalRefundId: string): Payment {
    return this.transaction(() => {
      const payment = this.requirePayment(paymentId);
      if (payment.status !== 'COMPLETED' && payment.status !== 'REFUND_PENDING') {
        throw new Error(`payment "${paymentId}" is ${payment.status}; only COMPLETED or REFUND_PENDING payments can be refunded`);
      }
      const updated = this.updatePayment(paymentId, { paypalRefundId, status: 'REFUNDED' });
      this.setRequestStatus(payment.requestId, 'REFUNDED');
      return updated;
    });
  }

  /**
   * PayPal accepted the refund but answered PENDING: the payment is REFUND_PENDING and keeps counting against the
   * budget; the request stays PAID until PayPal completes the refund (D17).
   */
  markRefundPending(paymentId: string, paypalRefundId: string): Payment {
    return this.transaction(() => {
      const payment = this.requirePayment(paymentId);
      if (payment.status === 'REFUND_PENDING' && payment.paypalRefundId === paypalRefundId) return payment;
      if (payment.status !== 'COMPLETED') throw new Error(`payment "${paymentId}" is ${payment.status}; only COMPLETED payments can have a pending refund`);
      return this.updatePayment(paymentId, { paypalRefundId, status: 'REFUND_PENDING' });
    });
  }

  /** PayPal cancelled or failed a pending refund: the capture stands again, COMPLETED, and can be refunded anew (D17). */
  cancelPendingRefund(paymentId: string): Payment {
    return this.transaction(() => {
      const payment = this.requirePayment(paymentId);
      if (payment.status !== 'REFUND_PENDING') throw new Error(`payment "${paymentId}" is ${payment.status}; only a REFUND_PENDING payment can lose its refund`);
      return this.updatePayment(paymentId, { paypalRefundId: null, status: 'COMPLETED' });
    });
  }

  private requirePayment(id: string): Payment {
    const payment = this.getPayment(id);
    if (!payment) throw new Error(`unknown payment "${id}"`);
    return payment;
  }

  // ----------------------------------------------------- budget and history

  /**
   * Spend that counts against the agent's budget for the month containing nowMs in the given zone:
   * completed captures in that month plus approved requests not yet captured. Refunded captures do not count; a
   * capture whose refund PayPal has not completed yet (REFUND_PENDING) still does (D17).
   *
   * While a request is being decided (`deciding` = its id), the agent's older requests that are still EVALUATING count
   * too, first come first served: of two requests submitted at the same moment, the older one sees a free budget and
   * the newer one sees the older one's amount, so they cannot both pass a budget that fits only one (D16).
   */
  spentThisMonthMinor(agentId: string, nowMs: number, timezone: string, deciding?: string): number {
    const { startMs, endMs } = monthBounds(nowMs, timezone);
    const captured = this.db
      .prepare(`SELECT COALESCE(SUM(amount_minor), 0) AS total FROM payments WHERE agent_id = ? AND status IN ${SPENT_SQL} AND captured_at >= ? AND captured_at < ?`)
      .get(agentId, startMs, endMs);
    const inFlight = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_minor), 0) AS total FROM requests
         WHERE agent_id = ? AND (status IN ${IN_FLIGHT_SQL}
           OR (status = 'EVALUATING' AND rowid < COALESCE((SELECT rowid FROM requests WHERE id = ?), 0)))`,
      )
      .get(agentId, deciding ?? '');
    return num(captured?.['total'] ?? 0) + num(inFlight?.['total'] ?? 0);
  }

  /** Approved requests whose charge stopped without a known outcome: payment still CREATED, amount still counted (D16). */
  unsettledRequests(): PurchaseRequest[] {
    return this.db
      .prepare(
        `SELECT r.* FROM requests r JOIN payments p ON p.request_id = r.id
         WHERE p.status = 'CREATED' AND r.status IN ${IN_FLIGHT_SQL} ORDER BY r.created_at ASC, r.id ASC`,
      )
      .all()
      .map((row) => toRequest(row as Row));
  }

  /** Paid requests whose refund PayPal accepted but has not completed: payment REFUND_PENDING, amount still counted (D17). */
  refundPendingRequests(): PurchaseRequest[] {
    return this.db
      .prepare(
        `SELECT r.* FROM requests r JOIN payments p ON p.request_id = r.id
         WHERE p.status = 'REFUND_PENDING' ORDER BY r.created_at ASC, r.id ASC`,
      )
      .all()
      .map((row) => toRequest(row as Row));
  }

  /** Normalized merchant names this agent has paid before, sorted. */
  knownMerchants(agentId: string): string[] {
    return this.db
      .prepare(`SELECT DISTINCT merchant_key FROM requests WHERE agent_id = ? AND status IN ${PAID_SQL} ORDER BY merchant_key`)
      .all(agentId)
      .map((row) => str(row['merchant_key']));
  }

  /**
   * Everything the policy engine needs besides the policy itself. Uses the policy's zone (UTC when there is none).
   * `deciding` is the id of the request being decided, so that its older siblings still under evaluation count (see spentThisMonthMinor).
   */
  policyContext(agentId: string, nowMs: number = this.now(), deciding?: string): PolicyContext {
    const timezone = this.getPolicy(agentId)?.timezone ?? 'UTC';
    return { nowMs, spentThisMonthMinor: this.spentThisMonthMinor(agentId, nowMs, timezone, deciding), knownMerchants: this.knownMerchants(agentId) };
  }

  // ----------------------------------------------------------------- audit

  appendAudit(entry: NewAuditEntry): AuditEntry {
    const ts = this.now();
    const details = entry.details ?? {};
    const result = this.db
      .prepare('INSERT INTO audit_log (ts, actor, action, request_id, agent_id, details) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ts, entry.actor, entry.action, entry.requestId ?? null, entry.agentId ?? null, JSON.stringify(details));
    return { id: Number(result.lastInsertRowid), ts, actor: entry.actor, action: entry.action, requestId: entry.requestId ?? null, agentId: entry.agentId ?? null, details };
  }

  /** How many times `action` was logged for a request. */
  countAudit(requestId: string, action: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE request_id = ? AND action = ?').get(requestId, action);
    return num(row?.['n'] ?? 0);
  }

  /** Newest first. */
  listAudit(filter: { requestId?: string; limit?: number } = {}): AuditEntry[] {
    const rows =
      filter.requestId === undefined
        ? this.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(filter.limit ?? 100)
        : this.db.prepare('SELECT * FROM audit_log WHERE request_id = ? ORDER BY id DESC LIMIT ?').all(filter.requestId, filter.limit ?? 100);
    return rows.map(toAudit);
  }
}

// ------------------------------------------------------------- row mappers

function toAgent(row: Row): Agent {
  return { id: str(row['id']), name: str(row['name']), status: str(row['status']) as AgentStatus, createdAt: num(row['created_at']) };
}

function toPolicy(row: Row): Policy {
  const start = strOrNull(row['hours_start']);
  const end = strOrNull(row['hours_end']);
  return {
    agentId: str(row['agent_id']),
    currency: str(row['currency']),
    maxTxMinor: num(row['max_tx_minor']),
    hardMaxTxMinor: numOrNull(row['hard_max_tx_minor']),
    monthlyBudgetMinor: num(row['monthly_budget_minor']),
    merchantAllowlist: row['merchant_allowlist'] === null ? null : jsonOr<string[]>(row['merchant_allowlist'], []),
    categoryAllowlist: row['category_allowlist'] === null ? null : jsonOr<string[]>(row['category_allowlist'], []),
    hours: start !== null && end !== null ? { start, end } : null,
    timezone: str(row['timezone']),
    holdNewMerchants: num(row['hold_new_merchants']) === 1,
    updatedAt: num(row['updated_at']),
  };
}

function toRequest(row: Row): PurchaseRequest {
  return {
    id: str(row['id']),
    agentId: str(row['agent_id']),
    merchant: str(row['merchant']),
    merchantKey: str(row['merchant_key']),
    item: str(row['item']),
    category: str(row['category']),
    amountMinor: num(row['amount_minor']),
    currency: str(row['currency']),
    reason: str(row['reason']),
    sourceUrl: strOrNull(row['source_url']),
    intentId: strOrNull(row['intent_id']),
    status: str(row['status']) as RequestStatus,
    createdAt: num(row['created_at']),
    updatedAt: num(row['updated_at']),
  };
}

function toDecision(row: Row): Decision {
  return {
    id: num(row['id']),
    requestId: str(row['request_id']),
    policyVerdict: str(row['policy_verdict']) as PolicyVerdict,
    policyReasons: jsonOr<PolicyReason[]>(row['policy_reasons'], []),
    reviewRisk: strOrNull(row['review_risk']) as ReviewRisk | null,
    reviewFlags: jsonOr<string[]>(row['review_flags'], []),
    reviewExplanation: strOrNull(row['review_explanation']),
    finalDecision: str(row['final_decision']) as FinalDecision,
    decidedBy: str(row['decided_by']) as 'policy' | 'reviewer',
    decidedAt: num(row['decided_at']),
  };
}

function toPayment(row: Row): Payment {
  return {
    id: str(row['id']),
    requestId: str(row['request_id']),
    agentId: str(row['agent_id']),
    paypalOrderId: strOrNull(row['paypal_order_id']),
    paypalCaptureId: strOrNull(row['paypal_capture_id']),
    paypalRefundId: strOrNull(row['paypal_refund_id']),
    amountMinor: num(row['amount_minor']),
    currency: str(row['currency']),
    status: str(row['status']) as PaymentStatus,
    capturedAt: numOrNull(row['captured_at']),
    createdAt: num(row['created_at']),
    updatedAt: num(row['updated_at']),
  };
}

function toMandate(row: Row): Mandate {
  return {
    id: str(row['id']),
    paypalVaultId: str(row['paypal_vault_id']),
    paypalCustomerId: strOrNull(row['paypal_customer_id']),
    status: str(row['status']) as Mandate['status'],
    createdAt: num(row['created_at']),
  };
}

function toAudit(row: Row): AuditEntry {
  return {
    id: num(row['id']),
    ts: num(row['ts']),
    actor: str(row['actor']),
    action: str(row['action']),
    requestId: strOrNull(row['request_id']),
    agentId: strOrNull(row['agent_id']),
    details: jsonOr<Record<string, unknown>>(row['details'], {}),
  };
}

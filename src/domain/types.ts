import type { PolicyVerdict, ReasonCode } from '../policy/reasons.js';

export const AGENT_STATUSES = ['active', 'disabled'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export interface Agent {
  id: string;
  name: string;
  status: AgentStatus;
  createdAt: number;
}

/** Local-time window [start, end) as 'HH:MM'; wraps past midnight when start > end. */
export interface TimeWindow {
  start: string;
  end: string;
}

/** The owner's spending rules for one agent. Amounts are integer minor units (cents). */
export interface Policy {
  agentId: string;
  /** ISO 4217 code; requests in any other currency are blocked. */
  currency: string;
  /** Soft per-transaction cap: above it the request is held for the owner. */
  maxTxMinor: number;
  /** Hard per-transaction ceiling: above it the request is blocked outright. null = none. */
  hardMaxTxMinor: number | null;
  /** Budget per calendar month of `timezone`: above it the request is held. */
  monthlyBudgetMinor: number;
  /** Normalized merchant names; null = any merchant. */
  merchantAllowlist: string[] | null;
  /** Normalized category names; null = any category. */
  categoryAllowlist: string[] | null;
  /** Allowed local-time window; null = any time. */
  hours: TimeWindow | null;
  /** IANA zone used for the budget month and the hours window, e.g. 'Asia/Tokyo'. */
  timezone: string;
  /** Without an allowlist, hold the first purchase from a merchant this agent never paid before. */
  holdNewMerchants: boolean;
  updatedAt: number;
}

export const REQUEST_STATUSES = [
  'EVALUATING',
  'AUTO_APPROVED',
  'HELD',
  'BLOCKED',
  'APPROVED',
  'DENIED',
  'PAID',
  'PAYMENT_FAILED',
  'REFUNDED',
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** A purchase an agent asked the guard to make. */
export interface PurchaseRequest {
  id: string;
  agentId: string;
  merchant: string;
  /** normalizeName(merchant), kept for matching and history. */
  merchantKey: string;
  item: string;
  category: string;
  amountMinor: number;
  currency: string;
  /** The agent's stated reason, treated as untrusted text. */
  reason: string;
  sourceUrl: string | null;
  /** The agent's own id for this purchase, unique per agent; a repeat with the same id returns this request (D17). */
  intentId: string | null;
  status: RequestStatus;
  createdAt: number;
  updatedAt: number;
}

export type FinalDecision = 'AUTO_APPROVE' | 'HOLD' | 'BLOCK';
export type ReviewRisk = 'low' | 'medium' | 'high';

export interface PolicyReason {
  code: ReasonCode;
  message: string;
}

/** The outcome of one evaluation: deterministic policy first, AI reviewer second (it may only tighten). */
export interface Decision {
  id: number;
  requestId: string;
  policyVerdict: PolicyVerdict;
  policyReasons: PolicyReason[];
  reviewRisk: ReviewRisk | null;
  reviewFlags: string[];
  reviewExplanation: string | null;
  finalDecision: FinalDecision;
  decidedBy: 'policy' | 'reviewer';
  decidedAt: number;
}

/** REFUND_PENDING: PayPal took the refund but has not completed it; the capture still counts against the budget (D17). */
export const PAYMENT_STATUSES = ['CREATED', 'COMPLETED', 'FAILED', 'REFUND_PENDING', 'REFUNDED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** One PayPal charge for one request. ids are PayPal object ids, never tokens. */
export interface Payment {
  id: string;
  requestId: string;
  agentId: string;
  paypalOrderId: string | null;
  paypalCaptureId: string | null;
  paypalRefundId: string | null;
  amountMinor: number;
  currency: string;
  status: PaymentStatus;
  capturedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** The owner's one-time PayPal authorization (Plan A). Lives only on the guard's side. */
export interface Mandate {
  id: string;
  paypalVaultId: string;
  paypalCustomerId: string | null;
  status: 'active' | 'revoked';
  createdAt: number;
}

export interface AuditEntry {
  id: number;
  ts: number;
  /** 'agent:<id>', 'owner', 'reviewer' or 'system'. */
  actor: string;
  /** Dotted event name such as 'request.created' or 'owner.approved'. */
  action: string;
  requestId: string | null;
  agentId: string | null;
  details: Record<string, unknown>;
}

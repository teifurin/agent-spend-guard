/** Every reason a policy check can raise. Order here is only cosmetic. */
export const REASON_CODES = [
  'AGENT_DISABLED',
  'NO_POLICY',
  'INVALID_AMOUNT',
  'CURRENCY_MISMATCH',
  'UNSUPPORTED_CURRENCY',
  'OVER_HARD_TX_CAP',
  'OVER_TX_CAP',
  'OVER_MONTHLY_BUDGET',
  'MERCHANT_NOT_ALLOWED',
  'CATEGORY_NOT_ALLOWED',
  'OUTSIDE_TIME_WINDOW',
  'NEW_MERCHANT',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/** What the policy engine says before the AI reviewer and the owner weigh in. */
export type PolicyVerdict = 'ALLOW' | 'HOLD' | 'BLOCK';

export type ReasonSeverity = 'HOLD' | 'BLOCK';

/**
 * BLOCK: the owner is not even asked (broken input, disabled agent, above the hard ceiling).
 * HOLD: outside the rules, so the owner decides on their phone.
 */
export const REASON_SEVERITY: Record<ReasonCode, ReasonSeverity> = {
  AGENT_DISABLED: 'BLOCK',
  NO_POLICY: 'BLOCK',
  INVALID_AMOUNT: 'BLOCK',
  CURRENCY_MISMATCH: 'BLOCK',
  UNSUPPORTED_CURRENCY: 'BLOCK',
  OVER_HARD_TX_CAP: 'BLOCK',
  OVER_TX_CAP: 'HOLD',
  OVER_MONTHLY_BUDGET: 'HOLD',
  MERCHANT_NOT_ALLOWED: 'HOLD',
  CATEGORY_NOT_ALLOWED: 'HOLD',
  OUTSIDE_TIME_WINDOW: 'HOLD',
  NEW_MERCHANT: 'HOLD',
};

/** Generic one-line meaning of each code, for legends and docs. The engine adds specifics per request. */
export const REASON_TEXT: Record<ReasonCode, string> = {
  AGENT_DISABLED: 'The agent is unknown or disabled.',
  NO_POLICY: 'No spending policy is configured for the agent.',
  INVALID_AMOUNT: 'The amount is not a positive number with two decimals.',
  CURRENCY_MISMATCH: 'The request currency differs from the policy currency.',
  UNSUPPORTED_CURRENCY: 'Only USD is supported; legacy non-USD financial data must be reconciled before spending.',
  OVER_HARD_TX_CAP: 'The amount is above the hard per-transaction ceiling and can never be approved.',
  OVER_TX_CAP: 'The amount is above the per-transaction cap.',
  OVER_MONTHLY_BUDGET: "The purchase would exceed this month's budget.",
  MERCHANT_NOT_ALLOWED: 'The merchant is not on the allowlist.',
  CATEGORY_NOT_ALLOWED: 'The category is not on the allowlist.',
  OUTSIDE_TIME_WINDOW: 'The request falls outside the allowed hours.',
  NEW_MERCHANT: 'First purchase from this merchant.',
};

export function severityOf(code: ReasonCode): ReasonSeverity {
  return REASON_SEVERITY[code];
}

/** Worst severity wins: any BLOCK reason blocks, any other reason holds, no reason allows. */
export function verdictFor(codes: readonly ReasonCode[]): PolicyVerdict {
  if (codes.some((c) => REASON_SEVERITY[c] === 'BLOCK')) return 'BLOCK';
  return codes.length > 0 ? 'HOLD' : 'ALLOW';
}

import { formatAmount, isValidMinor } from '../domain/money.js';
import { normalizeName } from '../domain/normalize.js';
import type { Agent, Policy, PolicyReason } from '../domain/types.js';
import { type PolicyVerdict, type ReasonCode, verdictFor } from './reasons.js';
import { formatLocalTime, isWithinWindow, localMinutes, monthKey, parseHHMM } from './time.js';

export interface PolicyContext {
  nowMs: number;
  /** Legacy non-USD financial data requires explicit operator reconciliation, never implicit conversion. */
  currencyIssue?: string;
  /** Completed captures in the policy month plus approved requests not yet captured (DECISIONS D10). */
  spentThisMonthMinor: number;
  /** Normalized names of merchants this agent has paid before. */
  knownMerchants: readonly string[];
}

export interface PolicyRequest {
  merchant: string;
  category: string;
  amountMinor: number;
  currency: string;
}

export interface PolicyInput {
  agent: Agent | undefined;
  policy: Policy | undefined;
  request: PolicyRequest;
  context: PolicyContext;
}

export interface BudgetSnapshot {
  monthKey: string;
  capMinor: number;
  spentMinor: number;
  remainingMinor: number;
}

export interface PolicyResult {
  verdict: PolicyVerdict;
  /** Every triggered reason, in evaluation order, with a specific human-readable message. */
  reasons: PolicyReason[];
  budget: BudgetSnapshot | null;
}

/**
 * Deterministic policy check. Pure: same input, same output; no clock, no database.
 * Collects every triggered reason; the verdict is the worst severity among them (BLOCK > HOLD > ALLOW).
 * The AI reviewer that runs afterwards may only tighten this verdict, never loosen it.
 */
export function evaluatePolicy({ agent, policy, request, context }: PolicyInput): PolicyResult {
  const reasons: PolicyReason[] = [];
  const add = (code: ReasonCode, message: string): void => {
    reasons.push({ code, message });
  };
  const result = (budget: BudgetSnapshot | null): PolicyResult => ({ verdict: verdictFor(reasons.map((r) => r.code)), reasons, budget });

  if (!agent) add('AGENT_DISABLED', 'Unknown agent');
  else if (agent.status !== 'active') add('AGENT_DISABLED', `Agent "${agent.id}" is disabled`);

  if (!policy) {
    add('NO_POLICY', 'No spending policy is configured for this agent');
    return result(null);
  }

  if (policy.currency !== 'USD' || context.currencyIssue) {
    add('UNSUPPORTED_CURRENCY', context.currencyIssue ?? 'Only USD policies are supported; reconcile the legacy policy before spending');
    return result(null);
  }

  const fmt = (minor: number): string => `${formatAmount(minor)} ${policy.currency}`;
  const amountOk = isValidMinor(request.amountMinor);
  if (!amountOk) add('INVALID_AMOUNT', 'Amount must be a positive number with two decimals');
  if (request.currency !== policy.currency) {
    add('CURRENCY_MISMATCH', `Request is in ${request.currency}; this agent's policy is in ${policy.currency}`);
  }

  if (amountOk) {
    const amount = request.amountMinor;
    if (amount > policy.maxTxMinor) add('OVER_TX_CAP', `${fmt(amount)} is above the per-transaction cap of ${fmt(policy.maxTxMinor)}`);
    if (policy.hardMaxTxMinor !== null && amount > policy.hardMaxTxMinor) {
      add('OVER_HARD_TX_CAP', `${fmt(amount)} is above the hard ceiling of ${fmt(policy.hardMaxTxMinor)}`);
    }
    const projected = context.spentThisMonthMinor + amount;
    if (projected > policy.monthlyBudgetMinor) {
      add('OVER_MONTHLY_BUDGET', `This purchase would bring this month's spend to ${fmt(projected)}, over the budget of ${fmt(policy.monthlyBudgetMinor)}`);
    }
  }

  const merchantKey = normalizeName(request.merchant);
  if (policy.merchantAllowlist !== null) {
    if (!policy.merchantAllowlist.map(normalizeName).includes(merchantKey)) {
      add('MERCHANT_NOT_ALLOWED', `Merchant "${request.merchant}" is not on the allowlist`);
    }
  } else if (policy.holdNewMerchants && !context.knownMerchants.includes(merchantKey)) {
    add('NEW_MERCHANT', `First purchase from "${request.merchant}"`);
  }

  if (policy.categoryAllowlist !== null && !policy.categoryAllowlist.map(normalizeName).includes(normalizeName(request.category))) {
    add('CATEGORY_NOT_ALLOWED', `Category "${request.category}" is not on the allowlist`);
  }

  if (policy.hours !== null) {
    const start = parseHHMM(policy.hours.start);
    const end = parseHHMM(policy.hours.end);
    if (start === undefined || end === undefined) {
      // A broken window never silently widens the policy: fail closed.
      add('OUTSIDE_TIME_WINDOW', 'The allowed-hours window is misconfigured; ask the owner to fix the policy');
    } else if (!isWithinWindow(localMinutes(context.nowMs, policy.timezone), start, end)) {
      add(
        'OUTSIDE_TIME_WINDOW',
        `It is ${formatLocalTime(context.nowMs, policy.timezone)} in ${policy.timezone}; purchases are allowed between ${policy.hours.start} and ${policy.hours.end}`,
      );
    }
  }

  return result({
    monthKey: monthKey(context.nowMs, policy.timezone),
    capMinor: policy.monthlyBudgetMinor,
    spentMinor: context.spentThisMonthMinor,
    remainingMinor: Math.max(0, policy.monthlyBudgetMinor - context.spentThisMonthMinor),
  });
}

import { isCurrencyCode, isValidMinor } from '../domain/money.js';
import type { Policy } from '../domain/types.js';
import { isValidTimeZone, parseHHMM } from './time.js';

/** Returns the list of problems with a policy; empty when it is valid. */
export function validatePolicy(policy: Omit<Policy, 'updatedAt'>): string[] {
  const problems: string[] = [];
  if (!policy.agentId) problems.push('agentId is required');
  if (!isCurrencyCode(policy.currency)) problems.push('currency must be a three-letter ISO 4217 code such as USD');
  if (!isValidMinor(policy.maxTxMinor)) problems.push('maxTxMinor must be a positive integer');
  if (policy.hardMaxTxMinor !== null && (!isValidMinor(policy.hardMaxTxMinor) || policy.hardMaxTxMinor < policy.maxTxMinor)) {
    problems.push('hardMaxTxMinor must be null or an integer greater than or equal to maxTxMinor');
  }
  if (!isValidMinor(policy.monthlyBudgetMinor)) problems.push('monthlyBudgetMinor must be a positive integer');
  if (policy.merchantAllowlist !== null && policy.merchantAllowlist.length === 0) problems.push('merchantAllowlist must be null (any merchant) or non-empty');
  if (policy.categoryAllowlist !== null && policy.categoryAllowlist.length === 0) problems.push('categoryAllowlist must be null (any category) or non-empty');
  if (policy.hours !== null && (parseHHMM(policy.hours.start) === undefined || parseHHMM(policy.hours.end) === undefined)) {
    problems.push('hours.start and hours.end must be HH:MM in 24-hour time');
  }
  if (!isValidTimeZone(policy.timezone)) problems.push('timezone must be a valid IANA zone such as Asia/Tokyo');
  return problems;
}

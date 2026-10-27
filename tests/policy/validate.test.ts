import { describe, expect, it } from 'vitest';
import type { Policy } from '../../src/domain/types.js';
import { validatePolicy } from '../../src/policy/validate.js';

const valid: Omit<Policy, 'updatedAt'> = {
  agentId: 'research-bot',
  currency: 'USD',
  maxTxMinor: 3000,
  hardMaxTxMinor: 20000,
  monthlyBudgetMinor: 10000,
  merchantAllowlist: ['synthetic books'],
  categoryAllowlist: null,
  hours: { start: '08:00', end: '22:00' },
  timezone: 'Asia/Tokyo',
  holdNewMerchants: true,
};

describe('validatePolicy', () => {
  it('accepts a sound policy', () => {
    expect(validatePolicy(valid)).toEqual([]);
    expect(validatePolicy({ ...valid, hardMaxTxMinor: null, hours: null, merchantAllowlist: null })).toEqual([]);
  });

  it.each<[string, Partial<Omit<Policy, 'updatedAt'>>, RegExp]>([
    ['missing agent', { agentId: '' }, /agentId/],
    ['bad currency', { currency: 'usd' }, /currency/],
    ['zero cap', { maxTxMinor: 0 }, /maxTxMinor/],
    ['fractional cap', { maxTxMinor: 12.5 }, /maxTxMinor/],
    ['hard cap below soft cap', { hardMaxTxMinor: 2999 }, /hardMaxTxMinor/],
    ['zero budget', { monthlyBudgetMinor: 0 }, /monthlyBudgetMinor/],
    ['empty merchant allowlist', { merchantAllowlist: [] }, /merchantAllowlist/],
    ['empty category allowlist', { categoryAllowlist: [] }, /categoryAllowlist/],
    ['malformed hours', { hours: { start: '8:00', end: '22:00' } }, /hours/],
    ['24:00 is not a time', { hours: { start: '08:00', end: '24:00' } }, /hours/],
    ['unknown zone', { timezone: 'Mars/Olympus' }, /timezone/],
  ])('reports %s', (_name, patch, pattern) => {
    const problems = validatePolicy({ ...valid, ...patch });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(pattern);
  });

  it('lists every problem at once', () => {
    expect(validatePolicy({ ...valid, currency: 'x', maxTxMinor: -1, timezone: 'nowhere' })).toHaveLength(3);
  });
});

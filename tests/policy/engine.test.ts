import { describe, expect, it } from 'vitest';
import type { Agent, Policy } from '../../src/domain/types.js';
import { type PolicyContext, type PolicyRequest, evaluatePolicy } from '../../src/policy/engine.js';

const agent: Agent = { id: 'research-bot', name: 'Research bot', status: 'active', createdAt: 0 };

const policy: Policy = {
  agentId: 'research-bot',
  currency: 'USD',
  maxTxMinor: 3000, // $30 per purchase
  hardMaxTxMinor: 20000, // $200 never
  monthlyBudgetMinor: 10000, // $100 a month
  merchantAllowlist: ['Synthetic Books', 'Synthetic Supplies'],
  categoryAllowlist: ['books', 'office'],
  hours: { start: '08:00', end: '22:00' },
  timezone: 'Asia/Tokyo',
  holdNewMerchants: true,
  updatedAt: 0,
};

const NOON_JST = Date.UTC(2026, 9, 27, 3, 0); // 2026-10-27 12:00 in Tokyo

const context: PolicyContext = { nowMs: NOON_JST, spentThisMonthMinor: 0, knownMerchants: [] };

const request: PolicyRequest = { merchant: 'Synthetic Books', category: 'books', amountMinor: 1200, currency: 'USD' };

function run(overrides: { agent?: Agent | undefined; policy?: Policy | undefined; request?: Partial<PolicyRequest>; context?: Partial<PolicyContext> } = {}) {
  return evaluatePolicy({
    agent: 'agent' in overrides ? overrides.agent : agent,
    policy: 'policy' in overrides ? overrides.policy : policy,
    request: { ...request, ...overrides.request },
    context: { ...context, ...overrides.context },
  });
}

const codes = (result: ReturnType<typeof evaluatePolicy>): string[] => result.reasons.map((r) => r.code);

describe('evaluatePolicy: happy path', () => {
  it('allows an in-policy purchase and reports the budget', () => {
    const result = run({ context: { spentThisMonthMinor: 2500 } });
    expect(result.verdict).toBe('ALLOW');
    expect(result.reasons).toEqual([]);
    expect(result.budget).toEqual({ monthKey: '2026-10', capMinor: 10000, spentMinor: 2500, remainingMinor: 7500 });
  });

  it('matches allowlists regardless of case, width and spacing', () => {
    for (const merchant of ['synthetic books', 'SYNTHETIC  BOOKS', 'ＳＹＮＴＨＥＴＩＣ　ＢＯＯＫＳ', ' Synthetic Books ']) {
      expect(run({ request: { merchant, category: 'BOOKS' } }).verdict).toBe('ALLOW');
    }
  });
});

describe('evaluatePolicy: amounts', () => {
  it('treats the per-transaction cap as inclusive', () => {
    expect(run({ request: { amountMinor: 3000 } }).verdict).toBe('ALLOW');
    const over = run({ request: { amountMinor: 3001 } });
    expect(over.verdict).toBe('HOLD');
    expect(codes(over)).toEqual(['OVER_TX_CAP']);
    expect(over.reasons[0]?.message).toBe('30.01 USD is above the per-transaction cap of 30.00 USD');
  });

  // a roomy budget so these cases isolate the per-transaction caps
  const roomy = { ...policy, monthlyBudgetMinor: 100_000_000 };

  it('blocks above the hard ceiling and still lists the soft cap', () => {
    const result = run({ policy: roomy, request: { amountMinor: 20001 } });
    expect(result.verdict).toBe('BLOCK');
    expect(codes(result)).toEqual(['OVER_TX_CAP', 'OVER_HARD_TX_CAP']);
    expect(run({ policy: { ...roomy, maxTxMinor: 20000 }, request: { amountMinor: 20000 } }).verdict).toBe('ALLOW');
  });

  it('has no hard ceiling when hardMaxTxMinor is null', () => {
    expect(codes(run({ policy: { ...roomy, hardMaxTxMinor: null }, request: { amountMinor: 999999 } }))).toEqual(['OVER_TX_CAP']);
  });

  it('treats the monthly budget as inclusive', () => {
    expect(run({ request: { amountMinor: 3000 }, context: { spentThisMonthMinor: 7000 } }).verdict).toBe('ALLOW');
    const over = run({ request: { amountMinor: 3000 }, context: { spentThisMonthMinor: 7001 } });
    expect(over.verdict).toBe('HOLD');
    expect(codes(over)).toEqual(['OVER_MONTHLY_BUDGET']);
    expect(over.reasons[0]?.message).toContain('100.01 USD');
  });

  it('blocks malformed amounts without evaluating caps', () => {
    for (const amountMinor of [0, -5, 12.5, NaN]) {
      const result = run({ request: { amountMinor } });
      expect(result.verdict).toBe('BLOCK');
      expect(codes(result)).toEqual(['INVALID_AMOUNT']);
    }
  });

  it('blocks a currency that differs from the policy', () => {
    const result = run({ request: { currency: 'JPY' } });
    expect(result.verdict).toBe('BLOCK');
    expect(codes(result)).toEqual(['CURRENCY_MISMATCH']);
  });
});

describe('evaluatePolicy: merchants and categories', () => {
  it('holds a merchant missing from the allowlist', () => {
    const result = run({ request: { merchant: 'Unknown Shop' } });
    expect(result.verdict).toBe('HOLD');
    expect(codes(result)).toEqual(['MERCHANT_NOT_ALLOWED']);
  });

  it('holds a category missing from the allowlist', () => {
    const result = run({ request: { category: 'gadgets' } });
    expect(codes(result)).toEqual(['CATEGORY_NOT_ALLOWED']);
  });

  it('accepts any merchant or category when the allowlist is null', () => {
    const open = { ...policy, merchantAllowlist: null, categoryAllowlist: null, holdNewMerchants: false };
    expect(run({ policy: open, request: { merchant: 'Anything', category: 'whatever' } }).verdict).toBe('ALLOW');
  });

  it('holds the first purchase from a new merchant only when there is no allowlist', () => {
    const open = { ...policy, merchantAllowlist: null };
    const fresh = run({ policy: open, request: { merchant: 'New Shop' } });
    expect(codes(fresh)).toEqual(['NEW_MERCHANT']);
    const known = run({ policy: open, request: { merchant: 'New Shop' }, context: { knownMerchants: ['new shop'] } });
    expect(known.verdict).toBe('ALLOW');
    // with an allowlist, an allowlisted merchant is trusted even if never paid before
    expect(codes(run({ request: { merchant: 'Synthetic Supplies' } }))).toEqual([]);
    // and a non-allowlisted one is reported as not allowed, never as "new"
    expect(codes(run({ request: { merchant: 'New Shop' } }))).toEqual(['MERCHANT_NOT_ALLOWED']);
  });

  it('does not hold new merchants when the owner switched that off', () => {
    const open = { ...policy, merchantAllowlist: null, holdNewMerchants: false };
    expect(run({ policy: open, request: { merchant: 'New Shop' } }).verdict).toBe('ALLOW');
  });
});

describe('evaluatePolicy: hours', () => {
  const at = (utcHour: number, utcMinute = 0, day = 27) => Date.UTC(2026, 9, day, utcHour, utcMinute);

  it('treats the window as [start, end) in the policy zone', () => {
    expect(run({ context: { nowMs: at(23, 0, 26) } }).verdict).toBe('ALLOW'); // 08:00 JST
    expect(codes(run({ context: { nowMs: at(22, 59, 26) } }))).toEqual(['OUTSIDE_TIME_WINDOW']); // 07:59 JST
    expect(run({ context: { nowMs: at(12, 59) } }).verdict).toBe('ALLOW'); // 21:59 JST
    const late = run({ context: { nowMs: at(13, 0) } }); // 22:00 JST
    expect(codes(late)).toEqual(['OUTSIDE_TIME_WINDOW']);
    expect(late.reasons[0]?.message).toBe('It is 22:00 in Asia/Tokyo; purchases are allowed between 08:00 and 22:00');
  });

  it('supports a window that wraps past midnight', () => {
    const night = { ...policy, hours: { start: '22:00', end: '06:00' } };
    expect(run({ policy: night, context: { nowMs: at(14, 0) } }).verdict).toBe('ALLOW'); // 23:00 JST
    expect(run({ policy: night, context: { nowMs: at(18, 0, 26) } }).verdict).toBe('ALLOW'); // 03:00 JST
    expect(codes(run({ policy: night, context: { nowMs: at(3, 0) } }))).toEqual(['OUTSIDE_TIME_WINDOW']); // 12:00 JST
  });

  it('ignores hours when the policy has none', () => {
    expect(run({ policy: { ...policy, hours: null }, context: { nowMs: at(13, 0) } }).verdict).toBe('ALLOW');
  });

  it('fails closed on a misconfigured window', () => {
    const broken = { ...policy, hours: { start: '8am', end: '22:00' } };
    expect(codes(run({ policy: broken }))).toEqual(['OUTSIDE_TIME_WINDOW']);
  });
});

describe('evaluatePolicy: agent and policy presence', () => {
  it('blocks a disabled or unknown agent', () => {
    expect(codes(run({ agent: { ...agent, status: 'disabled' } }))).toEqual(['AGENT_DISABLED']);
    const unknown = run({ agent: undefined });
    expect(unknown.verdict).toBe('BLOCK');
    expect(unknown.reasons[0]?.message).toBe('Unknown agent');
  });

  it('blocks when no policy exists and reports no budget', () => {
    const result = run({ policy: undefined });
    expect(result.verdict).toBe('BLOCK');
    expect(codes(result)).toEqual(['NO_POLICY']);
    expect(result.budget).toBeNull();
  });
});

describe('evaluatePolicy: composition', () => {
  it('collects every triggered reason and takes the worst severity', () => {
    const result = run({
      request: { merchant: 'Unknown Shop', category: 'gadgets', amountMinor: 5000 },
      context: { spentThisMonthMinor: 9000, nowMs: Date.UTC(2026, 9, 27, 14, 0) }, // 23:00 JST
    });
    expect(result.verdict).toBe('HOLD');
    expect(codes(result)).toEqual(['OVER_TX_CAP', 'OVER_MONTHLY_BUDGET', 'MERCHANT_NOT_ALLOWED', 'CATEGORY_NOT_ALLOWED', 'OUTSIDE_TIME_WINDOW']);
  });

  it('is pure: the same input always yields the same output', () => {
    const a = run({ request: { amountMinor: 3001 } });
    const b = run({ request: { amountMinor: 3001 } });
    expect(a).toEqual(b);
  });
});


describe('USD-only legacy quarantine', () => {
  it('blocks even matching non-USD policy and request instead of treating their minor units as USD', () => {
    const result = run({ policy: { ...policy, currency: 'JPY' }, request: { currency: 'JPY' } });
    expect(result.verdict).toBe('BLOCK');
    expect(codes(result)).toContain('UNSUPPORTED_CURRENCY');
    expect(result.budget).toBeNull();
  });

  it('blocks a USD request with quarantined legacy history and does not expose a false budget', () => {
    const result = run({ context: { currencyIssue: 'Legacy EUR ledger requires reconciliation' } });
    expect(result.verdict).toBe('BLOCK');
    expect(result.budget).toBeNull();
  });
});

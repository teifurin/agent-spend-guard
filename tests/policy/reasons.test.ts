import { describe, expect, it } from 'vitest';
import { REASON_CODES, REASON_SEVERITY, REASON_TEXT, severityOf, verdictFor } from '../../src/policy/reasons.js';

describe('reason codes', () => {
  it('every code has a severity and a description', () => {
    for (const code of REASON_CODES) {
      expect(['HOLD', 'BLOCK']).toContain(REASON_SEVERITY[code]);
      expect(REASON_TEXT[code].length).toBeGreaterThan(10);
    }
    expect(Object.keys(REASON_SEVERITY).sort()).toEqual([...REASON_CODES].sort());
    expect(Object.keys(REASON_TEXT).sort()).toEqual([...REASON_CODES].sort());
  });

  it('splits codes into owner-decides (HOLD) and never-asked (BLOCK)', () => {
    const hold = REASON_CODES.filter((c) => severityOf(c) === 'HOLD');
    const block = REASON_CODES.filter((c) => severityOf(c) === 'BLOCK');
    expect(hold.sort()).toEqual(['CATEGORY_NOT_ALLOWED', 'MERCHANT_NOT_ALLOWED', 'NEW_MERCHANT', 'OUTSIDE_TIME_WINDOW', 'OVER_MONTHLY_BUDGET', 'OVER_TX_CAP']);
    expect(block.sort()).toEqual(['AGENT_DISABLED', 'CURRENCY_MISMATCH', 'INVALID_AMOUNT', 'NO_POLICY', 'OVER_HARD_TX_CAP', 'UNSUPPORTED_CURRENCY']);
  });
});

describe('verdictFor', () => {
  it('allows with no reasons, holds on soft reasons, blocks when any hard reason is present', () => {
    expect(verdictFor([])).toBe('ALLOW');
    expect(verdictFor(['OVER_TX_CAP'])).toBe('HOLD');
    expect(verdictFor(['OVER_TX_CAP', 'NEW_MERCHANT'])).toBe('HOLD');
    expect(verdictFor(['OVER_TX_CAP', 'CURRENCY_MISMATCH'])).toBe('BLOCK');
    expect(verdictFor(['AGENT_DISABLED'])).toBe('BLOCK');
  });
});

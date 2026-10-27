import { describe, expect, it } from 'vitest';
import { formatAmount, isCurrencyCode, isValidMinor, parseAmount } from '../../src/domain/money.js';

describe('parseAmount', () => {
  it.each([
    ['12.34', 1234],
    ['0.01', 1],
    ['30.00', 3000],
    ['1234567890.99', 123456789099],
  ])('parses %s', (text, minor) => {
    expect(parseAmount(text)).toBe(minor);
  });

  it.each(['0.00', '12', '12.3', '12.345', '-1.00', '1,00', ' 1.00', '1.00 ', 'abc', '', '12345678901.00'])('rejects %j', (text) => {
    expect(parseAmount(text)).toBeUndefined();
  });
});

describe('formatAmount', () => {
  it('round-trips with parseAmount', () => {
    for (const text of ['0.01', '0.99', '1.00', '12.34', '100.05']) expect(formatAmount(parseAmount(text)!)).toBe(text);
  });

  it('pads cents and handles zero', () => {
    expect(formatAmount(0)).toBe('0.00');
    expect(formatAmount(5)).toBe('0.05');
    expect(formatAmount(120000)).toBe('1200.00');
  });

  it('refuses fractions and negatives', () => {
    expect(() => formatAmount(1.5)).toThrow(RangeError);
    expect(() => formatAmount(-1)).toThrow(RangeError);
  });
});

describe('currency and minor-unit checks', () => {
  it('accepts well-formed ISO codes only', () => {
    expect(isCurrencyCode('USD')).toBe(true);
    for (const bad of ['usd', 'US', 'USDT', '$', '']) expect(isCurrencyCode(bad)).toBe(false);
  });

  it('accepts positive integers only', () => {
    expect(isValidMinor(1)).toBe(true);
    for (const bad of [0, -1, 1.5, NaN, Infinity, '1', null, undefined]) expect(isValidMinor(bad)).toBe(false);
  });
});

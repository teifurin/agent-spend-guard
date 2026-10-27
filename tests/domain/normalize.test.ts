import { describe, expect, it } from 'vitest';
import { normalizeName, normalizeNames } from '../../src/domain/normalize.js';

describe('normalizeName', () => {
  it('folds case, width and whitespace', () => {
    expect(normalizeName('Synthetic Books')).toBe('synthetic books');
    expect(normalizeName('  SYNTHETIC   BOOKS ')).toBe('synthetic books');
    expect(normalizeName('ＳＹＮＴＨＥＴＩＣ　ＢＯＯＫＳ')).toBe('synthetic books');
    expect(normalizeName('Café Ｃｏ．')).toBe('café co.');
  });

  it('leaves already-canonical names alone', () => {
    expect(normalizeName('office')).toBe('office');
  });
});

describe('normalizeNames', () => {
  it('drops blanks and duplicates, keeps first-seen order', () => {
    expect(normalizeNames(['Books', ' books', '', 'Office', 'ＢＯＯＫＳ'])).toEqual(['books', 'office']);
  });
});

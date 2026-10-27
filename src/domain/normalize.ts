/** Canonical form for merchant and category names: NFKC (full-width to ASCII), trimmed, lower-case, single spaces. */
export function normalizeName(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Normalizes a list, dropping blanks and duplicates while keeping first-seen order. */
export function normalizeNames(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeName).filter((v) => v !== ''))];
}

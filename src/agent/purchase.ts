/** Retry only an unknown transport outcome, preserving the caller's already allocated purchase identity and payload. */
export async function requestPurchaseWithRetry<T extends { isError?: boolean; structuredContent?: Record<string, unknown> }>(
  call: () => Promise<T>,
  onRetry: () => void = () => {},
): Promise<T> {
  const result = await call();
  if (result.isError && result.structuredContent?.['error'] === 'guard_unreachable') {
    onRetry();
    return call();
  }
  return result;
}

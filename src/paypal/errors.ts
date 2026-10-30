import { PayPalApiError, type PayPalClient } from './client.js';

/**
 * A short, redacted description of a failed PayPal call for logs, audit entries and the dashboard: the HTTP status,
 * PayPal's error name, its issue codes and the debug id. Never the response body and never the request. The text goes
 * through the client's redactor once more on the way out, so a registered value that reached an error message still
 * leaves as [REDACTED]. Transport errors (PayPalTransportError) carry fixed text to begin with.
 */
export function describePayPalError(err: unknown, client: PayPalClient): string {
  if (err instanceof PayPalApiError) {
    const issues = err.details.map((d) => d.issue).filter((i): i is string => typeof i === 'string');
    return client.redactor.redact(`PayPal ${err.status} ${err.paypalName}${issues.length > 0 ? ` [${issues.join(', ')}]` : ''}${err.debugId ? ` debug_id=${err.debugId}` : ''}`);
  }
  return client.redactor.redact(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
}

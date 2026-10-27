/** The only PayPal host this project ever talks to. There is deliberately no way to configure another one. */
export const PAYPAL_SANDBOX_BASE_URL = 'https://api-m.sandbox.paypal.com';
const SANDBOX_HOST = 'api-m.sandbox.paypal.com';

export interface PayPalConfig {
  readonly baseUrl: typeof PAYPAL_SANDBOX_BASE_URL;
  readonly clientId: string;
  readonly clientSecret: string;
}

export class SandboxOnlyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxOnlyError';
  }
}

/**
 * Builds the PayPal config from environment variables.
 * Refuses anything but PAYPAL_ENV=SANDBOX: this project never touches live PayPal, by design.
 * Error messages never include the values that were read.
 */
export function loadPayPalConfig(env: NodeJS.ProcessEnv = process.env): PayPalConfig {
  if (env.PAYPAL_ENV !== 'SANDBOX') {
    const got = env.PAYPAL_ENV === undefined || env.PAYPAL_ENV === '' ? 'it is not set' : 'it is set to something else';
    throw new SandboxOnlyError(`Refusing to start: PAYPAL_ENV must be exactly "SANDBOX" (${got}). This project never uses live PayPal.`);
  }
  const clientId = env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = env.PAYPAL_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required. Copy .env.example to .env and fill them in; `npm run check-env` shows what is missing.');
  }
  return { baseUrl: PAYPAL_SANDBOX_BASE_URL, clientId, clientSecret };
}

/** Last line of defence: throws unless the URL targets the PayPal sandbox host over https. */
export function assertSandboxUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SandboxOnlyError('Refusing to call PayPal: malformed URL');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== SANDBOX_HOST) {
    throw new SandboxOnlyError(`Refusing to call a non-sandbox PayPal host: ${parsed.protocol}//${parsed.hostname}`);
  }
}

/**
 * A stand-in for the PayPal sandbox used by `npm run e2e:offline`: it answers the few endpoints the executor calls
 * (token, create order, refund) with made-up ids and never touches the network. The credentials that go with it are
 * placeholders, not secrets. The tests keep their own fakes; this one lets a judge watch the whole loop, charge and
 * refund included, without a PayPal account.
 */
import { PAYPAL_SANDBOX_BASE_URL, type PayPalConfig } from '../paypal/env.js';

/** Placeholder credentials for the fake. They are not secrets and they never leave the process. */
export const FAKE_PAYPAL_CONFIG: PayPalConfig = {
  baseUrl: PAYPAL_SANDBOX_BASE_URL,
  clientId: 'offline-fake-client-id',
  clientSecret: 'offline-fake-client-secret',
};

export interface FakePayPalCall {
  method: string;
  path: string;
}

export interface FakePayPal {
  /** Hand this to PayPalClient as its fetch. */
  fetch: typeof fetch;
  /** Every API call so far, the OAuth token call excluded. */
  calls: FakePayPalCall[];
}

const json = (body: unknown, status: number): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Orders complete on creation, as the sandbox does for a vaulted PayPal with the buyer absent; refunds complete at once. */
export function createFakePayPal(): FakePayPal {
  let seq = 0;
  const nextId = (prefix: string): string => `${prefix}-OFFLINE-${String(++seq).padStart(4, '0')}`;
  const calls: FakePayPalCall[] = [];

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname;
    if (path === '/v1/oauth2/token') return json({ access_token: 'offline-fake-access-token', expires_in: 3600, token_type: 'Bearer' }, 200);
    calls.push({ method, path });
    if (method === 'POST' && path === '/v2/checkout/orders') {
      return json({ id: nextId('ORDER'), status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: nextId('CAPTURE'), status: 'COMPLETED' }] } }] }, 201);
    }
    if (method === 'POST' && /^\/v2\/payments\/captures\/[^/]+\/refund$/.test(path)) {
      return json({ id: nextId('REFUND'), status: 'COMPLETED' }, 201);
    }
    return json({ name: 'RESOURCE_NOT_FOUND', message: `the offline fake does not implement ${method} ${path}`, details: [] }, 404);
  };
  return { fetch: fetchImpl as unknown as typeof fetch, calls };
}

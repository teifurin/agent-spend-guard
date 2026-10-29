import { describe, expect, it, vi } from 'vitest';
import { PayPalApiError, PayPalClient, requestIdFor } from '../../src/paypal/client.js';
import { PAYPAL_SANDBOX_BASE_URL, SandboxOnlyError, type PayPalConfig } from '../../src/paypal/env.js';

const SECRET = 'EsuperSecretValue0000000000000';
const CLIENT_ID = 'AclientIdValue00000000000000';
const TOKEN = 'A21AAfakeAccessTokenValue000000';
const cfg: PayPalConfig = { baseUrl: PAYPAL_SANDBOX_BASE_URL, clientId: CLIENT_ID, clientSecret: SECRET };

interface Call {
  url: string;
  init: RequestInit;
}

function makeFetch(handler: (call: Call, n: number) => Response) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call, calls.length);
  });
  return { calls, fetch: fetchMock as unknown as typeof fetch };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const tokenResponse = (expiresIn = 3600): Response => json({ access_token: TOKEN, expires_in: expiresIn, token_type: 'Bearer' });
const isTokenCall = (c: Call): boolean => c.url.endsWith('/v1/oauth2/token');
const headerOf = (c: Call, name: string): string | undefined => (c.init.headers as Record<string, string>)[name];

describe('PayPalClient', () => {
  it('only ever calls the sandbox host', async () => {
    const { calls, fetch } = makeFetch((c) => (isTokenCall(c) ? tokenResponse() : json({ id: 'ORDER1', status: 'COMPLETED' }, 201)));
    const client = new PayPalClient(cfg, { fetch });
    await client.request('POST', '/v2/checkout/orders', { body: { intent: 'CAPTURE' } });
    expect(calls.length).toBe(2);
    for (const c of calls) expect(c.url.startsWith('https://api-m.sandbox.paypal.com/')).toBe(true);
  });

  it('refuses a config that points anywhere else', () => {
    const live = { ...cfg, baseUrl: 'https://api-m.paypal.com' as typeof PAYPAL_SANDBOX_BASE_URL };
    expect(() => new PayPalClient(live, { fetch: makeFetch(() => json({})).fetch })).toThrow(SandboxOnlyError);
  });

  it('authenticates with client credentials, then sends bearer, idempotency and Prefer headers', async () => {
    const { calls, fetch } = makeFetch((c) => (isTokenCall(c) ? tokenResponse() : json({ id: 'ORDER1' }, 201)));
    const client = new PayPalClient(cfg, { fetch });
    const { status, data } = await client.request<{ id: string }>('POST', '/v2/checkout/orders', {
      body: { intent: 'CAPTURE' },
      requestId: 'asg-order-test',
    });
    expect(status).toBe(201);
    expect(data.id).toBe('ORDER1');

    const [tokenCall, orderCall] = calls;
    expect(tokenCall && headerOf(tokenCall, 'Authorization')).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${SECRET}`).toString('base64')}`);
    expect(tokenCall?.init.body).toBe('grant_type=client_credentials&ignoreCache=true');
    expect(orderCall && headerOf(orderCall, 'Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(orderCall && headerOf(orderCall, 'PayPal-Request-Id')).toBe('asg-order-test');
    expect(orderCall && headerOf(orderCall, 'Prefer')).toBe('return=representation');
    expect(orderCall?.init.body).toBe('{"intent":"CAPTURE"}');
  });

  it('caches the access token and refreshes it shortly before expiry', async () => {
    let now = 1_000_000;
    const { calls, fetch } = makeFetch((c) => (isTokenCall(c) ? tokenResponse(3600) : json({ ok: true })));
    const client = new PayPalClient(cfg, { fetch, now: () => now });

    await client.request('GET', '/v2/checkout/orders/A');
    await client.request('GET', '/v2/checkout/orders/B');
    expect(calls.filter(isTokenCall).length).toBe(1);

    now += 3600 * 1000 - 30_000; // 30 s before expiry: inside the refresh margin
    await client.request('GET', '/v2/checkout/orders/C');
    expect(calls.filter(isTokenCall).length).toBe(2);
  });

  it('logs whether the token carries the vault permission, never the token itself', async () => {
    const lineFor = async (scope: string | undefined): Promise<string> => {
      const lines: string[] = [];
      const body = { access_token: TOKEN, expires_in: 32400, token_type: 'Bearer', ...(scope === undefined ? {} : { scope }) };
      const { fetch } = makeFetch((c) => (isTokenCall(c) ? json(body) : json({ ok: true })));
      await new PayPalClient(cfg, { fetch, log: (l) => lines.push(l) }).request('GET', '/v2/checkout/orders/A');
      const line = lines.find((l) => l.includes('/v1/oauth2/token'));
      expect(line).toBeDefined();
      expect(line).not.toContain(TOKEN);
      return line ?? '';
    };
    expect(await lineFor('https://uri.paypal.com/services/payments/payment https://uri.paypal.com/services/vault/payment-tokens/readwrite')).toContain('vault scope: yes');
    expect(await lineFor('https://uri.paypal.com/services/payments/payment')).toContain('vault scope: NO');
    expect(await lineFor(undefined)).not.toContain('vault scope');
  });

  it('retries once with a fresh token when PayPal answers 401', async () => {
    let orderAttempts = 0;
    const { calls, fetch } = makeFetch((c) => {
      if (isTokenCall(c)) return tokenResponse();
      orderAttempts += 1;
      return orderAttempts === 1 ? json({ name: 'INVALID_TOKEN' }, 401) : json({ id: 'ORDER1' }, 201);
    });
    const client = new PayPalClient(cfg, { fetch });
    const { status } = await client.request('POST', '/v2/checkout/orders', { body: {} });
    expect(status).toBe(201);
    expect(orderAttempts).toBe(2);
    expect(calls.filter(isTokenCall).length).toBe(2);
  });

  it('wraps API errors with name, debug_id and issues, never with credentials', async () => {
    const { fetch } = makeFetch((c) =>
      isTokenCall(c)
        ? tokenResponse()
        : json(
            {
              name: 'INVALID_REQUEST',
              message: `bad request, token was Bearer ${TOKEN} and secret ${SECRET}`,
              debug_id: 'abc123',
              details: [{ issue: 'MISSING_REQUIRED_PARAMETER', field: '/purchase_units', description: `leaked ${SECRET}` }],
            },
            400,
          ),
    );
    const client = new PayPalClient(cfg, { fetch });
    const err = await client.request('POST', '/v2/checkout/orders', { body: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    const e = err as PayPalApiError;
    expect(e.status).toBe(400);
    expect(e.paypalName).toBe('INVALID_REQUEST');
    expect(e.debugId).toBe('abc123');
    expect(e.details[0]?.issue).toBe('MISSING_REQUIRED_PARAMETER');
    const everything = JSON.stringify({ message: e.message, stack: e.stack, details: e.details });
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(TOKEN);
    expect(everything).toContain('[REDACTED]');
  });

  it('turns an OAuth failure into a redacted PayPalApiError', async () => {
    const { fetch } = makeFetch(() => json({ error: 'invalid_client', error_description: 'Client Authentication failed' }, 401));
    const client = new PayPalClient(cfg, { fetch });
    const err = await client.getAccessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect((err as PayPalApiError).paypalName).toBe('invalid_client');
    expect((err as PayPalApiError).message).not.toContain(SECRET);
  });
});

describe('requestIdFor', () => {
  it('is deterministic for the same scope and key', () => {
    expect(requestIdFor('order', 'req_1')).toBe(requestIdFor('order', 'req_1'));
  });

  it('differs across scopes and keys', () => {
    expect(requestIdFor('order', 'req_1')).not.toBe(requestIdFor('capture', 'req_1'));
    expect(requestIdFor('order', 'req_1')).not.toBe(requestIdFor('order', 'req_2'));
  });

  it('is a short, header-safe string', () => {
    const id = requestIdFor('refund', 'req_1:CAPTURE123');
    expect(id).toMatch(/^asg-refund-[0-9a-f]{32}$/);
    expect(id.length).toBeLessThanOrEqual(108);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import { openDatabase } from '../../src/db/connection.js';
import { Repo } from '../../src/db/repo.js';
import { DEMO_AGENT_ID, seedDemo } from '../../src/demo/seed.js';
import type { Payment } from '../../src/domain/types.js';
import type { PayPalExecutor } from '../../src/guard/executor.js';
import { Guard } from '../../src/guard/pipeline.js';
import { PayPalClient } from '../../src/paypal/client.js';
import { PAYPAL_SANDBOX_BASE_URL, type PayPalConfig } from '../../src/paypal/env.js';
import { createApp } from '../../src/server/app.js';
import { EventBus, type GuardEvent } from '../../src/server/events.js';

const NOW = Date.UTC(2026, 9, 28, 3, 0); // 12:00 Asia/Tokyo, inside the demo hours

/** Stands in for the PayPal executor: moves the request through the same Repo state changes, no network. */
class FakeExecutor {
  constructor(
    private readonly repo: Repo,
    public outcome: 'COMPLETED' | 'FAILED' = 'COMPLETED',
  ) {}
  async charge(requestId: string): Promise<Payment> {
    const payment = this.repo.beginPayment(requestId);
    if (payment.status !== 'CREATED') return payment;
    return this.outcome === 'COMPLETED' ? this.repo.settlePayment(payment.id, { paypalOrderId: 'O-fake', paypalCaptureId: 'C-fake', capturedAt: NOW }) : this.repo.failPayment(payment.id);
  }
  async refund(requestId: string): Promise<Payment> {
    const payment = this.repo.paymentForRequest(requestId);
    if (!payment) throw new Error('no payment');
    return this.repo.refundPayment(payment.id, 'R-fake');
  }
}

function setup(opts: { executor?: boolean; paypal?: PayPalClient; outcome?: 'COMPLETED' | 'FAILED' } = {}) {
  const repo = new Repo(openDatabase(), () => NOW);
  seedDemo(repo);
  const events = new EventBus();
  const fake = new FakeExecutor(repo, opts.outcome);
  const executor = opts.executor === false ? undefined : (fake as unknown as PayPalExecutor);
  const guard = new Guard({ repo, executor, now: () => NOW });
  const app = createApp({ repo, guard, events, executor, paypal: opts.paypal, publicBaseUrl: 'http://localhost:3000', shopUrl: 'http://localhost:3001', now: () => NOW, heartbeatMs: 20 });
  const published: GuardEvent[] = [];
  events.subscribe((e) => published.push(e));
  return { repo, app, events, published, fake };
}

const postJson = (app: Hono, path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const postForm = (app: Hono, path: string, fields: Record<string, string> = {}) =>
  app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });

const notebook = {
  agent_id: DEMO_AGENT_ID,
  merchant: 'Synthetic Books',
  item: 'Field notebook, A5 x1',
  category: 'books',
  amount: '12.00',
  currency: 'USD',
  reason: 'Field notes for the survey',
  source_url: 'http://localhost:3001/products/field-notebook-a5',
};
const microscope = { ...notebook, merchant: 'Synthetic Gadgets', item: 'USB microscope, 1000x', category: 'electronics', amount: '45.00', source_url: 'http://localhost:3001/products/usb-microscope' };

interface ApiRequest {
  request_id: string;
  status: string;
  decision: { final: string; reasons: Array<{ code: string }> } | null;
  payment: { status: string; paypal_capture_id: string | null } | null;
  message: string;
  error?: string;
  issues?: string[];
}

describe('agent API', () => {
  it('pays a request inside the rules and publishes the events', async () => {
    const { app, published } = setup();
    const res = await postJson(app, '/api/requests', notebook);
    expect(res.status).toBe(201);
    const body = (await res.json()) as ApiRequest;
    expect(body.status).toBe('PAID');
    expect(body.decision?.final).toBe('AUTO_APPROVE');
    expect(body.payment).toMatchObject({ status: 'COMPLETED', paypal_capture_id: 'C-fake' });
    expect(body.message).toContain('Paid');
    expect(published.map((e) => e.type)).toEqual(['request.decided', 'payment.captured']);

    const again = (await (await app.request(`/api/requests/${body.request_id}`)).json()) as ApiRequest;
    expect(again.status).toBe('PAID');
  });

  it('holds a request at a merchant the owner never allowed, with the reasons spelled out', async () => {
    const { app } = setup();
    const body = (await (await postJson(app, '/api/requests', microscope)).json()) as ApiRequest;
    expect(body.status).toBe('HELD');
    expect(body.decision?.reasons.map((r) => r.code)).toEqual(['OVER_TX_CAP', 'MERCHANT_NOT_ALLOWED']);
    expect(body.payment).toBeNull();
    expect(body.message).toContain('Held for the owner');
  });

  it('rejects bad input without touching the guard', async () => {
    const { app, published } = setup();
    expect((await app.request('/api/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' })).status).toBe(400);
    const missing = await postJson(app, '/api/requests', { agent_id: DEMO_AGENT_ID, merchant: 'x' });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as ApiRequest).issues?.length).toBeGreaterThan(0);
    const badAmount = await postJson(app, '/api/requests', { ...notebook, amount: '12' });
    expect(badAmount.status).toBe(400);
    expect(((await badAmount.json()) as ApiRequest).issues?.[0]).toContain('amount');
    expect((await postJson(app, '/api/requests', { ...notebook, agent_id: 'ghost' })).status).toBe(404);
    expect((await app.request('/api/requests/req_nope')).status).toBe(404);
    expect(published.length).toBe(0);
  });

  it('accepts a numeric amount and reports the budget', async () => {
    const { app } = setup();
    const paid = (await (await postJson(app, '/api/requests', { ...notebook, amount: 12 })).json()) as ApiRequest;
    expect(paid.status).toBe('PAID');
    const res = await app.request(`/api/agents/${DEMO_AGENT_ID}/budget`);
    const budget = (await res.json()) as { month: string; spent: string; remaining: string; policy: { max_per_purchase: string; merchant_allowlist: string[] } };
    expect(budget).toMatchObject({ month: '2026-10', spent: '12.00', remaining: '88.00' });
    expect(budget.policy.max_per_purchase).toBe('30.00');
    expect(budget.policy.merchant_allowlist).toEqual(['synthetic books', 'synthetic supplies']);
    expect((await app.request('/api/agents/ghost/budget')).status).toBe(404);
  });

  it('runs keyless: approved requests stay AUTO_APPROVED and the dashboard says so', async () => {
    const { app } = setup({ executor: false });
    const body = (await (await postJson(app, '/api/requests', notebook)).json()) as ApiRequest;
    expect(body.status).toBe('AUTO_APPROVED');
    expect(body.payment).toBeNull();
    expect(await (await app.request('/')).text()).toContain('Keyless mode');
  });
});

describe('owner dashboard', () => {
  it('shows the held request with its reasons and lets the owner approve it', async () => {
    const { app, repo, published } = setup();
    const held = (await (await postJson(app, '/api/requests', microscope)).json()) as ApiRequest;
    const overview = await (await app.request('/')).text();
    expect(overview).toContain('Waiting for you (1)');
    expect(overview).toContain('MERCHANT_NOT_ALLOWED');
    expect(overview).toContain(`/requests/${held.request_id}/approve`);

    const res = await postForm(app, `/requests/${held.request_id}/approve`);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain(`/requests/${held.request_id}`);
    expect(repo.getRequest(held.request_id)?.status).toBe('PAID');
    expect(published.map((e) => e.type)).toEqual(['request.decided', 'owner.approved', 'payment.captured']);
    expect(await (await app.request('/')).text()).toContain('Nothing is waiting');
  });

  it('lets the owner deny with a note, and refuses to decide twice', async () => {
    const { app, repo } = setup();
    const held = (await (await postJson(app, '/api/requests', microscope)).json()) as ApiRequest;
    const res = await postForm(app, `/requests/${held.request_id}/deny`, { note: 'not this month' });
    expect(res.status).toBe(303);
    expect(repo.getRequest(held.request_id)?.status).toBe('DENIED');
    expect(repo.listAudit({ requestId: held.request_id })[0]).toMatchObject({ actor: 'owner', action: 'owner.denied', details: { note: 'not this month' } });
    expect((await postForm(app, `/requests/${held.request_id}/approve`)).status).toBe(409);
  });

  it('refunds a paid request from its page', async () => {
    const { app, repo, published } = setup();
    const paid = (await (await postJson(app, '/api/requests', notebook)).json()) as ApiRequest;
    const page = await (await app.request(`/requests/${paid.request_id}`)).text();
    expect(page).toContain(`/requests/${paid.request_id}/refund`);
    const res = await postForm(app, `/requests/${paid.request_id}/refund`);
    expect(res.status).toBe(303);
    expect(repo.getRequest(paid.request_id)?.status).toBe('REFUNDED');
    expect(published.at(-1)?.type).toBe('payment.refunded');
    expect(await (await app.request(`/requests/${paid.request_id}`)).text()).toContain('R-fake');
  });

  it('escapes everything the agent wrote, on every page that shows it', async () => {
    const { app } = setup();
    const hostile = { ...microscope, merchant: '<script>alert(1)</script>', item: 'x" onmouseover="alert(2)', reason: '<img src=x onerror=alert(3)>', source_url: 'javascript:alert(4)' };
    const held = (await (await postJson(app, '/api/requests', hostile)).json()) as ApiRequest;
    for (const path of ['/', `/requests/${held.request_id}`, '/audit']) {
      const body = await (await app.request(path)).text();
      expect(body).not.toContain('<script>alert(1)');
      expect(body).not.toContain('<img src=x');
      expect(body).not.toContain('href="javascript:');
      expect(body).toContain('&lt;script&gt;');
    }
  });

  it('answers 404 for unknown requests and agents', async () => {
    const { app } = setup();
    expect((await app.request('/requests/req_nope')).status).toBe(404);
    expect((await app.request('/policies/ghost')).status).toBe(404);
  });

  it('streams server-sent events', async () => {
    const { app, events } = setup();
    const before = events.subscriberCount; // the test's own recorder
    const res = await app.request('/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(events.subscriberCount).toBe(before + 1);
    await res.body?.cancel();
    await vi.waitFor(() => expect(events.subscriberCount).toBe(before));
  });
});

describe('policy editor', () => {
  it('saves valid rules and rejects invalid ones with a message', async () => {
    const { app, repo, published } = setup();
    const ok = await postForm(app, `/policies/${DEMO_AGENT_ID}`, {
      currency: 'usd',
      max_tx: '25.00',
      hard_max_tx: '',
      monthly_budget: '80.00',
      merchants: 'Synthetic Books, Synthetic Supplies, Synthetic Gadgets',
      categories: '',
      hours_start: '09:00',
      hours_end: '18:00',
      timezone: 'Asia/Tokyo',
      hold_new: '1',
    });
    expect(ok.status).toBe(303);
    expect(repo.getPolicy(DEMO_AGENT_ID)).toMatchObject({ currency: 'USD', maxTxMinor: 2500, hardMaxTxMinor: null, monthlyBudgetMinor: 8000, merchantAllowlist: ['synthetic books', 'synthetic supplies', 'synthetic gadgets'], hours: { start: '09:00', end: '18:00' } });
    expect(published.at(-1)?.type).toBe('policy.saved');
    expect(await (await app.request(`/policies/${DEMO_AGENT_ID}?saved=1`)).text()).toContain('Saved.');

    const bad = await postForm(app, `/policies/${DEMO_AGENT_ID}`, { currency: 'USD', max_tx: 'lots', monthly_budget: '80.00', timezone: 'Mars/Olympus', hours_start: '09:00', hours_end: '' });
    expect(bad.status).toBe(400);
    const text = await bad.text();
    expect(text).toContain('max per purchase must look like');
    expect(text).toContain('give both hours or neither');
    expect(repo.getPolicy(DEMO_AGENT_ID)?.maxTxMinor).toBe(2500);
  });
});

describe('PayPal link flow', () => {
  const VAULT = 'VAULTIDFROMFAKEPAYPAL0001';
  const cfg: PayPalConfig = { baseUrl: PAYPAL_SANDBOX_BASE_URL, clientId: 'AclientIdValue00000000000000', clientSecret: 'EsuperSecretValue0000000000000' };
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  function fakePayPal() {
    const calls: Array<{ url: string; body: string | undefined }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/oauth2/token')) return json({ access_token: 'A21AAfakeAccessTokenValue000000', expires_in: 3600 });
      calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
      if (url.endsWith('/v3/vault/setup-tokens')) return json({ id: 'ST1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/agreements/approve?approval_session_id=ST1' }] }, 201);
      if (url.endsWith('/v3/vault/setup-tokens/ST1')) return json({ id: 'ST1', status: 'APPROVED' });
      if (url.endsWith('/v3/vault/payment-tokens')) return json({ id: VAULT, customer: { id: 'cust1' } }, 201);
      return json({ name: 'NOT_FOUND', message: url }, 404);
    });
    return { calls, client: new PayPalClient(cfg, { fetch: fetchMock as unknown as typeof fetch }) };
  }

  it('sends the owner to PayPal, then turns the approved setup token into the active mandate', async () => {
    const { calls, client } = fakePayPal();
    const { app, repo, published } = setup({ paypal: client });
    expect(await (await app.request('/paypal')).text()).toContain('Not linked');

    const start = await postForm(app, '/paypal/link');
    expect(start.status).toBe(303);
    expect(start.headers.get('location')).toBe('https://www.sandbox.paypal.com/agreements/approve?approval_session_id=ST1');
    const setupBody = JSON.parse(calls[0]?.body ?? '{}') as { payment_source: { paypal: { experience_context: { return_url: string } } } };
    const returnUrl = new URL(setupBody.payment_source.paypal.experience_context.return_url);
    expect(returnUrl.origin + returnUrl.pathname).toBe('http://localhost:3000/paypal/return');

    const back = await app.request(`/paypal/return?link=${returnUrl.searchParams.get('link')}`);
    expect(back.status).toBe(303);
    expect(back.headers.get('location')).toContain('Linked');
    const mandate = repo.activeMandate();
    expect(mandate?.paypalVaultId).toBe(VAULT);
    expect(published.at(-1)?.type).toBe('mandate.linked');

    const page = await (await app.request('/paypal')).text();
    expect(page).toContain('Linked. Active mandate');
    expect(page).not.toContain(VAULT);
    expect(JSON.stringify(repo.listAudit())).not.toContain(VAULT);
    expect((await app.request('/paypal/return?link=stale')).headers.get('location')).toContain('Unknown');
  });

  it('is disabled without PayPal credentials', async () => {
    const { app } = setup();
    expect((await postForm(app, '/paypal/link')).status).toBe(503);
    expect(await (await app.request('/paypal')).text()).toContain('needs PayPal sandbox credentials');
  });
});

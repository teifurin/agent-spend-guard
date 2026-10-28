import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';
import { Repo } from '../../src/db/repo.js';
import { ExecutorError, PayPalExecutor } from '../../src/guard/executor.js';
import { PayPalClient } from '../../src/paypal/client.js';
import { PAYPAL_SANDBOX_BASE_URL, type PayPalConfig } from '../../src/paypal/env.js';
import { captureRequestId, orderRequestId, refundRequestId } from '../../src/paypal/orders.js';

const NOW = Date.UTC(2026, 9, 28, 3, 0); // 2026-10-28 12:00 Asia/Tokyo
const VAULT_ID = 'VAULTSECRETID1234567890';
const cfg: PayPalConfig = { baseUrl: PAYPAL_SANDBOX_BASE_URL, clientId: 'AclientIdValue00000000000000', clientSecret: 'EsuperSecretValue0000000000000' };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

type Handler = (call: Call, n: number) => Response | Promise<Response>;

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const tokenResponse = (): Response => json({ access_token: 'A21AAfakeAccessTokenValue000000', expires_in: 3600, token_type: 'Bearer' });
const completedOrder = (orderId: string, captureId: string, captureStatus = 'COMPLETED') =>
  json({ id: orderId, status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: captureId, status: captureStatus }] } }] }, 201);

/** A fake PayPal: the OAuth call always succeeds, everything else goes to the handler (which only sees API calls). */
function fakePayPal(handler: Handler) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/v1/oauth2/token')) return tokenResponse();
    const call: Call = { url, method: init?.method ?? 'GET', headers: (init?.headers as Record<string, string>) ?? {}, body: typeof init?.body === 'string' ? init.body : undefined };
    calls.push(call);
    return handler(call, calls.length);
  });
  return { calls, fetch: fetchMock as unknown as typeof fetch };
}

function setup(handler: Handler, opts: { mandate?: boolean; amountMinor?: number } = {}) {
  const repo = new Repo(openDatabase(), () => NOW);
  const logs: string[] = [];
  const paypal = fakePayPal(handler);
  const client = new PayPalClient(cfg, { fetch: paypal.fetch, log: (l) => logs.push(l) });
  const executor = new PayPalExecutor({ client, repo, now: () => NOW, log: (l) => logs.push(l) });
  repo.createAgent({ id: 'research-bot', name: 'Research bot' });
  repo.savePolicy({ agentId: 'research-bot', currency: 'USD', maxTxMinor: 3000, hardMaxTxMinor: null, monthlyBudgetMinor: 10000, merchantAllowlist: null, categoryAllowlist: null, hours: null, timezone: 'Asia/Tokyo', holdNewMerchants: false });
  if (opts.mandate !== false) repo.saveMandate({ paypalVaultId: VAULT_ID, paypalCustomerId: 'cust1' });
  const request = repo.createRequest({ agentId: 'research-bot', merchant: 'Synthetic Books', item: 'Field notebook', category: 'books', amountMinor: opts.amountMinor ?? 1200, currency: 'USD', reason: 'notes' });
  repo.setRequestStatus(request.id, 'AUTO_APPROVED');
  return { repo, executor, request, calls: paypal.calls, logs };
}

/** Everything the executor wrote anywhere a human or a log reader could see it. */
function everythingVisible(repo: Repo, logs: string[]): string {
  const audit = JSON.stringify(repo.listAudit());
  const payments = JSON.stringify(repo.db.prepare('SELECT * FROM payments').all());
  const requests = JSON.stringify(repo.db.prepare('SELECT * FROM requests').all());
  return [audit, payments, requests, ...logs].join('\n');
}

describe('PayPalExecutor.charge', () => {
  it('charges the vault, settles a COMPLETED-on-create order and marks the request PAID', async () => {
    const { repo, executor, request, calls, logs } = setup(() => completedOrder('O1', 'C1'));
    const payment = await executor.charge(request.id);

    expect(payment.status).toBe('COMPLETED');
    expect(payment).toMatchObject({ paypalOrderId: 'O1', paypalCaptureId: 'C1', capturedAt: NOW, amountMinor: 1200, currency: 'USD' });
    expect(repo.getRequest(request.id)?.status).toBe('PAID');
    expect(repo.spentThisMonthMinor('research-bot', NOW, 'Asia/Tokyo')).toBe(1200);

    expect(calls.length).toBe(1);
    const order = calls[0];
    expect(order?.method).toBe('POST');
    expect(order?.url).toBe(`${PAYPAL_SANDBOX_BASE_URL}/v2/checkout/orders`);
    expect(order?.headers['PayPal-Request-Id']).toBe(orderRequestId(request.id));
    const body = JSON.parse(order?.body ?? '{}') as { payment_source: { paypal: { vault_id: string } }; purchase_units: Array<{ invoice_id: string; amount: { value: string } }> };
    expect(body.payment_source.paypal.vault_id).toBe(VAULT_ID);
    expect(body.purchase_units[0]?.invoice_id).toBe(`ASG-${request.id}`);
    expect(body.purchase_units[0]?.amount.value).toBe('12.00');

    const actions = repo.listAudit({ requestId: request.id }).map((a) => a.action);
    expect(actions).toEqual(['payment.captured', 'payment.started']);
    expect(everythingVisible(repo, logs)).not.toContain(VAULT_ID);
  });

  it('captures explicitly when the order comes back APPROVED', async () => {
    const { repo, executor, request, calls } = setup((call) => (call.url.endsWith('/capture') ? completedOrder('O2', 'C2') : json({ id: 'O2', status: 'APPROVED' }, 201)));
    const payment = await executor.charge(request.id);
    expect(payment.status).toBe('COMPLETED');
    expect(payment.paypalCaptureId).toBe('C2');
    expect(calls.map((c) => c.url.replace(PAYPAL_SANDBOX_BASE_URL, ''))).toEqual(['/v2/checkout/orders', '/v2/checkout/orders/O2/capture']);
    expect(calls[1]?.headers['PayPal-Request-Id']).toBe(captureRequestId(request.id, 'O2'));
    expect(repo.getRequest(request.id)?.status).toBe('PAID');
  });

  it('records a PayPal rejection as PAYMENT_FAILED, frees the budget and keeps the vault id out of the audit log', async () => {
    const { repo, executor, request, calls, logs } = setup(() =>
      json({ name: 'UNPROCESSABLE_ENTITY', message: `cannot charge ${VAULT_ID}`, debug_id: 'dbg1', details: [{ issue: 'INSTRUMENT_DECLINED', description: `token ${VAULT_ID} declined` }] }, 422),
    );
    const payment = await executor.charge(request.id);
    expect(payment.status).toBe('FAILED');
    expect(payment.paypalOrderId).toBeNull();
    expect(repo.getRequest(request.id)?.status).toBe('PAYMENT_FAILED');
    expect(repo.spentThisMonthMinor('research-bot', NOW, 'Asia/Tokyo')).toBe(0);
    expect(calls.length).toBe(1);

    const failed = repo.listAudit({ requestId: request.id }).find((a) => a.action === 'payment.failed');
    expect(failed?.details['reason']).toBe('PayPal 422 UNPROCESSABLE_ENTITY [INSTRUMENT_DECLINED] debug_id=dbg1');
    expect(everythingVisible(repo, logs)).not.toContain(VAULT_ID);
  });

  it('fails when the vaulted wallet needs the buyer (PAYER_ACTION_REQUIRED), keeping the order id', async () => {
    const { repo, executor, request } = setup(() => json({ id: 'O3', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/x' }] }, 200));
    const payment = await executor.charge(request.id);
    expect(payment.status).toBe('FAILED');
    expect(payment.paypalOrderId).toBe('O3');
    const failed = repo.listAudit({ requestId: request.id }).find((a) => a.action === 'payment.failed');
    expect(String(failed?.details['reason'])).toContain('PAYER_ACTION_REQUIRED');
  });

  it('treats a capture that is not COMPLETED as a failure and records its id', async () => {
    const { executor, request } = setup(() => completedOrder('O4', 'C4', 'DECLINED'));
    const payment = await executor.charge(request.id);
    expect(payment.status).toBe('FAILED');
    expect(payment.paypalCaptureId).toBe('C4');
  });

  it('records a network failure as PAYMENT_FAILED', async () => {
    const { repo, executor, request } = setup(() => {
      throw new TypeError('fetch failed');
    });
    const payment = await executor.charge(request.id);
    expect(payment.status).toBe('FAILED');
    const failed = repo.listAudit({ requestId: request.id }).find((a) => a.action === 'payment.failed');
    expect(failed?.details['reason']).toBe('TypeError: fetch failed');
  });

  it('fails without any PayPal call when the owner has not linked PayPal', async () => {
    const { repo, executor, request, calls } = setup(() => completedOrder('O5', 'C5'), { mandate: false });
    const payment = await executor.charge(request.id);
    expect(payment.status).toBe('FAILED');
    expect(repo.getRequest(request.id)?.status).toBe('PAYMENT_FAILED');
    expect(calls.length).toBe(0);
    const failed = repo.listAudit({ requestId: request.id }).find((a) => a.action === 'payment.failed');
    expect(String(failed?.details['reason'])).toContain('no active mandate');
  });

  it('refuses requests that are not approved and returns the payment of an already paid one', async () => {
    const { repo, executor, request, calls } = setup(() => completedOrder('O6', 'C6'));
    repo.setRequestStatus(request.id, 'HELD');
    await expect(executor.charge(request.id)).rejects.toBeInstanceOf(ExecutorError);
    await expect(executor.charge('req_nope')).rejects.toThrow('unknown request');
    expect(calls.length).toBe(0);

    repo.setRequestStatus(request.id, 'APPROVED');
    const first = await executor.charge(request.id);
    const again = await executor.charge(request.id);
    expect(again).toEqual(first);
    expect(calls.length).toBe(1);
  });

  it('resumes after a crash: an order id already recorded is looked up, never re-created', async () => {
    const { repo, executor, request, calls } = setup((call) => (call.method === 'GET' ? completedOrder('O7', 'C7') : json({ name: 'SHOULD_NOT_HAPPEN', message: 'duplicate order' }, 500)));
    const started = repo.beginPayment(request.id);
    repo.updatePayment(started.id, { paypalOrderId: 'O7' });

    const payment = await executor.charge(request.id);
    expect(payment.status).toBe('COMPLETED');
    expect(payment.paypalCaptureId).toBe('C7');
    expect(calls.map((c) => `${c.method} ${c.url.replace(PAYPAL_SANDBOX_BASE_URL, '')}`)).toEqual(['GET /v2/checkout/orders/O7']);
  });
});

describe('PayPalExecutor.refund', () => {
  it('refunds the capture, marks the request REFUNDED and gives the budget back', async () => {
    const { repo, executor, request, calls } = setup((call) => (call.url.includes('/refund') ? json({ id: 'R1', status: 'COMPLETED' }, 201) : completedOrder('O8', 'C8')));
    await executor.charge(request.id);
    const refunded = await executor.refund(request.id);

    expect(refunded.status).toBe('REFUNDED');
    expect(refunded.paypalRefundId).toBe('R1');
    expect(repo.getRequest(request.id)?.status).toBe('REFUNDED');
    expect(repo.spentThisMonthMinor('research-bot', NOW, 'Asia/Tokyo')).toBe(0);
    const refund = calls[1];
    expect(refund?.url).toBe(`${PAYPAL_SANDBOX_BASE_URL}/v2/payments/captures/C8/refund`);
    expect(refund?.headers['PayPal-Request-Id']).toBe(refundRequestId(request.id, 'C8'));
    expect(repo.listAudit({ requestId: request.id })[0]?.action).toBe('payment.refunded');
    expect(await executor.refund(request.id)).toEqual(refunded);
  });

  it('leaves the payment COMPLETED and throws when PayPal rejects the refund', async () => {
    const { repo, executor, request } = setup((call) => (call.url.includes('/refund') ? json({ name: 'UNPROCESSABLE_ENTITY', message: 'no', details: [{ issue: 'REFUND_NOT_ALLOWED' }] }, 422) : completedOrder('O9', 'C9')));
    await executor.charge(request.id);
    await expect(executor.refund(request.id)).rejects.toThrow('REFUND_NOT_ALLOWED');
    expect(repo.paymentForRequest(request.id)?.status).toBe('COMPLETED');
    expect(repo.getRequest(request.id)?.status).toBe('PAID');
    expect(repo.listAudit({ requestId: request.id })[0]?.action).toBe('refund.failed');
  });

  it('refuses to refund a request that was never paid', async () => {
    const { executor, request } = setup(() => completedOrder('O10', 'C10'));
    await expect(executor.refund(request.id)).rejects.toThrow('has no payment');
  });
});

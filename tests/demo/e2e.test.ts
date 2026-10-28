import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';
import { Repo } from '../../src/db/repo.js';
import { E2E_SCENARIOS, runE2E } from '../../src/demo/e2e.js';
import { createFakePayPal, FAKE_PAYPAL_CONFIG } from '../../src/demo/fake-paypal.js';
import { DEMO_AGENT_ID, seedDemo } from '../../src/demo/seed.js';
import { PayPalExecutor } from '../../src/guard/executor.js';
import { Guard } from '../../src/guard/pipeline.js';
import { PayPalClient } from '../../src/paypal/client.js';
import { createMockReviewer } from '../../src/review/mock.js';
import { createPageFetcher } from '../../src/review/page.js';
import { createShopApp } from '../../src/shop/app.js';

const NOW = Date.UTC(2026, 9, 28, 3, 0); // 12:00 Asia/Tokyo, inside the demo hours
const SHOP = 'http://localhost:3001';
const VAULT_ID = 'VAULTSECRETID1234567890';

const shop = createShopApp();
const shopFetch = (async (input: string | URL | Request, init?: RequestInit) => shop.request(String(input), init)) as unknown as typeof fetch;
const json = (body: unknown, status: number): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** The run as the script wires it offline, with the fake PayPal optionally refusing refunds. */
function setup(opts: { refundStatus?: number } = {}) {
  const repo = new Repo(openDatabase(), () => NOW);
  seedDemo(repo);
  repo.saveMandate({ paypalVaultId: VAULT_ID, paypalCustomerId: null });
  const fake = createFakePayPal();
  let calls = 0;
  const paypalFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls++;
    if (opts.refundStatus !== undefined && /\/refund$/.test(String(input))) {
      return json({ name: 'UNPROCESSABLE_ENTITY', message: 'The requested action could not be performed.', debug_id: 'dbg-refund', details: [{ issue: 'REFUND_FAILED_INSUFFICIENT_FUNDS' }] }, opts.refundStatus);
    }
    return fake.fetch(input, init);
  }) as unknown as typeof fetch;
  const logs: string[] = [];
  const log = (line: string): void => {
    logs.push(line);
  };
  const client = new PayPalClient(FAKE_PAYPAL_CONFIG, { fetch: paypalFetch, now: () => NOW, log });
  const executor = new PayPalExecutor({ client, repo, now: () => NOW, log });
  const reviewer = createMockReviewer({ repo, fetchPage: createPageFetcher({ allowedOrigins: [SHOP], fetch: shopFetch }) });
  const guard = new Guard({ repo, executor, reviewer, now: () => NOW });
  const run = (skipRefund = false) => runE2E({ repo, guard, executor, shopUrl: SHOP, shopFetch, paypalCalls: () => calls, log, skipRefund, now: () => NOW });
  return { repo, fake, logs, run };
}

describe('the end-to-end run against the fake PayPal', () => {
  it('plays the four scenarios, the owner decisions and the refunds exactly as the README promises', async () => {
    const { repo, fake, logs, run } = setup();
    const report = await run();

    expect(report.ok).toBe(true);
    expect(report.scenarios.map((s) => [s.n, s.decided, s.decidedBy, s.ownerAction, s.status, s.ok])).toEqual([
      [1, 'PAID', 'policy', null, 'PAID', true],
      [2, 'HELD', 'policy', 'approve', 'PAID', true],
      [3, 'BLOCKED', 'reviewer', null, 'BLOCKED', true],
      [4, 'HELD', 'reviewer', 'deny', 'DENIED', true],
    ]);
    expect(report.scenarios.map((s) => s.amountMinor)).toEqual([1200, 4500, 9900, 2900]);
    expect(report.scenarios[1]?.reasons).toEqual(expect.arrayContaining(['OVER_TX_CAP', 'MERCHANT_NOT_ALLOWED']));
    expect(report.scenarios[2]?.flags).toEqual(['PROMPT_INJECTION_SUSPECTED', 'CLAIMS_OWNER_APPROVAL', 'UNUSUAL_QUANTITY']);
    expect(report.scenarios[2]?.paypalCalls).toBe(0);
    expect(report.scenarios[3]?.flags).toEqual(['PRICE_ANOMALY']);
    expect(report.scenarios[3]?.explanation).toContain('2.4×');

    // Two charges, two refunds, nothing else reached PayPal.
    expect(fake.calls.map((c) => `${c.method} ${c.path.replace(/CAPTURE-OFFLINE-\d+/, 'id')}`)).toEqual([
      'POST /v2/checkout/orders',
      'POST /v2/checkout/orders',
      'POST /v2/payments/captures/id/refund',
      'POST /v2/payments/captures/id/refund',
    ]);
    expect(report.refunds.map((r) => [r.n, r.ok, r.refundId !== null])).toEqual([
      [1, true, true],
      [2, true, true],
    ]);
    expect(
      repo
        .listRequests({ agentId: DEMO_AGENT_ID })
        .map((r) => r.status)
        .sort(),
    ).toEqual(['BLOCKED', 'DENIED', 'REFUNDED', 'REFUNDED']);
    expect(report.spentMinor).toBe(0); // refunded captures no longer count
    expect(repo.listAudit({ requestId: report.scenarios[1]?.requestId ?? '' }).map((a) => a.action)).toContain('owner.approved');
    expect(repo.listAudit({ requestId: report.scenarios[3]?.requestId ?? '' }).map((a) => a.action)).toContain('owner.denied');

    // Nothing the run printed carries the vault id or the fake credentials.
    const printed = logs.join('\n');
    expect(printed).not.toContain(VAULT_ID);
    expect(printed).not.toContain(FAKE_PAYPAL_CONFIG.clientSecret);
    expect(printed).toContain('[ok] scenario 3 went as expected');
  });

  it('keeps the captures with skipRefund and counts them against the budget', async () => {
    const { repo, run } = setup();
    const report = await run(true);
    expect(report.ok).toBe(true);
    expect(report.refunds).toEqual([]);
    expect(report.spentMinor).toBe(5700);
    expect(repo.listRequests({ agentId: DEMO_AGENT_ID, status: 'PAID' }).length).toBe(2);
  });

  it('reports a failed refund without hiding what the scenarios did', async () => {
    const { run } = setup({ refundStatus: 422 });
    const report = await run();
    expect(report.ok).toBe(false);
    expect(report.scenarios.every((s) => s.ok)).toBe(true);
    expect(report.refunds.map((r) => r.ok)).toEqual([false, false]);
    expect(report.refunds[0]?.problem).toContain('REFUND_FAILED_INSUFFICIENT_FUNDS');
  });

  it('matches the scenarios the demo agent plays', () => {
    expect(E2E_SCENARIOS.map((s) => s.slug)).toEqual(['field-notebook-a5', 'usb-microscope', 'premium-pens-set', 'field-notebook-a5-marked-up']);
  });
});

describe('npm run e2e:offline', () => {
  it('exits 0, uses the mock reviewer whatever the environment says, and prints the verdict', () => {
    const out = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/e2e-sandbox.ts', '--offline'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'offline-ignores-this-value', LLM_MODEL: 'not-used' },
    });
    expect(out).toContain('mode: OFFLINE');
    expect(out).toContain('reviewer: mock (deterministic rules, no model)');
    expect(out).toContain('VERDICT: 4/4 scenarios as expected, 2/2 refunds completed.');
    expect(out).toContain('PayPal calls in this run: 5'); // token + two orders + two refunds
    expect(out).not.toContain('offline-ignores-this-value');
  }, 60_000);
});

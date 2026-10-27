/**
 * M0 spike: proves end-to-end money movement on the PayPal SANDBOX in one sitting, in two modes.
 *
 *   --mode vault  (Plan A)  OAuth -> setup token -> owner approves ONCE in PayPal -> payment token (vault_id)
 *                           -> Orders v2 create (+capture) with vault_id, buyer absent -> refund
 *   --mode order  (Plan B)  OAuth -> Orders v2 create -> owner approves THIS order in PayPal -> capture -> refund
 *
 * Prints statuses, PayPal object ids and a masked vault id. Never prints credentials or tokens.
 *
 *   npm run spike:vault
 *   npm run spike:order
 *   npx tsx scripts/spike-vault.ts --mode vault --amount 1.00 [--skip-refund] [--reuse]
 *
 * --reuse  (vault mode) charges the vault_id saved in .spike-state.json by an earlier run, skipping approval.
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { loadDotEnv } from '../src/config/env.js';
import { loadPayPalConfig } from '../src/paypal/env.js';
import { PayPalApiError, PayPalClient, requestIdFor } from '../src/paypal/client.js';
import { mask } from '../src/paypal/redact.js';

const STATE_FILE = '.spike-state.json'; // gitignored; holds the vault id from a successful vault run
const APPROVAL_TIMEOUT_MS = 10 * 60_000;

type Mode = 'vault' | 'order';

interface Args {
  mode: Mode;
  amount: string;
  skipRefund: boolean;
  reuse: boolean;
}

interface Ctx {
  client: PayPalClient;
  args: Args;
  runId: string;
  port: number;
  returnBase: string;
  localListener: boolean;
}

interface Link {
  rel: string;
  href: string;
  method?: string;
}
interface SetupToken {
  id: string;
  status: string;
  links?: Link[];
}
interface PaymentToken {
  id: string;
  customer?: { id?: string };
}
interface Capture {
  id: string;
  status: string;
}
interface Order {
  id: string;
  status: string;
  links?: Link[];
  purchase_units?: Array<{ payments?: { captures?: Capture[] } }>;
}
interface Refund {
  id: string;
  status: string;
}
interface SpikeState {
  vaultId: string;
  customerId?: string;
  createdAt: string;
}

/** Thrown when the vault path demands buyer presence: Plan A is not viable on this app, Plan B is. */
class PlanBSignal extends Error {}

const steps: Array<[string, string]> = [];
let currentMode: Mode = 'vault';

function step(name: string, outcome: string): void {
  steps.push([name, outcome]);
  console.log(`[ok] ${name}: ${outcome}`);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { mode: 'vault', amount: '1.00', skipRefund: false, reuse: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode') {
      const m = argv[++i];
      if (m !== 'vault' && m !== 'order') throw new Error('--mode must be "vault" or "order"');
      args.mode = m;
    } else if (a === '--amount') {
      const v = argv[++i];
      if (!v || !/^\d+\.\d{2}$/.test(v)) throw new Error('--amount must look like 1.00');
      args.amount = v;
    } else if (a === '--skip-refund') {
      args.skipRefund = true;
    } else if (a === '--reuse') {
      args.reuse = true;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  currentMode = args.mode;
  loadDotEnv();
  const cfg = loadPayPalConfig();
  const client = new PayPalClient(cfg, { log: (line) => console.log(`     ${line}`) });
  const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14); // yyyymmddhhmmss
  const port = Number(process.env.SPIKE_PORT ?? 8787);
  const returnBase = process.env.SPIKE_RETURN_BASE ?? `http://127.0.0.1:${port}`;
  const ctx: Ctx = { client, args, runId, port, returnBase, localListener: returnBase.startsWith('http://127.0.0.1') };

  console.log(`agent-spend-guard M0 spike | mode=${args.mode} | amount=${args.amount} USD | PayPal SANDBOX only | run ${runId}`);
  await client.getAccessToken();
  step('oauth', 'ok');

  const captureId = args.mode === 'vault' ? await runVault(ctx) : await runOrder(ctx);

  if (args.skipRefund) {
    step('refund', 'skipped (--skip-refund)');
  } else {
    const { data } = await client.request<Refund>('POST', `/v2/payments/captures/${captureId}/refund`, {
      body: {},
      requestId: requestIdFor('refund', `${runId}:${captureId}`),
    });
    step('refund', `${data.status} id=${data.id}`);
  }
  printSummary(args.mode, 'success');
}

async function runVault(ctx: Ctx): Promise<string> {
  const { client, args, runId } = ctx;
  let vaultId: string;
  const saved = readState();

  if (args.reuse && saved) {
    vaultId = saved.vaultId;
    client.redactor.add(vaultId);
    step('payment-token', `reusing vault_id ${mask(vaultId)} saved ${saved.createdAt} in ${STATE_FILE}`);
  } else {
    const { data: setup } = await client.request<SetupToken>('POST', '/v3/vault/setup-tokens', {
      requestId: requestIdFor('setup-token', runId),
      body: {
        payment_source: {
          paypal: {
            description: 'agent-spend-guard: one-time mandate letting the guard charge policy-approved agent purchases (sandbox demo)',
            usage_type: 'MERCHANT',
            customer_type: 'CONSUMER',
            usage_pattern: 'IMMEDIATE',
            permit_multiple_payment_tokens: false,
            experience_context: {
              brand_name: 'agent-spend-guard (sandbox)',
              locale: 'en-US',
              shipping_preference: 'NO_SHIPPING',
              payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
              return_url: `${ctx.returnBase}/return`,
              cancel_url: `${ctx.returnBase}/cancel`,
            },
          },
        },
      },
    });
    step('setup-token create', `${setup.status} id=${setup.id}`);

    const approveUrl = linkOf(setup.links, 'approve');
    if (!approveUrl) throw new Error('setup token response has no "approve" link');
    const status = async (): Promise<string> =>
      (await client.request<SetupToken>('GET', `/v3/vault/setup-tokens/${setup.id}`)).data.status;
    await waitForApproval(ctx, approveUrl, async () => (await status()) === 'APPROVED');
    const finalStatus = await status();
    step('setup-token status', finalStatus);
    if (finalStatus !== 'APPROVED') {
      throw new Error(`setup token is ${finalStatus}, expected APPROVED. Approve it with the SANDBOX personal (buyer) account, then rerun.`);
    }

    const { data: pt } = await client.request<PaymentToken>('POST', '/v3/vault/payment-tokens', {
      requestId: requestIdFor('payment-token', runId),
      body: { payment_source: { token: { id: setup.id, type: 'SETUP_TOKEN' } } },
    });
    vaultId = pt.id;
    client.redactor.add(vaultId);
    writeState({ vaultId, customerId: pt.customer?.id, createdAt: new Date().toISOString() });
    step('payment-token create', `id=${mask(vaultId)} customer=${pt.customer?.id ?? '-'} (vault id saved to ${STATE_FILE})`);
  }

  const { data: order } = await client.request<Order>('POST', '/v2/checkout/orders', {
    requestId: requestIdFor('order', runId),
    body: orderBody(args.amount, runId, { paypal: { vault_id: vaultId } }),
  });
  step('order create (vault_id, buyer absent)', `${order.status} id=${order.id}`);

  if (order.status === 'COMPLETED') {
    const cap = captureOf(order);
    if (!cap) throw new Error('order is COMPLETED but has no capture object');
    step('capture', `${cap.status} id=${cap.id} (captured on create)`);
    return cap.id;
  }
  if (order.status === 'APPROVED' || order.status === 'CREATED') {
    const captured = await captureOrder(client, order.id, runId);
    const cap = captureOf(captured);
    if (!cap) throw new Error(`capture returned ${captured.status} without a capture object`);
    step('capture', `${cap.status} id=${cap.id}`);
    return cap.id;
  }
  const link = linkOf(order.links, 'payer-action') ?? linkOf(order.links, 'approve');
  throw new PlanBSignal(
    `order created with vault_id came back ${order.status}${link ? ' with a payer-action link' : ''}: ` +
      'this sandbox app cannot charge the vaulted wallet while the buyer is absent.',
  );
}

async function runOrder(ctx: Ctx): Promise<string> {
  const { client, args, runId } = ctx;
  const { data: order } = await client.request<Order>('POST', '/v2/checkout/orders', {
    requestId: requestIdFor('order', runId),
    body: orderBody(args.amount, runId, {
      paypal: {
        experience_context: {
          brand_name: 'agent-spend-guard (sandbox)',
          locale: 'en-US',
          shipping_preference: 'NO_SHIPPING',
          user_action: 'PAY_NOW',
          return_url: `${ctx.returnBase}/return`,
          cancel_url: `${ctx.returnBase}/cancel`,
        },
      },
    }),
  });
  step('order create', `${order.status} id=${order.id}`);

  const approveUrl = linkOf(order.links, 'payer-action') ?? linkOf(order.links, 'approve');
  if (!approveUrl) throw new Error('order response has no "payer-action" / "approve" link');
  const status = async (): Promise<string> =>
    (await client.request<Order>('GET', `/v2/checkout/orders/${order.id}`)).data.status;
  await waitForApproval(ctx, approveUrl, async () => (await status()) === 'APPROVED');
  const finalStatus = await status();
  step('order status', finalStatus);
  if (finalStatus !== 'APPROVED') {
    throw new Error(`order is ${finalStatus}, expected APPROVED. Approve it with the SANDBOX personal (buyer) account, then rerun.`);
  }

  const captured = await captureOrder(client, order.id, runId);
  const cap = captureOf(captured);
  if (!cap) throw new Error(`capture returned ${captured.status} without a capture object`);
  step('capture', `${cap.status} id=${cap.id}`);
  return cap.id;
}

async function captureOrder(client: PayPalClient, orderId: string, runId: string): Promise<Order> {
  const { data } = await client.request<Order>('POST', `/v2/checkout/orders/${orderId}/capture`, {
    body: {},
    requestId: requestIdFor('capture', `${runId}:${orderId}`),
  });
  return data;
}

function captureOf(order: Order): Capture | undefined {
  return order.purchase_units?.[0]?.payments?.captures?.[0];
}

function linkOf(links: Link[] | undefined, rel: string): string | undefined {
  return links?.find((l) => l.rel === rel)?.href;
}

/** Every spike order is stamped so the owner's PayPal activity shows what it was. Same idea as the real executor. */
function orderBody(amount: string, runId: string, payment_source: Record<string, unknown>): Record<string, unknown> {
  return {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: 'default',
        description: 'agent-spend-guard sandbox spike (synthetic demo purchase, refunded right away)',
        custom_id: `asg:spike:${runId}`,
        invoice_id: `ASG-SPIKE-${runId}`,
        amount: { currency_code: 'USD', value: amount },
      },
    ],
    payment_source,
  };
}

async function waitForApproval(ctx: Ctx, approveUrl: string, isApproved: () => Promise<boolean>): Promise<void> {
  const ways = [
    ctx.localListener ? `the browser redirect to 127.0.0.1:${ctx.port} after approval` : undefined,
    process.stdin.isTTY ? 'pressing Enter here' : undefined,
    'the status poll (every ~12 s, up to 10 min)',
  ].filter((w): w is string => w !== undefined);

  console.log('');
  console.log('================================================================');
  console.log('ACTION REQUIRED: open this URL and approve with your SANDBOX *personal* (buyer) test account.');
  console.log('Its login is in the PayPal Developer Dashboard: Testing Tools > Sandbox Accounts > Personal > View/Edit.');
  console.log('');
  console.log(`  ${approveUrl}`);
  console.log('');
  console.log(`Waiting. Any of these ends the wait: ${ways.join('; ')}.`);
  console.log('================================================================');
  console.log('');

  const ac = new AbortController();
  const racers: Array<Promise<string>> = [pollUntil(isApproved, ac.signal), timeoutAfter(APPROVAL_TIMEOUT_MS, ac.signal)];
  if (ctx.localListener) racers.push(listenForReturn(ctx.port, ac.signal));
  if (process.stdin.isTTY) racers.push(waitForEnter(ac.signal));
  const winner = await Promise.race(racers);
  ac.abort();
  if (winner === 'timeout') throw new Error('timed out after 10 minutes waiting for approval');
  console.log(`     approval signal: ${winner}`);
  await sleep(2_000); // let PayPal's status catch up with the redirect
}

function listenForReturn(port: number, signal: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', `http://127.0.0.1:${port}`).pathname;
      const approved = path === '/return';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><title>agent-spend-guard spike</title><h2>${
          approved ? 'Approved. You can close this tab and go back to the terminal.' : 'Cancelled. Go back to the terminal.'
        }</h2>`,
      );
      if (path === '/return' || path === '/cancel') resolve(`browser redirect to ${path}`);
    });
    server.on('error', (e) => console.log(`     local listener unavailable (${e.message}); relying on Enter / status polling`));
    server.listen(port, '127.0.0.1');
    signal.addEventListener(
      'abort',
      () => {
        server.closeAllConnections();
        server.close();
      },
      { once: true },
    );
  });
}

function waitForEnter(signal: AbortSignal): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  signal.addEventListener('abort', () => rl.close(), { once: true });
  return rl.question('', { signal }).then(
    () => 'Enter pressed',
    () => new Promise<string>(() => {}),
  );
}

async function pollUntil(check: () => Promise<boolean>, signal: AbortSignal): Promise<string> {
  while (!signal.aborted) {
    await sleep(10_000 + Math.floor(Math.random() * 5_000), signal);
    if (signal.aborted) break;
    try {
      if (await check()) return 'status poll shows APPROVED';
    } catch (e) {
      console.log(`     status poll error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return new Promise<string>(() => {});
}

function timeoutAfter(ms: number, signal: AbortSignal): Promise<string> {
  return sleep(ms, signal).then(() => (signal.aborted ? new Promise<string>(() => {}) : 'timeout'));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

function readState(): SpikeState | undefined {
  if (!existsSync(STATE_FILE)) return undefined;
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as SpikeState;
  } catch {
    return undefined;
  }
}

function writeState(state: SpikeState): void {
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function hintFor(err: PayPalApiError): string | undefined {
  const blob = [err.paypalName, err.paypalMessage, ...err.details.map((d) => d.issue ?? '')].join(' ');
  if (err.status === 401 || /invalid_client/i.test(blob)) {
    return 'PayPal rejected the credentials. Check PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET in .env (sandbox app, not live).';
  }
  if (/VAULT|REFERENCE_TRANSACTION|BILLING_AGREEMENT/i.test(blob)) {
    return 'Vault / reference transactions are not enabled for this sandbox app or business account. Tick "Vault" under the app Advanced options, or create a fresh sandbox Business account + app, then retry. If it persists, Plan B (`npm run spike:order`) is the fallback.';
  }
  if (/PERMISSION_DENIED|NOT_AUTHORIZED|AUTHORIZATION_ERROR/i.test(blob)) {
    return 'The app lacks a permission for this call: enable "Accept payments" and "Vault" in the sandbox app settings.';
  }
  if (/DUPLICATE_INVOICE_ID|DUPLICATE_REQUEST_ID/i.test(blob)) {
    return 'Idempotency collision with a previous run. Just rerun: every run uses a fresh id.';
  }
  if (/INVALID_PARAMETER_SYNTAX|INVALID_STRING_LENGTH|MALFORMED_REQUEST|INVALID_PARAMETER_VALUE/i.test(blob)) {
    return 'PayPal rejected a field. If the issue names return_url / cancel_url, set SPIKE_RETURN_BASE=https://example.com in .env and rely on Enter / status polling.';
  }
  if (/INSTRUMENT_DECLINED|PAYER_CANNOT_PAY|TRANSACTION_REFUSED|PAYEE_ACCOUNT_RESTRICTED/i.test(blob)) {
    return 'The sandbox buyer account could not pay. Check its balance in the Developer Dashboard (Sandbox accounts) or create a new personal account.';
  }
  return undefined;
}

function printSummary(mode: Mode, outcome: 'success' | 'failure'): void {
  console.log('');
  console.log(`Summary (${mode} mode, ${outcome}):`);
  for (const [name, result] of steps) console.log(`  ${name.padEnd(40)} ${result}`);
  console.log('');
  if (outcome === 'success' && mode === 'vault') {
    console.log('VERDICT: Plan A works on this sandbox app: one approval, then a charge with the buyer absent, then a refund.');
    console.log('         Record it in docs/DECISIONS.md and build the executor on vault_id.');
  } else if (outcome === 'success') {
    console.log('VERDICT: Plan B works: approval of a single order in PayPal checkout, then capture and refund.');
    console.log('         Usable as the HOLD path (the owner approves inside PayPal) and as the fallback if vault is unavailable.');
  } else {
    console.log('VERDICT: not proven yet. Fix the error above and rerun; `npm run spike:order` exercises Plan B.');
  }
}

main().catch((err: unknown) => {
  console.error('');
  if (err instanceof PlanBSignal) {
    console.error(`[plan-b] ${err.message}`);
    console.error('         Next: run `npm run spike:order` to prove per-order approval (Plan B).');
  } else if (err instanceof PayPalApiError) {
    console.error(`[fail] ${err.message}`);
    for (const d of err.details) console.error(`       - ${[d.issue, d.field, d.description].filter(Boolean).join(' | ')}`);
    const hint = hintFor(err);
    if (hint) console.error(`       hint: ${hint}`);
  } else {
    console.error(`[fail] ${err instanceof Error ? err.message : String(err)}`);
  }
  printSummary(currentMode, 'failure');
  // Set the exit code instead of calling process.exit(): on Windows, exiting while undici's sockets are still
  // closing trips a libuv assertion (UV_HANDLE_CLOSING) and turns the exit code into 127.
  process.exitCode = 1;
});

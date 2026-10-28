/**
 * The four demo scenarios end to end, charge and refund included (HANDOFF §9, step 3).
 *
 *   npm run e2e:sandbox                           # the PayPal SANDBOX: needs .env and a linked mandate
 *   npm run e2e:offline                           # no account, no network: a fake PayPal, the mock reviewer, a pinned clock
 *   npm run e2e:sandbox -- --skip-refund          # keep the two captures in the sandbox business account
 *   npm run e2e:sandbox -- --mandate-from <db>    # copy the active mandate from this database (default: DB_PATH or data/guard.db)
 *   npm run e2e:sandbox -- --db <path>            # the throwaway database to run in (default: .tmp-e2e/guard-<time>.db)
 *
 *   1 the notebook            -> AUTO_APPROVE -> PAID
 *   2 the microscope          -> HELD by the rules -> the owner approves -> PAID
 *   3 the hostile pens page   -> BLOCKED by the reviewer, no PayPal call
 *   4 the repriced notebook   -> HELD by the reviewer (PRICE_ANOMALY) -> the owner denies
 *   then both captures are refunded.
 *
 * Sandbox mode runs in a fresh database, so the month's budget starts at zero and the dashboard's database is left
 * alone; it copies the active mandate into it, makes 5 to 7 PayPal calls (a token, one or two per charge, one per
 * refund) and honours LLM_PROVIDER: with anthropic that is one model call per request, four in all, no retries.
 * It refuses to run outside the demo hours (08:00-22:00 Asia/Tokyo), because scenario 1 would be held, not paid.
 * Every merchant, product and price is synthetic. Credentials, tokens and the vault id are never printed.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadDotEnv } from '../src/config/env.js';
import { openDatabase } from '../src/db/connection.js';
import { Repo } from '../src/db/repo.js';
import { type E2EReport, runE2E } from '../src/demo/e2e.js';
import { createFakePayPal, FAKE_PAYPAL_CONFIG } from '../src/demo/fake-paypal.js';
import { DEMO_AGENT_ID, DEMO_POLICY, seedDemo } from '../src/demo/seed.js';
import { formatAmount } from '../src/domain/money.js';
import { PayPalExecutor } from '../src/guard/executor.js';
import { Guard } from '../src/guard/pipeline.js';
import { PayPalApiError, PayPalClient } from '../src/paypal/client.js';
import { loadPayPalConfig } from '../src/paypal/env.js';
import { mask } from '../src/paypal/redact.js';
import { formatLocalTime, isWithinWindow, localMinutes, parseHHMM } from '../src/policy/time.js';
import { createReviewer, loadReviewConfig, type ReviewConfig } from '../src/review/index.js';
import { createShopApp } from '../src/shop/app.js';

/** 2026-10-28 12:00 Asia/Tokyo, inside the demo hours: an offline run gives the same answer at any hour of any day. */
const OFFLINE_NOW = Date.UTC(2026, 9, 28, 3, 0);

interface Args {
  offline: boolean;
  skipRefund: boolean;
  dbPath: string | undefined;
  mandateFrom: string | undefined;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { offline: false, skipRefund: false, dbPath: undefined, mandateFrom: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--offline') args.offline = true;
    else if (a === '--skip-refund') args.skipRefund = true;
    else if (a === '--db') args.dbPath = pathAfter(a, argv[++i]);
    else if (a === '--mandate-from') args.mandateFrom = pathAfter(a, argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function pathAfter(flag: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) throw new Error(`${flag} needs a path`);
  return value;
}

type Say = (line: string) => void;

interface Wiring {
  repo: Repo;
  client: PayPalClient;
  now: () => number;
  reviewConfig: ReviewConfig;
  /** PayPal calls so far, the token call included. */
  paypalCalls: () => number;
  header: string[];
}

/** Wraps a fetch so the run can say how many PayPal calls it made, and prove scenario 3 made none. */
function counting(fetchImpl: typeof fetch): { fetch: typeof fetch; count: () => number } {
  let n = 0;
  const wrapped = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    n++;
    return fetchImpl(input, init);
  }) as unknown as typeof fetch;
  return { fetch: wrapped, count: () => n };
}

function wireOffline(shopUrl: string, say: Say): Wiring {
  const now = (): number => OFFLINE_NOW;
  const repo = new Repo(openDatabase(), now);
  const counted = counting(createFakePayPal().fetch);
  const client = new PayPalClient(FAKE_PAYPAL_CONFIG, { fetch: counted.fetch, now, log: (line) => say(`[paypal] ${line}`) });
  const reviewConfig = loadReviewConfig({ LLM_PROVIDER: 'mock' }, { shopUrl });
  const mandate = repo.saveMandate({ paypalVaultId: 'offline-fake-vault-id', paypalCustomerId: null });
  return {
    repo,
    client,
    now,
    reviewConfig,
    paypalCalls: counted.count,
    header: [
      'mode: OFFLINE. A fake PayPal answers in-process (no network, no account); the reviewer is the mock whatever LLM_PROVIDER says;',
      `.env is not read; the database is in memory; the clock is pinned to 2026-10-28 ${formatLocalTime(OFFLINE_NOW, DEMO_POLICY.timezone)} ${DEMO_POLICY.timezone}, inside the demo hours.`,
      `mandate ${mandate.id}: a placeholder vault id.`,
    ],
  };
}

/** Returns undefined after explaining why the run cannot start; nothing has been sent to PayPal at that point. */
function wireSandbox(args: Args, shopUrl: string, say: Say): Wiring | undefined {
  const cfg = loadPayPalConfig(); // refuses anything but PAYPAL_ENV=SANDBOX, asks for the credentials
  const reviewConfig = loadReviewConfig(process.env, { shopUrl }); // fails closed, like the server
  const now = Date.now;
  const tz = DEMO_POLICY.timezone;

  const hours = DEMO_POLICY.hours;
  const start = hours ? parseHHMM(hours.start) : undefined;
  const end = hours ? parseHHMM(hours.end) : undefined;
  if (hours && start !== undefined && end !== undefined && !isWithinWindow(localMinutes(now(), tz), start, end)) {
    console.error(`[fail] it is ${formatLocalTime(now(), tz)} in ${tz}; the demo rules allow purchases only between ${hours.start} and ${hours.end}, so scenario 1 would be held instead of paid. Run this inside those hours. Nothing was sent to PayPal.`);
    process.exitCode = 1;
    return undefined;
  }

  const mandateFrom = args.mandateFrom ?? (process.env.DB_PATH?.trim() || 'data/guard.db');
  const source = existsSync(mandateFrom) ? new Repo(openDatabase(mandateFrom)) : undefined;
  const mandate = source?.activeMandate();
  if (!mandate) {
    console.error(`[fail] no active mandate in ${mandateFrom}. Link PayPal first: start the dashboard (npm run dev) and use its PayPal page, or run \`npm run link-paypal -- --from-spike-state\`. Nothing was sent to PayPal.`);
    process.exitCode = 1;
    return undefined;
  }

  const dbPath = args.dbPath ?? `.tmp-e2e/guard-${new Date(now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.db`;
  mkdirSync(dirname(dbPath), { recursive: true });
  const repo = new Repo(openDatabase(dbPath), now);
  const copied = repo.saveMandate({ paypalVaultId: mandate.paypalVaultId, paypalCustomerId: mandate.paypalCustomerId });
  repo.appendAudit({ actor: 'owner', action: 'mandate.linked', details: { mandateId: copied.id, source: `copied from ${mandateFrom} (mandate ${mandate.id})` } });

  const counted = counting(globalThis.fetch);
  const client = new PayPalClient(cfg, { fetch: counted.fetch, log: (line) => say(`[paypal] ${line}`) });
  return {
    repo,
    client,
    now,
    reviewConfig,
    paypalCalls: counted.count,
    header: [
      'mode: PayPal SANDBOX. Credentials from .env (values never printed); real sandbox calls follow: a token, one or two per charge, one per refund.',
      `database ${dbPath} (fresh, gitignored); mandate ${copied.id} (vault id ${mask(copied.paypalVaultId)}) copied from ${mandateFrom}.`,
    ],
  };
}

const EXPECTED: Record<number, string> = {
  1: 'PAID by the rules, then refunded',
  2: 'HELD by the rules -> owner approves -> PAID, then refunded',
  3: 'BLOCKED by the reviewer, no PayPal call',
  4: 'HELD by the reviewer (PRICE_ANOMALY) -> owner denies -> DENIED',
};

function printSummary(report: E2EReport, repo: Repo, paypalCalls: number, skipRefund: boolean, say: Say): void {
  say('');
  say('summary');
  for (const s of report.scenarios) {
    const final = repo.getRequest(s.requestId)?.status ?? s.status;
    const flags = s.flags.length === 0 ? '' : ` [${s.flags.join(', ')}]`;
    const owner = s.ownerAction ? ` -> owner ${s.ownerAction === 'approve' ? 'approves' : 'denies'} -> ${s.status}` : '';
    const capture = s.payment?.captureId ? `, capture ${s.payment.captureId}` : '';
    const refund = report.refunds.find((r) => r.n === s.n);
    const refundText = refund ? (refund.ok ? `, refund ${refund.refundId ?? '-'}` : `, REFUND FAILED: ${refund.problem ?? '?'}`) : '';
    say(`  ${s.ok ? 'ok  ' : 'FAIL'} ${s.n}. ${formatAmount(s.amountMinor).padStart(6)} ${DEMO_POLICY.currency}  ${s.decided} by the ${s.decidedBy === 'policy' ? 'rules' : 'reviewer'}${flags}${owner} -> final ${final}${capture}${refundText}`);
    for (const p of s.problems) say(`         - ${p}`);
    say(`         expected: ${EXPECTED[s.n] ?? '?'}`);
    const trail = [...repo.listAudit({ requestId: s.requestId })].reverse().map((a) => a.action);
    say(`         audit: ${trail.join(', ')}`);
  }
  say('');
  say(`PayPal calls in this run: ${paypalCalls}`);
  say(`budget: ${formatAmount(report.spentMinor)} ${DEMO_POLICY.currency} counted against this month after the run`);

  const okScenarios = report.scenarios.filter((s) => s.ok).length;
  const okRefunds = report.refunds.filter((r) => r.ok).length;
  const refunds = skipRefund ? 'refunds skipped' : `${okRefunds}/${report.refunds.length} refunds completed`;
  say('');
  say(report.ok ? `VERDICT: ${okScenarios}/${report.scenarios.length} scenarios as expected, ${refunds}.` : `VERDICT: FAILED. ${okScenarios}/${report.scenarios.length} scenarios as expected, ${refunds}. See the lines marked [fail] above.`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const say: Say = (line) => console.log(line);
  if (!args.offline) loadDotEnv(); // offline never reads .env
  const shopUrl = (process.env.SHOP_URL?.trim() || 'http://localhost:3001').replace(/\/+$/, '');

  // The synthetic shop, served in memory: the agent reads its pages and the reviewer fetches them through the fence.
  const shop = createShopApp();
  const shopFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => shop.request(String(input), init)) as unknown as typeof fetch;

  const wiring = args.offline ? wireOffline(shopUrl, say) : wireSandbox(args, shopUrl, say);
  if (!wiring) return;
  const { repo, client, now, reviewConfig } = wiring;

  seedDemo(repo);
  const review = createReviewer(reviewConfig, { repo, pageFetch: shopFetch, log: (line) => say(`[reviewer] ${line}`) });
  const executor = new PayPalExecutor({ client, repo, now, log: (line) => say(`[executor] ${line}`) });
  const guard = new Guard({ repo, executor, reviewer: review.reviewer, reviewTimeoutMs: reviewConfig.timeoutMs, now });

  say('agent-spend-guard end to end: four synthetic scenarios, the owner scripted, refunds at the end');
  for (const line of wiring.header) say(line);
  say(`reviewer: ${review.label}${review.mock ? '' : ' (key present, value never printed; one model call per request, no retries)'}`);
  say(
    `rules for ${DEMO_AGENT_ID}: up to ${formatAmount(DEMO_POLICY.maxTxMinor)} ${DEMO_POLICY.currency} per purchase, ${formatAmount(DEMO_POLICY.monthlyBudgetMinor)} per month, merchants ${DEMO_POLICY.merchantAllowlist?.join(' / ') ?? 'any'}, hours ${DEMO_POLICY.hours ? `${DEMO_POLICY.hours.start}-${DEMO_POLICY.hours.end}` : 'any'} ${DEMO_POLICY.timezone}`,
  );

  const report = await runE2E({ repo, guard, executor, shopUrl, shopFetch, paypalCalls: wiring.paypalCalls, log: say, skipRefund: args.skipRefund, now });
  printSummary(report, repo, wiring.paypalCalls(), args.skipRefund, say);
  process.exitCode = report.ok ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error('');
  if (err instanceof PayPalApiError) {
    console.error(`[fail] ${err.message}`);
    for (const d of err.details) console.error(`       - ${[d.issue, d.field, d.description].filter(Boolean).join(' | ')}`);
  } else {
    console.error(`[fail] ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exitCode = 1; // not process.exit(): see spike-vault.ts
});

/**
 * M1 proof on the PayPal SANDBOX: one request goes through the whole guard.
 *
 *   policy engine -> AUTO_APPROVE -> charge through the owner's mandate (vault_id, buyer absent) -> PAID -> refund -> REFUNDED
 *
 *   npm run e2e:sandbox [-- --amount 1.00] [-- --skip-refund]
 *
 * Needs .env (sandbox credentials) and an active mandate (`npm run link-paypal -- --from-spike-state`).
 * Sends 3 or 4 requests: OAuth token, order create, capture only if PayPal did not capture on create, refund.
 * Prints statuses, PayPal object ids and the audit trail. Never prints credentials, tokens or the vault id.
 * Every merchant and item here is synthetic demo data.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadDotEnv } from '../src/config/env.js';
import { openDatabase } from '../src/db/connection.js';
import { Repo } from '../src/db/repo.js';
import { formatAmount, parseAmount } from '../src/domain/money.js';
import { PayPalExecutor } from '../src/guard/executor.js';
import { Guard } from '../src/guard/pipeline.js';
import { PayPalApiError, PayPalClient } from '../src/paypal/client.js';
import { loadPayPalConfig } from '../src/paypal/env.js';

const AGENT_ID = 'demo-agent';

interface Args {
  amountMinor: number;
  skipRefund: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { amountMinor: 100, skipRefund: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--amount') {
      const minor = parseAmount(argv[++i] ?? '');
      if (minor === undefined) throw new Error('--amount must look like 1.00');
      args.amountMinor = minor;
    } else if (a === '--skip-refund') {
      args.skipRefund = true;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  loadDotEnv();
  const cfg = loadPayPalConfig();
  const client = new PayPalClient(cfg, { log: (line) => console.log(`     ${line}`) });

  const dbPath = process.env.DB_PATH?.trim() || 'data/guard.db';
  mkdirSync(dirname(dbPath), { recursive: true });
  const repo = new Repo(openDatabase(dbPath));
  console.log(`agent-spend-guard M1 end-to-end | amount=${formatAmount(args.amountMinor)} USD | PayPal SANDBOX only | db=${dbPath}`);

  // Synthetic demo agent and policy (idempotent).
  if (!repo.getAgent(AGENT_ID)) repo.createAgent({ id: AGENT_ID, name: 'Demo shopping agent (synthetic)' });
  repo.savePolicy({
    agentId: AGENT_ID,
    currency: 'USD',
    maxTxMinor: 3000,
    hardMaxTxMinor: 20000,
    monthlyBudgetMinor: 10000,
    merchantAllowlist: ['Synthetic Books', 'Synthetic Supplies'],
    categoryAllowlist: null,
    hours: null,
    timezone: 'Asia/Tokyo',
    holdNewMerchants: true,
  });
  console.log(`[ok] agent ${AGENT_ID}: policy max 30.00 USD per purchase, 100.00 USD per month, two synthetic merchants`);

  const mandate = repo.activeMandate();
  if (!mandate) {
    console.error('[fail] no active mandate: run `npm run link-paypal -- --from-spike-state` first (after `npm run spike:vault`).');
    process.exitCode = 1;
    return;
  }
  console.log(`[ok] mandate ${mandate.id} active`);

  const executor = new PayPalExecutor({ client, repo, log: (line) => console.log(`     ${line}`) });
  const guard = new Guard({ repo, executor });

  const result = await guard.submit({
    agentId: AGENT_ID,
    merchant: 'Synthetic Books',
    item: 'Field notebook, A5 (synthetic demo item)',
    category: 'books',
    amountMinor: args.amountMinor,
    currency: 'USD',
    reason: 'M1 end-to-end check: synthetic purchase, refunded right away',
  });
  const reasons = result.policy.reasons.map((r) => `${r.code}: ${r.message}`);
  console.log(`[ok] request ${result.request.id}: policy ${result.policy.verdict} -> decision ${result.decision.finalDecision} (${result.decision.decidedBy})`);
  for (const r of reasons) console.log(`     - ${r}`);
  if (result.policy.budget) {
    console.log(`     budget ${result.policy.budget.monthKey}: spent ${formatAmount(result.policy.budget.spentMinor)} of ${formatAmount(result.policy.budget.capMinor)} USD before this request`);
  }
  if (result.decision.finalDecision !== 'AUTO_APPROVE') {
    console.error(`[fail] expected AUTO_APPROVE. The request is ${result.request.status}; adjust the amount or wait for the budget month to roll over.`);
    printAudit(repo, result.request.id);
    process.exitCode = 1;
    return;
  }

  const payment = result.payment;
  if (!payment) throw new Error('auto-approved but no payment was attempted');
  console.log(`[${payment.status === 'COMPLETED' ? 'ok' : 'fail'}] payment ${payment.id}: ${payment.status} order=${payment.paypalOrderId ?? '-'} capture=${payment.paypalCaptureId ?? '-'} -> request ${result.request.status}`);
  if (payment.status !== 'COMPLETED') {
    printAudit(repo, result.request.id);
    process.exitCode = 1;
    return;
  }

  if (args.skipRefund) {
    console.log('[ok] refund skipped (--skip-refund); the capture stays in the sandbox business account');
  } else {
    const refunded = await executor.refund(result.request.id);
    console.log(`[ok] refund ${refunded.paypalRefundId ?? '-'}: payment ${refunded.status} -> request ${repo.getRequest(result.request.id)?.status}`);
  }

  printAudit(repo, result.request.id);
  const spent = repo.spentThisMonthMinor(AGENT_ID, Date.now(), 'Asia/Tokyo');
  console.log(`budget now: ${formatAmount(spent)} USD counted against this month`);
  console.log('');
  console.log('VERDICT: M1 proven. A policy-approved request was charged through the stored mandate with the buyer absent' + (args.skipRefund ? '.' : ' and refunded.'));
}

function printAudit(repo: Repo, requestId: string): void {
  console.log('');
  console.log(`audit trail for ${requestId} (oldest first):`);
  for (const entry of [...repo.listAudit({ requestId })].reverse()) {
    console.log(`  ${new Date(entry.ts).toISOString()}  ${entry.actor.padEnd(18)} ${entry.action.padEnd(18)} ${JSON.stringify(entry.details)}`);
  }
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

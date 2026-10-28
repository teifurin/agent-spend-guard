/**
 * `npm run demo:seed`: creates the synthetic demo agent and its rules in the guard's database (idempotent).
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadDotEnv } from '../src/config/env.js';
import { openDatabase } from '../src/db/connection.js';
import { Repo } from '../src/db/repo.js';
import { seedDemo } from '../src/demo/seed.js';
import { formatAmount } from '../src/domain/money.js';
import { PRODUCTS } from '../src/shop/catalog.js';

loadDotEnv();
const dbPath = process.env.DB_PATH?.trim() || 'data/guard.db';
mkdirSync(dirname(dbPath), { recursive: true });
const repo = new Repo(openDatabase(dbPath));
const { agent, policy, created } = seedDemo(repo);

console.log(`database: ${dbPath}`);
console.log(`${created ? 'created' : 'updated'} agent "${agent.id}" (${agent.name})`);
console.log(`rules: up to ${formatAmount(policy.maxTxMinor)} ${policy.currency} per purchase, ${formatAmount(policy.monthlyBudgetMinor)} per month, merchants ${policy.merchantAllowlist?.join(' / ')}, hours ${policy.hours?.start}-${policy.hours?.end} ${policy.timezone}`);
console.log(`mandate: ${repo.activeMandate() ? 'linked' : 'not linked (link PayPal from the dashboard, or run `npm run link-paypal -- --from-spike-state`)'}`);
console.log('');
console.log('synthetic shop catalogue (served by `npm run dev` on the shop port):');
for (const p of PRODUCTS) console.log(`  ${formatAmount(p.priceMinor).padStart(6)} ${p.currency}  ${p.merchant.padEnd(20)} ${p.name}${p.hiddenText ? '   <- page hides an instruction to the agent' : ''}`);

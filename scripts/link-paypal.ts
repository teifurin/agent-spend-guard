/**
 * Records the owner's PayPal mandate (the vault id from a one-time approval) in the guard's database.
 *
 *   npm run link-paypal -- --from-spike-state
 *
 * M1 imports the payment token that `npm run spike:vault` saved in .spike-state.json (gitignored). The interactive
 * flow (setup token -> owner approves in PayPal -> payment token) arrives with the owner dashboard in M2.
 * Prints the mandate id and a masked vault id only. No network.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadDotEnv } from '../src/config/env.js';
import { openDatabase } from '../src/db/connection.js';
import { Repo } from '../src/db/repo.js';
import { mask } from '../src/paypal/redact.js';

const STATE_FILE = '.spike-state.json';

interface SpikeState {
  vaultId?: string;
  customerId?: string;
  createdAt?: string;
}

function main(): void {
  const args = process.argv.slice(2);
  if (!args.includes('--from-spike-state')) {
    console.error('usage: npm run link-paypal -- --from-spike-state');
    console.error('       (imports the vault id saved by `npm run spike:vault`; the interactive link flow comes with M2)');
    process.exitCode = 2;
    return;
  }
  loadDotEnv();
  if (!existsSync(STATE_FILE)) {
    console.error(`${STATE_FILE} not found. Run \`npm run spike:vault\` first; it saves the vault id there after the owner approves.`);
    process.exitCode = 1;
    return;
  }
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as SpikeState;
  if (!state.vaultId) {
    console.error(`${STATE_FILE} has no vaultId.`);
    process.exitCode = 1;
    return;
  }

  const dbPath = process.env.DB_PATH?.trim() || 'data/guard.db';
  mkdirSync(dirname(dbPath), { recursive: true });
  const repo = new Repo(openDatabase(dbPath));
  const previous = repo.activeMandate();
  const mandate = repo.saveMandate({ paypalVaultId: state.vaultId, paypalCustomerId: state.customerId ?? null });
  repo.appendAudit({ actor: 'owner', action: 'mandate.linked', details: { mandateId: mandate.id, source: STATE_FILE, replaced: previous?.id ?? null } });

  console.log(`database: ${dbPath}`);
  console.log(`mandate ${mandate.id} is active (vault id ${mask(mandate.paypalVaultId)}, saved by the spike ${state.createdAt ?? 'at an unknown time'})`);
  if (previous) console.log(`previous mandate ${previous.id} revoked`);
}

main();

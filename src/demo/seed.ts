/**
 * The demo agent and its rules, shared by `npm run demo:seed`, `npm run e2e:sandbox` and the tests.
 * Everything here is synthetic demo data.
 */
import type { Repo } from '../db/repo.js';
import type { Agent, Policy } from '../domain/types.js';

export const DEMO_AGENT_ID = 'research-bot';

/** The rules shown in the demo: $30 a purchase, $100 a month, two synthetic merchants, nothing at night (Tokyo time). */
export const DEMO_POLICY: Omit<Policy, 'updatedAt'> = {
  agentId: DEMO_AGENT_ID,
  currency: 'USD',
  maxTxMinor: 3000,
  hardMaxTxMinor: 20000,
  monthlyBudgetMinor: 10000,
  merchantAllowlist: ['Synthetic Books', 'Synthetic Supplies'],
  categoryAllowlist: null,
  hours: { start: '08:00', end: '22:00' },
  timezone: 'Asia/Tokyo',
  holdNewMerchants: true,
};

export interface SeedResult {
  agent: Agent;
  policy: Policy;
  created: boolean;
}

/** Idempotent: creates the demo agent when missing and (re)writes its policy to the demo rules. */
export function seedDemo(repo: Repo): SeedResult {
  const existing = repo.getAgent(DEMO_AGENT_ID);
  const agent = existing ?? repo.createAgent({ id: DEMO_AGENT_ID, name: 'Research bot (synthetic demo agent)' });
  const policy = repo.savePolicy(DEMO_POLICY);
  if (!existing) repo.appendAudit({ actor: 'owner', action: 'agent.created', agentId: agent.id, details: { name: agent.name } });
  repo.appendAudit({ actor: 'owner', action: 'policy.saved', agentId: agent.id, details: { source: 'demo seed' } });
  return { agent, policy, created: !existing };
}

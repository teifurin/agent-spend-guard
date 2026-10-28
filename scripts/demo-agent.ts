/**
 * The demo shopping agent (mock mode): browses the synthetic shop over HTTP and asks the guard to pay through the
 * MCP server, which it starts as a child process over stdio, exactly as an LLM-driven agent would.
 *
 *   npm run demo:agent                      # all four scenarios, in order
 *   npm run demo:agent -- --scenario 2      # one: 1 notebook, 2 microscope, 3 pens (the hostile page), 4 the notebook at 2.4x the price
 *   npm run demo:agent -- --wait 180        # how long to wait for the owner on a held request (seconds, 0 = don't)
 *
 * Scenario 4 only shows the price check when scenario 1 ran before it (in this database): the reviewer compares
 * with earlier accepted purchases of the same item. On a fresh database it is just a notebook inside the rules.
 *
 * Needs `npm run dev` running. Reads SHOP_URL, GUARD_URL and AGENT_ID from the environment (not from .env: this
 * process and the MCP server it spawns never see PayPal credentials).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parseProductPage, planPurchase, type PurchasePlan } from '../src/agent/mock-agent.js';

const SHOP_URL = (process.env.SHOP_URL?.trim() || 'http://localhost:3001').replace(/\/+$/, '');
const GUARD_URL = (process.env.GUARD_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, '');
const AGENT_ID = process.env.AGENT_ID?.trim() || 'research-bot';

interface Scenario {
  n: number;
  title: string;
  slug: string;
  expect: string;
}

const SCENARIOS: Scenario[] = [
  { n: 1, title: 'A notebook inside the rules', slug: 'field-notebook-a5', expect: 'auto-approved and paid' },
  { n: 2, title: 'A microscope at a merchant the owner never allowed', slug: 'usb-microscope', expect: 'held for the owner' },
  { n: 3, title: 'A bargain page that secretly tells the agent what to do', slug: 'premium-pens-set', expect: 'blocked by the AI reviewer: prompt injection' },
  { n: 4, title: 'The same notebook, suddenly at 2.4x the price', slug: 'field-notebook-a5-marked-up', expect: 'inside the rules, but held by the AI reviewer: price anomaly (needs scenario 1 in the history)' },
];

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
}

interface Args {
  scenarios: Scenario[];
  waitSeconds: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { scenarios: SCENARIOS, waitSeconds: 120 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scenario') {
      const n = Number(argv[++i]);
      const s = SCENARIOS.find((x) => x.n === n);
      if (!s) throw new Error('--scenario must be 1, 2 or 3');
      args.scenarios = [s];
    } else if (a === '--wait') {
      args.waitSeconds = Math.max(0, Number(argv[++i] ?? '0'));
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

const say = (line: string): void => console.log(`[mock agent] ${line}`);
const guardSays = (line: string): void => console.log(`[guard]      ${line}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function describe(result: Record<string, unknown> | undefined): string {
  if (!result) return 'no structured result';
  const decision = result['decision'] as { final?: string; decided_by?: string; reasons?: Array<{ code: string; message: string }>; review?: { risk?: string | null; flags?: string[]; explanation?: string | null } | null } | null;
  const payment = result['payment'] as { status?: string; paypal_capture_id?: string | null } | null;
  const parts = [`request ${String(result['request_id'])} is ${String(result['status'])}${decision?.decided_by ? ` (decided by ${decision.decided_by})` : ''}`];
  if (decision?.reasons && decision.reasons.length > 0) parts.push(`rules: ${decision.reasons.map((r) => `${r.code} (${r.message})`).join('; ')}`);
  if (decision?.review) parts.push(`AI review: risk ${decision.review.risk ?? 'n/a'}${decision.review.flags && decision.review.flags.length > 0 ? `, flags ${decision.review.flags.join(', ')}` : ''}${decision.review.explanation ? ` — ${decision.review.explanation}` : ''}`);
  if (payment?.paypal_capture_id) parts.push(`PayPal capture ${payment.paypal_capture_id}`);
  return parts.join(' | ');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`agent-spend-guard demo shopping agent | LLM_PROVIDER=mock (deterministic, no model) | agent ${AGENT_ID}`);
  console.log(`shop ${SHOP_URL} | guard ${GUARD_URL} | every merchant, product and price is synthetic`);

  const health = await fetch(`${GUARD_URL}/api/health`).then((r) => r.json() as Promise<{ keyless: boolean; linked: boolean }>, () => undefined);
  if (!health) {
    console.error(`[fail] the guard at ${GUARD_URL} is not reachable. Start it first: npm run dev`);
    process.exitCode = 1;
    return;
  }
  if (health.keyless) say('note: the guard runs keyless, so approved requests will not actually be charged');
  else if (!health.linked) say('note: the owner has not linked PayPal yet; approved requests will fail to charge');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/mcp/main.ts'],
    env: { ...getDefaultEnvironment(), GUARD_URL, AGENT_ID },
  });
  const client = new Client({ name: 'demo-shopping-agent-mock', version: '0.0.1' });
  await client.connect(transport);
  const tools = await client.listTools();
  say(`connected to the guard's MCP server; tools: ${tools.tools.map((t) => t.name).join(', ')}`);

  const budget = (await client.callTool({ name: 'get_budget', arguments: {} })) as ToolResult;
  const b = budget.structuredContent as { policy?: { max_per_purchase?: string; merchant_allowlist?: string[] | null; hours?: { start: string; end: string } | null }; remaining?: string; month?: string } | undefined;
  if (b?.policy) {
    say(`my rules: up to ${b.policy.max_per_purchase} per purchase, ${b.remaining} left for ${b.month}, merchants ${b.policy.merchant_allowlist?.join(' / ') ?? 'any'}${b.policy.hours ? `, hours ${b.policy.hours.start}-${b.policy.hours.end}` : ''}`);
  }

  let failures = 0;
  for (const scenario of args.scenarios) {
    console.log('');
    console.log(`=== Scenario ${scenario.n}: ${scenario.title} (expected: ${scenario.expect}) ===`);
    const url = `${SHOP_URL}/products/${scenario.slug}`;
    say(`browsing ${url}`);
    const htmlSource = await fetch(url).then((r) => r.text());
    const page = parseProductPage(url, htmlSource);
    if (!page) {
      console.error(`[fail] could not understand the page at ${url}`);
      failures++;
      continue;
    }
    say(`the page sells "${page.name}" by ${page.merchant} for ${(page.priceMinor / 100).toFixed(2)} ${page.currency} (category ${page.category})`);
    if (page.instruction) {
      say(`the page also contains text aimed at me: "${page.instruction.excerpt}…"`);
      say('I am a naive mock agent, so I follow it. The guard is the safety layer, not me.');
    }
    const plan: PurchasePlan = planPurchase(page);
    say(`asking the guard to pay ${plan.amount} ${plan.currency} for "${plan.item}" at ${plan.merchant}; reason: "${plan.reason}"`);

    const result = (await client.callTool({
      name: 'request_purchase',
      arguments: { merchant: plan.merchant, item: plan.item, category: plan.category, amount: plan.amount, currency: plan.currency, reason: plan.reason, source_url: plan.sourceUrl },
    })) as ToolResult;
    if (result.isError) {
      guardSays(`error: ${result.content?.[0]?.text ?? 'unknown'}`);
      failures++;
      continue;
    }
    let view = result.structuredContent;
    guardSays(describe(view));
    guardSays(String(view?.['message'] ?? ''));
    if (view?.['status'] === 'BLOCKED') say('blocked, so I stop here; the guard told me not to retry.');

    if (view?.['status'] === 'HELD' && args.waitSeconds > 0) {
      const requestId = String(view['request_id']);
      say(`waiting up to ${args.waitSeconds}s for the owner to decide on ${requestId} in the dashboard (${GUARD_URL})…`);
      const deadline = Date.now() + args.waitSeconds * 1000;
      while (Date.now() < deadline) {
        await sleep(3000 + Math.floor(Math.random() * 2000));
        const status = (await client.callTool({ name: 'get_request_status', arguments: { request_id: requestId } })) as ToolResult;
        view = status.structuredContent;
        if (view?.['status'] !== 'HELD') break;
      }
      guardSays(view?.['status'] === 'HELD' ? `still HELD after ${args.waitSeconds}s; the owner can decide later` : describe(view));
    }
  }

  await client.close();
  console.log('');
  console.log(failures === 0 ? 'done: the mock agent only ever received statuses and ids, never a credential.' : `done with ${failures} failure(s).`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error(`[fail] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

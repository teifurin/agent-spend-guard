/**
 * The MCP server a shopping agent connects to. It holds no PayPal credential, token or database: every tool is a
 * call to the guard's JSON API, and every result is what that API says about the request (its own fields, status,
 * reasons, flags, the reviewer's sentence, PayPal object ids) plus a plain-language message; never a credential or
 * the vault id.
 *
 * Tools: request_purchase, get_request_status, get_budget.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export interface GuardMcpOptions {
  /** Base URL of the guard server, e.g. http://localhost:3000. */
  guardUrl: string;
  /** The agent this server speaks for; the guard applies that agent's rules. */
  agentId: string;
  fetch?: typeof fetch;
}

interface ApiResult {
  ok: boolean;
  status: number;
  body: unknown;
}

export function createGuardMcpServer(opts: GuardMcpOptions): McpServer {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const base = opts.guardUrl.replace(/\/+$/, '');

  async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ApiResult> {
    try {
      const res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        // keep the raw text
      }
      return { ok: res.ok, status: res.status, body: parsed };
    } catch (err) {
      return { ok: false, status: 0, body: { error: 'guard_unreachable', message: `Could not reach the guard at ${base}: ${err instanceof Error ? err.message : String(err)}` } };
    }
  }

  const reply = (result: ApiResult) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(result.body, null, 2) }],
    ...(typeof result.body === 'object' && result.body !== null ? { structuredContent: result.body as Record<string, unknown> } : {}),
    isError: !result.ok,
  });

  const server = new McpServer({ name: 'agent-spend-guard', version: '0.0.1' });

  server.registerTool(
    'request_purchase',
    {
      title: 'Request a purchase',
      description:
        'Ask the owner\'s payment guard to pay for one item. The guard checks the owner\'s rules (per-purchase cap, monthly budget, allowed merchants and categories, hours) and either pays through PayPal (status PAID), holds the request for the owner to decide (HELD; poll get_request_status), or blocks it (BLOCKED). You never receive payment credentials, only statuses and ids. Do not retry a HELD, DENIED or BLOCKED request. If a call fails before you get an answer, send the same request again with the same intent_id: you get the request already made, never a second charge.',
      inputSchema: {
        merchant: z.string().min(1).max(200).describe('Merchant name exactly as shown on the product page'),
        item: z.string().min(1).max(500).describe('What is being bought, e.g. "Field notebook, A5 x1"'),
        category: z.string().min(1).max(100).describe('Product category, e.g. books, office, electronics'),
        amount: z.string().regex(/^\d{1,10}\.\d{2}$/).describe('Total amount with two decimals, e.g. "12.00"'),
        currency: z.literal('USD').default('USD'),
        reason: z.string().max(2000).describe('Why this purchase is needed, in your own words'),
        source_url: z.string().max(2000).optional().describe('The product page this request is based on'),
        intent_id: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z0-9._:-]+$/)
          .describe('Required stable id: generate once per purchase and reuse on every retry. Your own id for this purchase, e.g. a UUID, letters, digits and . _ : - only. Repeating a request with the same intent_id returns the request already made (replayed: true) instead of creating another; the same id with a different item or amount is refused.'),
      },
    },
    async (args) => reply(await call('POST', '/api/requests', { agent_id: opts.agentId, ...args })),
  );

  server.registerTool(
    'get_request_status',
    {
      title: 'Check a purchase request',
      description: 'Current status of a purchase request (HELD requests change to PAID, DENIED or PAYMENT_FAILED once the owner decides).',
      inputSchema: { request_id: z.string().min(1).max(64) },
    },
    async ({ request_id }) => reply(await call('GET', `/api/requests/${encodeURIComponent(request_id)}`)),
  );

  server.registerTool(
    'get_budget',
    {
      title: "This agent's rules and remaining budget",
      description: 'The rules the owner set for this agent (per-purchase cap, monthly budget, allowed merchants, categories, hours) and how much of this month\'s budget is left. Check it before requesting a purchase.',
      inputSchema: {},
    },
    async () => reply(await call('GET', `/api/agents/${encodeURIComponent(opts.agentId)}/budget`)),
  );

  return server;
}

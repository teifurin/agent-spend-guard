import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { createGuardMcpServer } from '../../src/mcp/server.js';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** A fake guard API: records calls and answers like src/server/app.ts would. */
function fakeGuard() {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ url, method: init?.method ?? 'GET', body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/api/requests') && init?.method === 'POST') {
      const b = body as { amount: string };
      return b.amount === '45.00'
        ? json({ request_id: 'req_held', status: 'HELD', decision: { final: 'HOLD', reasons: [{ code: 'MERCHANT_NOT_ALLOWED', message: 'not allowed' }] }, payment: null, message: 'Held for the owner.' }, 201)
        : json({ request_id: 'req_paid', status: 'PAID', decision: { final: 'AUTO_APPROVE', reasons: [] }, payment: { status: 'COMPLETED', paypal_capture_id: 'C1' }, message: 'Paid.' }, 201);
    }
    if (url.endsWith('/api/requests/req_held')) return json({ request_id: 'req_held', status: 'DENIED', message: 'The owner denied it.' });
    if (url.includes('/api/agents/research-bot/budget')) return json({ agent_id: 'research-bot', month: '2026-10', spent: '0.00', remaining: '100.00' });
    return json({ error: 'unknown_request' }, 404);
  });
  return { calls, fetch: fetchMock as unknown as typeof fetch };
}

async function connect(fetchImpl: typeof fetch) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createGuardMcpServer({ guardUrl: 'http://guard.test/', agentId: 'research-bot', fetch: fetchImpl });
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-agent', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, server };
}

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: string; text?: string }>;
}

describe('guard MCP server', () => {
  it('exposes the three tools and forwards request_purchase to the guard API with the agent id', async () => {
    const guard = fakeGuard();
    const { client } = await connect(guard.fetch);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(['get_budget', 'get_request_status', 'request_purchase']);

    const result = (await client.callTool({
      name: 'request_purchase',
      arguments: { merchant: 'Synthetic Books', item: 'Field notebook, A5 x1', category: 'books', amount: '12.00', reason: 'notes', source_url: 'http://shop.test/products/field-notebook-a5' },
    })) as ToolResult;
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ request_id: 'req_paid', status: 'PAID' });
    expect(result.content[0]?.text).toContain('"status": "PAID"');

    const call = guard.calls[0];
    expect(call?.url).toBe('http://guard.test/api/requests');
    expect(call?.method).toBe('POST');
    expect(call?.body).toMatchObject({ agent_id: 'research-bot', merchant: 'Synthetic Books', amount: '12.00', currency: 'USD' });
  });

  it('reports held requests, status checks and the budget', async () => {
    const guard = fakeGuard();
    const { client } = await connect(guard.fetch);
    const held = (await client.callTool({ name: 'request_purchase', arguments: { merchant: 'Synthetic Gadgets', item: 'USB microscope', category: 'electronics', amount: '45.00', reason: 'lab' } })) as ToolResult;
    expect(held.structuredContent).toMatchObject({ status: 'HELD' });

    const status = (await client.callTool({ name: 'get_request_status', arguments: { request_id: 'req_held' } })) as ToolResult;
    expect(status.structuredContent).toMatchObject({ status: 'DENIED' });

    const budget = (await client.callTool({ name: 'get_budget', arguments: {} })) as ToolResult;
    expect(budget.structuredContent).toMatchObject({ remaining: '100.00' });
    expect(guard.calls.map((c) => c.url)).toEqual(['http://guard.test/api/requests', 'http://guard.test/api/requests/req_held', 'http://guard.test/api/agents/research-bot/budget']);
  });

  it('rejects malformed amounts before calling the guard and flags guard errors', async () => {
    const guard = fakeGuard();
    const { client } = await connect(guard.fetch);
    const invalid = (await client.callTool({ name: 'request_purchase', arguments: { merchant: 'x', item: 'y', category: 'z', amount: '12', reason: '' } })) as ToolResult;
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0]?.text).toContain('amount');
    expect(guard.calls.length).toBe(0);

    const missing = (await client.callTool({ name: 'get_request_status', arguments: { request_id: 'req_nope' } })) as ToolResult;
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent).toMatchObject({ error: 'unknown_request' });
  });

  it('reports an unreachable guard as a tool error instead of crashing', async () => {
    const dead = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const { client } = await connect(dead);
    const result = (await client.callTool({ name: 'get_budget', arguments: {} })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('guard_unreachable');
  });
});

describe('intent ids (D17)', () => {
  it('forwards intent_id so a repeated call cannot open a second purchase, and rejects malformed ones locally', async () => {
    const guard = fakeGuard();
    const { client } = await connect(guard.fetch);
    await client.callTool({ name: 'request_purchase', arguments: { merchant: 'Synthetic Books', item: 'Field notebook, A5 x1', category: 'books', amount: '12.00', reason: 'notes', intent_id: 'nb-0001' } });
    expect(guard.calls[0]?.body).toMatchObject({ agent_id: 'research-bot', intent_id: 'nb-0001' });
    const bad = (await client.callTool({ name: 'request_purchase', arguments: { merchant: 'x', item: 'y', category: 'z', amount: '12.00', reason: '', intent_id: 'has spaces' } })) as ToolResult;
    expect(bad.isError).toBe(true);
    expect(guard.calls.length).toBe(1);
  });
});

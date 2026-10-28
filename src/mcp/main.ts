/**
 * `npm run mcp`: the MCP server over stdio, for Claude Desktop, Claude Code or the demo agent.
 * Configuration comes from its own environment only: GUARD_URL (default http://localhost:3000) and
 * AGENT_ID (default research-bot). It deliberately does not load .env, so PayPal credentials never enter
 * this process. Nothing is logged to stdout, which carries the protocol; notes go to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createGuardMcpServer } from './server.js';

const guardUrl = process.env.GUARD_URL?.trim() || 'http://localhost:3000';
const agentId = process.env.AGENT_ID?.trim() || 'research-bot';

const server = createGuardMcpServer({ guardUrl, agentId });
const transport = new StdioServerTransport();
server.connect(transport).then(
  () => console.error(`agent-spend-guard MCP server ready on stdio (agent ${agentId}, guard ${guardUrl})`),
  (err: unknown) => {
    console.error(`MCP server failed to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);

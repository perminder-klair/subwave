// Use a fresh stateless MCP server/transport per POST; GET/DELETE return 405.
// Forward caller Authorization through loopback REST so admin tools keep their gates.
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from '../config.js';
import { SubwaveClient } from '../mcp/client.js';
import { registerSubwaveTools } from '../mcp/tools.js';
import { clientIp } from '../middleware/ratelimit.js';
import { queue } from '../broadcast/queue.js';

export const router = express.Router();

// Loopback back into this controller: 127.0.0.1 never leaves the container/host.
const LOOPBACK_BASE = `http://127.0.0.1:${config.server.port}`;

// Transport-level failures the SDK doesn't own. id null per JSON-RPC when the
// request couldn't be parsed/associated.
function rpcError(res: express.Response, code: number, message: string) {
  if (res.headersSent) return;
  res.status(500).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

// subwave_request_song polls for the outcome and holds the HTTP connection while
// it does, so keep it well under the 45s stdio budget; the agent re-polls with
// subwave_request_status.
const HTTP_REQUEST_POLL_BUDGET_MS = 15_000;

// A JSON-RPC batch fans out: every tools/call in it is its own loopback REST
// request, so one POST at the edge became up to the SDK's 100 here. No client we
// document batches — MCP 2025-06-18 dropped batching and the TypeScript SDK
// client (Claude Code / Desktop) sends one message per POST — so cheap traffic
// from an older client keeps a small batch, and the work-bearing method is
// capped at one per POST, the same as an unbatched call.
export const MCP_MAX_BATCH = 10;
export const MCP_MAX_TOOL_CALLS_PER_POST = 1;

export function mcpBatchRefusal(body: unknown): string | null {
  if (!Array.isArray(body)) return null;
  if (body.length > MCP_MAX_BATCH) {
    return `Invalid Request: a batch must not exceed ${MCP_MAX_BATCH} messages`;
  }
  const calls = body.filter(m => m && typeof m === 'object' && (m as { method?: unknown }).method === 'tools/call').length;
  if (calls > MCP_MAX_TOOL_CALLS_PER_POST) {
    return `Invalid Request: a batch may carry at most ${MCP_MAX_TOOL_CALLS_PER_POST} tools/call`;
  }
  return null;
}

router.post('/mcp', async (req, res) => {
  // Refused before any server, transport or loopback client exists.
  const refusal = mcpBatchRefusal(req.body);
  if (refusal) {
    return res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: refusal }, id: null });
  }

  const client = new SubwaveClient({
    baseUrl: LOOPBACK_BASE,
    forwardAuth: typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
    // Without this every MCP user shares one loopback rate-limit bucket.
    forwardIp: clientIp(req),
    // Station password gates listener-facing reads: a different secret from the
    // admin one, so it rides its own header. Absent on a public station.
    forwardStationAuth:
      typeof req.headers['x-station-auth'] === 'string' ? req.headers['x-station-auth'] : undefined,
  });

  const server = new McpServer({ name: 'subwave-mcp', version: process.env.SUBWAVE_VERSION || 'latest' });
  registerSubwaveTools(server, client, { requestPollBudgetMs: HTTP_REQUEST_POLL_BUDGET_MS });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — a fresh server per request
    enableJsonResponse: true, // return JSON on the POST rather than an SSE stream
  });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    queue.log('error', `/mcp request failed: ${err instanceof Error ? err.message : String(err)}`);
    rpcError(res, -32603, 'Internal MCP server error');
  }
});

// Stateless server: no session to stream over (GET) or terminate (DELETE).
const methodNotAllowed = (_req: express.Request, res: express.Response) =>
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed. This MCP endpoint is stateless — use POST.' },
    id: null,
  });
router.get('/mcp', methodNotAllowed);
router.delete('/mcp', methodNotAllowed);

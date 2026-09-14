// Built-in HTTP MCP endpoint: stateless Streamable HTTP, a fresh McpServer +
// transport per POST (no sessions, no SSE — plain JSON). GET/DELETE are 405.
// The endpoint itself is open; each tool call goes through a loopback
// SubwaveClient that forwards the caller's Authorization header, so admin tools
// 401 exactly as the REST endpoints they wrap.
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

router.post('/mcp', async (req, res) => {
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

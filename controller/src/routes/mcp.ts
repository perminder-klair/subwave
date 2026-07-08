// Built-in HTTP MCP endpoint. Lets any MCP client (Claude Code, Claude Desktop,
// …) drive the station over the Model Context Protocol with just a URL — no
// clone, no local process:
//
//   claude mcp add --transport http subwave https://your-station/api/mcp \
//     --header "Authorization: Basic <base64 user:pass>"
//
// Transport: stateless Streamable HTTP. Each POST gets a fresh McpServer +
// transport (sessionIdGenerator: undefined, enableJsonResponse: true), so there
// are no sessions to store and no SSE stream — a plain JSON response the Caddy
// /api/* proxy handles like any other. GET/DELETE are 405 (nothing to resume).
//
// Auth mirrors the REST API: the endpoint is open, but each tool call goes
// through a loopback SubwaveClient pointed at the controller's own port that
// FORWARDS the caller's Authorization header. Public tools work for anyone;
// admin tools (say/segment/skill/skip/queue/search/sfx/refresh) 401 without
// valid creds — the exact surface of the endpoints the tools wrap. So the tools
// reuse the live routes with no handler refactor, and requireAdmin is untouched.
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from '../config.js';
import { SubwaveClient } from '../mcp/client.js';
import { registerSubwaveTools } from '../mcp/tools.js';
import { clientIp } from '../middleware/ratelimit.js';
import { queue } from '../broadcast/queue.js';

export const router = express.Router();

// The tools call back into this controller over HTTP. 127.0.0.1 stays inside
// the container/host — never routed out — and the port is the controller's own.
const LOOPBACK_BASE = `http://127.0.0.1:${config.server.port}`;

// JSON-RPC error body for the transport-level failures the SDK doesn't own
// (e.g. our handler throwing before handleRequest). id null per JSON-RPC when
// the request couldn't be parsed/associated.
function rpcError(res: express.Response, code: number, message: string) {
  if (res.headersSent) return;
  res.status(500).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

// subwave_request_song blocks while it polls for the outcome. Over stdio the
// full 45s budget is fine (one local caller); here every anonymous POST holds
// an HTTP connection for the duration, so keep it short — the tool hands back
// the requestId and the agent re-polls with subwave_request_status.
const HTTP_REQUEST_POLL_BUDGET_MS = 15_000;

router.post('/mcp', async (req, res) => {
  const client = new SubwaveClient({
    baseUrl: LOOPBACK_BASE,
    // Forward the caller's credentials verbatim so admin tools are gated
    // exactly as the REST endpoints they wrap.
    forwardAuth: typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
    // Forward the caller's IP so POST /request's per-IP rate limit keys on the
    // real caller — without this every MCP user shares one loopback bucket.
    forwardIp: clientIp(req),
  });

  const server = new McpServer({ name: 'subwave-mcp', version: process.env.SUBWAVE_VERSION || 'latest' });
  registerSubwaveTools(server, client, { requestPollBudgetMs: HTTP_REQUEST_POLL_BUDGET_MS });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — a fresh server per request
    enableJsonResponse: true, // return JSON on the POST rather than an SSE stream
  });

  // Tear the per-request server/transport down when the HTTP response closes,
  // so nothing leaks across the (stateless) requests.
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

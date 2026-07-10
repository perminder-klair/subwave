/**
 * The standalone stdio MCP bootstrap — the local-only alternative to the
 * controller's built-in HTTP MCP endpoint (routes/mcp.ts). It builds a
 * SubwaveClient from the environment and connects the shared tool set to a
 * stdio transport.
 *
 * It lives here (not in mcp-subwave/) so that every MCP SDK type resolves to a
 * SINGLE copy of @modelcontextprotocol/sdk — the controller's. The mcp-subwave
 * package is just a thin `tsx` launcher that imports this module; keeping the
 * SDK in one place avoids the nominal type clash two separate installs cause.
 *
 * Run via: `npx tsx mcp-subwave/src/index.ts` (see the repo-root .mcp.json).
 *
 * Environment:
 *   SUBWAVE_API_URL     controller base URL (default http://localhost:7701;
 *                       prod behind Caddy is http://localhost:7700/api)
 *   SUBWAVE_ADMIN_USER  admin Basic-auth user  — required for DJ control tools
 *   SUBWAVE_ADMIN_PASS  admin Basic-auth pass  — required for DJ control tools
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SubwaveClient } from "./client.js";
import { registerSubwaveTools } from "./tools.js";

export async function startStdioServer(): Promise<void> {
  const client = new SubwaveClient({
    baseUrl: (process.env.SUBWAVE_API_URL || "http://localhost:7701").replace(/\/$/, ""),
    adminUser: process.env.SUBWAVE_ADMIN_USER,
    adminPass: process.env.SUBWAVE_ADMIN_PASS,
  });

  const version = process.env.SUBWAVE_VERSION || "latest";
  const server = new McpServer({ name: "subwave-mcp", version });
  registerSubwaveTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the MCP channel.
  console.error(`subwave-mcp ${version} ready on stdio`);
}

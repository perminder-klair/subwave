#!/usr/bin/env node
/**
 * subwave-mcp — the standalone stdio MCP server for the SUB/WAVE radio.
 *
 * This is the local-only alternative to the controller's built-in HTTP MCP
 * endpoint (see the admin Connect → MCP tab / docs/mcp-server.md). Most users
 * should prefer the HTTP endpoint — it needs no clone and no local process:
 *
 *   claude mcp add --transport http subwave https://your-station/api/mcp \
 *     --header "Authorization: Basic <base64 user:pass>"
 *
 * The tool set AND this stdio bootstrap live once in the controller
 * (controller/src/mcp/). This file is a thin `tsx` launcher so the SUB/WAVE MCP
 * SDK resolves to a single copy; it runs from a full clone, so the sibling
 * controller/src path always exists. No build step.
 */
import { startStdioServer } from "../../controller/src/mcp/stdio.js";

startStdioServer().catch((err) => {
  console.error("subwave-mcp failed to start:", err);
  process.exit(1);
});

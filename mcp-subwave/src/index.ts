#!/usr/bin/env node
/** Local stdio launcher for the shared controller/src/mcp implementation. Requires a full clone; the
 * HTTP alternative is documented in docs/mcp-server.md. */
import { startStdioServer } from "../../controller/src/mcp/stdio.js";

startStdioServer().catch((err) => {
  console.error("subwave-mcp failed to start:", err);
  process.exit(1);
});

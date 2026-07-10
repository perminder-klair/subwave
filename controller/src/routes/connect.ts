// Connect — the discovery surface behind the admin "Connect" page. Two
// admin-gated reads:
//
//   GET /connect/catalog       the curated endpoint/MCP/stream manifest, plus
//                              the live station origin and per-mount enabled
//                              state, so the UI can render copy-ready absolute
//                              URLs and an accurate stream list.
//   GET /connect/openapi.json  an OpenAPI 3.1 document generated from the same
//                              manifest, for Postman/Insomnia import or client
//                              codegen.
//
// Both are admin-gated: they enumerate admin endpoints and the station origin,
// which is exactly the kind of internal map the auth gate exists to protect.
import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import * as settings from '../settings.js';
import { publicOrigin } from './public.js';
import {
  ENDPOINT_GROUPS,
  MCP_TOOLS,
  STREAM_MOUNTS,
  type StreamMountDoc,
} from '../connect/catalog.js';
import { toOpenApi } from '../connect/openapi.js';

export const router = express.Router();

const VERSION = process.env.SUBWAVE_VERSION || 'latest';

// Resolve each stream mount's live enabled state from settings. The always-on
// MP3 floor is always enabled; the optional mounts follow their settings flag.
function mountsWithState(): (StreamMountDoc & { enabled: boolean })[] {
  const stream = settings.get().stream || {};
  return STREAM_MOUNTS.map(m => ({
    ...m,
    enabled: m.alwaysOn ? true : stream[m.settingFlag as keyof typeof stream] === true,
  }));
}

router.get('/connect/catalog', requireAdmin, (req, res) => {
  const s = settings.get();
  const origin = publicOrigin(req);
  res.json({
    station: s.station || 'SUB/WAVE',
    // Absolute API base the playground and curl snippets build on. Behind
    // Caddy that's `<origin>/api`; the web layer's adminFetch already targets
    // the same base, so the two always agree.
    apiBase: `${origin}/api`,
    origin,
    version: VERSION,
    groups: ENDPOINT_GROUPS,
    mcpTools: MCP_TOOLS,
    // The controller's built-in HTTP MCP endpoint. Reachable at
    // `${apiBase}${mcpHttpPath}` — the MCP tab builds the connect command from
    // it so clients need no clone or local process.
    mcpHttpPath: '/mcp',
    // Per-mount live enabled state; the web player only ever upgrades to Opus,
    // FLAC/AAC are for external players — the Integrations tab labels them so.
    streamMounts: mountsWithState(),
    openapiPath: '/connect/openapi.json',
  });
});

router.get('/connect/openapi.json', requireAdmin, (req, res) => {
  const doc = toOpenApi(publicOrigin(req), VERSION);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="subwave-openapi.json"');
  res.send(JSON.stringify(doc, null, 2));
});

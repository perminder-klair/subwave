// Connect — the discovery surface behind the admin "Connect" page: the curated
// endpoint/MCP/stream manifest (GET /connect/catalog) and an OpenAPI 3.1 render
// of the same (GET /connect/openapi.json). Both are admin-gated because they
// enumerate admin endpoints and the station origin.
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

// The MP3 floor is always on; optional mounts follow their settings flag.
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
    // Behind Caddy this is `<origin>/api` — the same base web's adminFetch uses.
    apiBase: `${origin}/api`,
    origin,
    version: VERSION,
    groups: ENDPOINT_GROUPS,
    mcpTools: MCP_TOOLS,
    // Built-in HTTP MCP endpoint, reachable at `${apiBase}${mcpHttpPath}`.
    mcpHttpPath: '/mcp',
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

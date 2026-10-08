// SUB/WAVE music router. Speaks the Subsonic API the controller already uses
// (so the controller, Liquidsoap's subhttp downloads and the analyzer need no
// changes) and answers from music-source plugins. See README.md and
// docs/internals/music-sources.md.

import type { Server } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { HOST, PORT, POLL_MS, configStamp } from './config.js';
import { markRequestFailed, trackRequest } from './host/activity.js';
import { configError, configStampSeen, getSource, refreshIfChanged, reloadConfig, rescan } from './host/registry.js';
import { internalRoutes } from './internal/routes.js';
import { checkAuth } from './subsonic/auth.js';
import { BINARY_ENDPOINTS, describeError, handlers } from './subsonic/handlers.js';
import { ROUTER_VERSION, respondError } from './subsonic/respond.js';

const AUTH_PARAMS = new Set(['u', 't', 's', 'p', 'v', 'c', 'f']);
const LOG_REQUESTS = process.env.ROUTER_LOG_REQUESTS === '1';

export function createApp(): express.Express {
  const app = express();
  app.disable('etag');
  app.disable('x-powered-by');

  // Unauthenticated liveness for the container healthcheck. Says nothing
  // about the library beyond which source is serving.
  app.get('/health', (_req, res) => {
    const src = getSource();
    res.json({ ok: true, version: ROUTER_VERSION, serving: src ? src.name : null });
  });

  app.use('/internal', internalRoutes());

  // Subsonic accepts GET and POST, and endpoint names with a legacy `.view` suffix.
  app.all('/rest/:endpoint', express.urlencoded({ extended: false, limit: '1mb' }), async (req, res) => {
    const endpoint = String(req.params.endpoint).replace(/\.view$/, '');
    // Recorded for the admin Signal path monitor (host/activity.ts).
    await trackRequest(req, res, endpoint, () => serveRest(req, res, endpoint));
  });

  app.use((_req, res) => {
    res.status(404).type('text/plain').send('SUB/WAVE music router — see /health\n');
  });
  return app;
}

async function serveRest(req: express.Request, res: express.Response, endpoint: string): Promise<void> {
  // formPost: a POSTed form carries the same params as a query string.
  if (req.method === 'POST' && req.body && typeof req.body === 'object') {
    Object.defineProperty(req, 'query', { value: { ...(req.query as object), ...(req.body as object) } });
  }
  const binary = BINARY_ENDPOINTS.has(endpoint);
  let authErr = checkAuth(req);
  if (authErr && (await refreshIfChanged())) authErr = checkAuth(req);
  const src = getSource();
  if (authErr) return respondError(req, res, src?.name, authErr.code, authErr.message, binary ? 401 : 200);
  if (!src) {
    const reason = configError() ?? 'no music source is selected — choose one in Admin → Settings → Music source';
    return respondError(req, res, undefined, 0, reason, binary ? 503 : 200);
  }
  const handler = handlers[endpoint];
  if (LOG_REQUESTS) {
    const shown = Object.entries(req.query as Record<string, unknown>)
      .filter(([k]) => !AUTH_PARAMS.has(k))
      .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : String(v)}`)
      .join(' ');
    console.log(`[rest] ${endpoint}${shown ? ` ${shown}` : ''}`);
  }
  if (!handler) return respondError(req, res, src.name, 0, `Endpoint '${endpoint}' is not implemented by the SUB/WAVE router`);
  try {
    await handler(req, res, src);
  } catch (err) {
    const { code, message } = describeError(err);
    console.warn(`[rest] ${endpoint} failed: ${message}`);
    if (!res.headersSent) {
      // A thrown error on a binary endpoint must not be a 200 (respond.ts);
      // 500 rather than 404 because the id may be fine and the backend down.
      respondError(req, res, src.name, code, message, binary ? 500 : 200);
    } else {
      markRequestFailed(message);
      res.destroy();
    }
  }
}

// Re-read config.json when it changes; retry a rejected selection now and
// then, since "unreachable at construction" can clear on its own.
const RETRY_FAILED_MS = 60_000;
let lastRetry = 0;
function startPolling(): void {
  const timer = setInterval(() => {
    const changed = configStamp() !== configStampSeen();
    const retry = Boolean(configError()) && Date.now() - lastRetry > RETRY_FAILED_MS;
    if (!changed && !retry) return;
    if (retry) lastRetry = Date.now();
    void reloadConfig(retry).catch((err) => console.warn(`[router] reload failed: ${(err as Error).message}`));
  }, POLL_MS);
  timer.unref();
}

export async function start(port = PORT, host = HOST): Promise<Server> {
  await rescan();
  startPolling();
  const app = createApp();
  const server = await new Promise<Server>((ok) => {
    const s = app.listen(port, host, () => ok(s));
  });
  // Long FLAC downloads over a slow link must not be cut by a socket timeout.
  server.requestTimeout = 0;
  const src = getSource();
  const addr = server.address();
  const shown = typeof addr === 'object' && addr ? `${addr.address}:${addr.port}` : `${host}:${port}`;
  console.log(`[router] SUB/WAVE music router ${ROUTER_VERSION} listening on ${shown} — ${src ? `serving ${src.label}` : 'no source selected'}`);
  return server;
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1]!)).href;
if (isMain) {
  start().catch((err) => {
    console.error('[router] failed to start:', err);
    process.exit(1);
  });
}

// Rolling raw-LLM-request debug log.
//
// When capture is enabled, every outbound model request's exact body — the JSON
// string as actually sent (no re-parse/re-stringify) — is kept in a small
// in-memory ring AND mirrored to a bounded file in the shared state dir
// (${STATE_DIR}/logs/llm-debug.log, last LLM_DEBUG_MAX, newest first), as well
// as dumped to stderr. The file is the better primary UX for operators (esp.
// Unraid, where state == appdata): they just open it instead of trawling
// container logs. The capture point is a single fetch wrapper in the provider
// registry (debugFetch), applied to every provider, so this is provider-agnostic.
//
// Gated two ways (either turns it on): the LLM_DEBUG_RAW env flag, or the
// admin-toggleable settings.llm.debugRawRequests — so a one-click (no-CLI)
// operator can flip it from the admin UI without editing env. Off by default:
// when disabled nothing here runs (the registry never calls in), so there are
// no file writes and no overhead.
//
// Best-effort throughout — mirrors recordPick()/PICKS_LOG in log.ts: a write
// failure must never break (or block) a model call. Authorization/headers are
// never recorded; only method + URL + body (and key-bearing URL query params
// are masked, since e.g. Google carries the key as ?key=…).

import { mkdir, writeFile } from 'node:fs/promises';
import { STATE_DIR } from '../../../config.js';
import * as settings from '../../../settings.js';

// Keep only the last N raw requests (in memory + on disk), newest first.
export const LLM_DEBUG_MAX = 10;
// Generous per-body cap so one huge request can't run the file away.
const BODY_CAP = 32 * 1024;
// Where operators look. Surfaced in the /debug UI so it's findable.
export const LLM_DEBUG_LOG = `${STATE_DIR}/logs/llm-debug.log`;

// Process-level env flag, read once at startup. The settings toggle is read
// live (so it can be flipped from the admin UI without a restart); the env flag
// can only force capture ON, never off.
const ENV_ENABLED = /^(1|true|yes|on)$/i.test(process.env.LLM_DEBUG_RAW || '');

export function rawDebugEnabledViaEnv(): boolean {
  return ENV_ENABLED;
}

// Is capture on right now? Env flag OR the live settings toggle. Cheap: a cached
// boolean plus an in-memory settings read — safe to call on every request.
export function rawDebugEnabled(): boolean {
  if (ENV_ENABLED) return true;
  try {
    return settings.get()?.llm?.debugRawRequests === true;
  } catch {
    return false;
  }
}

// Mask key-bearing query params so the URL (which we deliberately record) can't
// leak a secret some providers pass in the query string (e.g. Google's ?key=).
const SECRET_QUERY_KEYS = new Set(['key', 'api_key', 'apikey', 'access_token', 'token']);
function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    let touched = false;
    for (const k of [...u.searchParams.keys()]) {
      if (SECRET_QUERY_KEYS.has(k.toLowerCase())) {
        u.searchParams.set(k, 'REDACTED');
        touched = true;
      }
    }
    return touched ? u.toString() : raw;
  } catch {
    return raw; // not a parseable absolute URL — leave it as-is
  }
}

// In-memory ring of the last LLM_DEBUG_MAX formatted entries, newest first.
const entries: string[] = [];

function format(method: string, url: string, body: string): string {
  const trimmed =
    body.length > BODY_CAP
      ? `${body.slice(0, BODY_CAP)}\n…[truncated ${body.length - BODY_CAP} chars]`
      : body;
  return [
    `===== ${new Date().toISOString()}  ${method} ${redactUrl(url)}`,
    '-----------------------------------------------------------------------------',
    trimmed,
    '',
  ].join('\n');
}

let dirReady = false;
async function ensureDir(): Promise<void> {
  if (dirReady) return;
  await mkdir(`${STATE_DIR}/logs`, { recursive: true });
  dirReady = true;
}

// Serialise file writes so the newest-enqueued snapshot is the one that lands on
// disk (out-of-order writeFile completions would otherwise leave a stale view).
let writeChain: Promise<void> = Promise.resolve();

// Capture one raw request. Fire-and-forget: callers MUST NOT await this — it
// rewrites the whole (bounded) file off the request's critical path. A full
// rewrite keeps the file at exactly LLM_DEBUG_MAX entries (no unbounded append).
export function recordRawRequest(method: string, url: string, body: string): void {
  const entry = format(method || 'POST', url || '', body || '');
  entries.unshift(entry);
  if (entries.length > LLM_DEBUG_MAX) entries.length = LLM_DEBUG_MAX;

  // Keep the legacy "dump to stderr" behaviour too, for operators already
  // grepping container logs.
  try {
    process.stderr.write(`[llm-debug-raw] ${entry}`);
  } catch { /* never break a model call */ }

  const snapshot = entries.join('\n');
  writeChain = writeChain.then(async () => {
    try {
      await ensureDir();
      await writeFile(LLM_DEBUG_LOG, snapshot);
    } catch { /* best-effort: never break a model call */ }
  });
}

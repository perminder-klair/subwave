// Ring buffer + durable log for listener requests — feeds the admin dashboard
// so every request and exactly how the AI DJ responded to it is inspectable.
// Modelled on music/subsonic-log.ts.
//
// routes/request.ts holds the live request ledger in an ephemeral 10-minute
// Map; this module is the *durable* record of outcomes: what was asked, which
// resolution path handled it, the track picked, the AI ack + full intro script,
// and timing. The in-memory ring feeds GET /requests; the JSONL file on the
// shared state volume survives restarts and is tail-loaded back into the ring
// on boot, so the dashboard still shows recent history after a recreate.
//
// JSONL (one object per line) rather than the tab-separated subsonic.log,
// because a request record carries the multi-line introScript.

import { appendFile } from 'node:fs/promises';
import { statSync, renameSync, readFileSync } from 'node:fs';
import { STATE_DIR } from '../config.js';

const MAX_REQUESTS = 150;
export const recentRequests: any[] = [];

const REQUESTS_LOG = `${STATE_DIR}/logs/requests.log`;
// Rotate to one .old backup at this cap, same policy as subsonic.log. Tuned
// tight — the ring + dashboard cover live observability; this file is just a
// few days of audit history.
const REQUESTS_LOG_MAX_BYTES = 10 * 1024 * 1024;

function maybeRotateLog() {
  try {
    if (statSync(REQUESTS_LOG).size > REQUESTS_LOG_MAX_BYTES) {
      renameSync(REQUESTS_LOG, `${REQUESTS_LOG}.old`);
    }
  } catch {}
}

// Boot hydration — seed the ring from the tail of the durable log so a restart
// doesn't blank the dashboard. Best-effort: a missing file, a missing logs/
// dir, or a malformed trailing line (e.g. a half-written append) is fine —
// skip lines that don't parse, keep the most recent MAX_REQUESTS, newest first.
function hydrateFromDisk() {
  try {
    const text = readFileSync(REQUESTS_LOG, 'utf8');
    const lines = text.split('\n').filter(Boolean).slice(-MAX_REQUESTS);
    for (const line of lines) {
      try {
        recentRequests.unshift(JSON.parse(line));
      } catch {}
    }
    if (recentRequests.length > MAX_REQUESTS) recentRequests.length = MAX_REQUESTS;
  } catch {}
}

maybeRotateLog();
hydrateFromDisk();
let _appendsSinceRotateCheck = 0;

// Append one resolved/failed request outcome. Best-effort — a serialise or disk
// failure must never break request handling, so callers fire-and-forget and the
// append is .catch-swallowed here.
export function record(entry: any) {
  recentRequests.unshift(entry);
  if (recentRequests.length > MAX_REQUESTS) recentRequests.length = MAX_REQUESTS;

  let line: string;
  try {
    line = JSON.stringify(entry) + '\n';
  } catch {
    return; // unserialisable entry — ring already has it, skip the file
  }
  if (++_appendsSinceRotateCheck >= 1000) {
    _appendsSinceRotateCheck = 0;
    maybeRotateLog();
  }
  appendFile(REQUESTS_LOG, line).catch(() => {});
}

// Most-recent N outcomes for the admin dashboard, newest first.
export function snapshot(limit = 50) {
  return recentRequests.slice(0, limit);
}

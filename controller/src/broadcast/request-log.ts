// Ring buffer + durable JSONL log of listener-request outcomes (routes/
// request.ts owns the ephemeral live ledger). The ring feeds GET /requests; the
// file is tail-loaded back into it on boot. JSONL rather than subsonic.log's
// tab-separated form because a record carries the multi-line introScript.

import { appendFile } from 'node:fs/promises';
import { statSync, renameSync, readFileSync } from 'node:fs';
import { STATE_DIR } from '../config.js';

const MAX_REQUESTS = 150;
export const recentRequests: any[] = [];

const REQUESTS_LOG = `${STATE_DIR}/logs/requests.log`;
// Rotate to one .old backup at this cap, same policy as subsonic.log.
const REQUESTS_LOG_MAX_BYTES = 10 * 1024 * 1024;

function maybeRotateLog() {
  try {
    if (statSync(REQUESTS_LOG).size > REQUESTS_LOG_MAX_BYTES) {
      renameSync(REQUESTS_LOG, `${REQUESTS_LOG}.old`);
    }
  } catch {}
}

// Boot hydration from the tail of the log. Best-effort: a missing file or a
// half-written trailing line is skipped, newest MAX_REQUESTS kept.
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

// Append one outcome. Best-effort: callers fire-and-forget and failures are
// swallowed, so a disk error never breaks request handling.
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

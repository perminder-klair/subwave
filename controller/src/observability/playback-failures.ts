// Confirmed controller handoff fetch failures, not decoder/corruption verdicts.
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { logEvent, EVENTS_MAX_AGE_DAYS } from './events.js';

export interface PlaybackFailureInput {
  attemptId: string;
  sourceTrackId?: string | null;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  source: 'ai' | 'request' | 'operator';
}
export interface PlaybackFailure extends PlaybackFailureInput {
  t: string;
  stage: 'fetch';
  reason: 'source-resolution-failed';
}

// Scalars only. Reject misplaced URIs and absolute paths as well as dropping
// all unrecognised fields; never persist an annotated URI or raw exception.
function scalar(value: unknown): string | null {
  if (typeof value !== 'string' || /(?:\w+:\/\/|^\/|^[A-Za-z]:\\|^annotate:)/.test(value)) return null;
  return value.slice(0, 500);
}
function identity(input: PlaybackFailureInput) {
  return {
    attemptId: scalar(input.attemptId), sourceTrackId: scalar(input.sourceTrackId),
    title: scalar(input.title), artist: scalar(input.artist), album: scalar(input.album),
    source: input.source, stage: 'fetch' as const, reason: 'source-resolution-failed' as const,
  };
}
export function recordPlaybackFailure(input: PlaybackFailureInput, emit: typeof logEvent = logEvent): void {
  try {
    const data = identity(input);
    if (!data.attemptId || !['ai', 'request', 'operator'].includes(input.source)) return;
    emit('track.failed', data);
  } catch { /* Observability must not interrupt queue recovery. */ }
}

function failureRow(row: unknown): PlaybackFailure | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  if (r.type !== 'track.failed' || r.stage !== 'fetch' || r.reason !== 'source-resolution-failed'
    || typeof r.source !== 'string' || !['ai', 'request', 'operator'].includes(r.source)
    || typeof r.t !== 'string' || !Number.isFinite(Date.parse(r.t))
    || typeof r.attemptId !== 'string') return null;
  const data = identity(r as unknown as PlaybackFailureInput);
  if (!data.attemptId) return null;
  return { ...data, attemptId: data.attemptId, t: new Date(r.t).toISOString() };
}
const newest = (a: PlaybackFailure, b: PlaybackFailure) => b.t.localeCompare(a.t) || a.attemptId.localeCompare(b.attemptId);

export async function readPlaybackFailures({ stationDir, now = new Date(), limit = 1000 }: {
  stationDir: string; now?: Date; limit?: number;
}): Promise<{ failures: PlaybackFailure[]; retentionDays: number; truncated: boolean; warnings: string[] }> {
  const bound = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.floor(limit))) : 1000;
  const warnings: string[] = [];
  let rows: PlaybackFailure[] = [];
  let truncated = false;
  const result = () => ({ failures: rows.slice(0, bound), retentionDays: EVENTS_MAX_AGE_DAYS, truncated, warnings });
  const dir = join(stationDir, 'logs');
  let names: string[];
  try { names = await readdir(dir); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push('Failure history could not be read.');
    return result();
  }
  const today = now.toISOString().slice(0, 10);
  const cutoff = new Date(now.getTime() - EVENTS_MAX_AGE_DAYS * 86_400_000).toISOString().slice(0, 10);
  const consume = (line: string) => {
    try {
      const row = failureRow(JSON.parse(line));
      if (!row || row.t.slice(0, 10) < cutoff || row.t.slice(0, 10) > today) return;
      const duplicate = rows.findIndex(r => r.attemptId === row.attemptId);
      if (duplicate >= 0) {
        if (newest(row, rows[duplicate]) >= 0) return;
        rows.splice(duplicate, 1);
      }
      rows.push(row);
      rows.sort(newest);
      if (rows.length > bound) { truncated = true; rows = rows.slice(0, bound); }
    } catch { /* Mixed, malformed or partial events are not failure records. */ }
  };
  for (const name of names.sort().reverse()) {
    const m = /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
    if (!m || m[1] < cutoff || m[1] > today || !Number.isFinite(Date.parse(`${m[1]}T00:00:00Z`)) || new Date(`${m[1]}T00:00:00Z`).toISOString().slice(0, 10) !== m[1]) continue;
    try {
      // Buffer at most one 16 KiB line. readline would accumulate an arbitrary
      // oversized line before we could reject it.
      let line = '';
      let oversized = false;
      for await (const chunk of createReadStream(join(dir, name), { encoding: 'utf8', highWaterMark: 16384 })) {
        for (const part of (chunk as string).split(/(?<=\n)/)) {
          if (!oversized) {
            if (line.length + part.length > 16384) { oversized = true; line = ''; }
            else line += part;
          }
          if (part.endsWith('\n')) {
            if (!oversized) consume(line);
            line = ''; oversized = false;
          }
        }
      }
      if (line && !oversized) consume(line);
    } catch { warnings.push('A retained event file could not be read; results may be incomplete.'); }
  }
  return result();
}

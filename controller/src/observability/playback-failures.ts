// Confirmed controller handoff fetch failures, not decoder/corruption verdicts.
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { logEvent, EVENTS_MAX_AGE_DAYS } from './events.js';
import {
  playbackFailureIdentitySchema, playbackFailureEventSchema,
  type PlaybackFailure, type PlaybackFailureInput, type PlaybackFailureHistory,
} from '../schemas/playback-failures.js';

export type { PlaybackFailure, PlaybackFailureInput } from '../schemas/playback-failures.js';

export function recordPlaybackFailure(input: PlaybackFailureInput, emit: typeof logEvent = logEvent): void {
  try {
    const result = playbackFailureIdentitySchema.safeParse(input);
    if (!result.success) return;
    emit('track.failed', { ...result.data, stage: 'fetch', reason: 'source-resolution-failed' });
  } catch { /* Observability must not interrupt queue recovery. */ }
}

function failureRow(row: unknown): PlaybackFailure | null {
  const result = playbackFailureEventSchema.safeParse(row);
  if (!result.success) return null;
  const { type: _type, ...failure } = result.data;
  return failure;
}
const newest = (a: PlaybackFailure, b: PlaybackFailure) => b.t.localeCompare(a.t) || a.attemptId.localeCompare(b.attemptId);

export async function readPlaybackFailures({ stationDir, now = new Date(), limit = 1000 }: {
  stationDir: string; now?: Date; limit?: number;
}): Promise<PlaybackFailureHistory> {
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

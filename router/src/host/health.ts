// Source health, three-state, derived from existing machinery rather than a
// separate probe protocol: a source that cannot be built is `not-configured`
// (missing settings) or `error` (plugin fault); one whose stats() — or, for a
// plugin without stats, genres() — throws is `unreachable` with the real
// error; otherwise `healthy` with live counts.

import type { Stats } from '../sdk/types.js';
import type { HostSource } from './types.js';

export type HealthState = 'healthy' | 'unreachable' | 'not-configured' | 'error';

export interface Health {
  state: HealthState;
  error?: string;
  stats?: Stats;
  ms?: number;
}

const PROBE_TIMEOUT_MS = 10_000;

export async function probe(source: HostSource): Promise<Health> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = (async (): Promise<Stats | undefined> => {
    if (source.capabilities.stats) return source.stats();
    await source.genres();
    return undefined;
  })();
  try {
    const stats = await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${PROBE_TIMEOUT_MS / 1000}s`)), PROBE_TIMEOUT_MS);
      }),
    ]);
    return { state: 'healthy', ...(stats ? { stats } : {}), ms: Date.now() - started };
  } catch (err) {
    return { state: 'unreachable', error: describe(err), ms: Date.now() - started };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// fetch() failures hide the useful part (ECONNREFUSED, ENOTFOUND) in `cause`.
export function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: unknown }).cause;
  const code = cause && typeof cause === 'object' && 'code' in cause ? String((cause as { code: unknown }).code) : '';
  const causeMsg = cause instanceof Error ? cause.message : '';
  if (err.message === 'fetch failed' && (code || causeMsg)) return `could not connect (${code || causeMsg})`;
  return err.message;
}

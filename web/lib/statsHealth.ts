// Traffic-light judgments for the numbers on the admin Stats page, in one place
// so every card agrees on what "worth a look" means (statsHealth.test.ts).
// Latency is reported but never judged: the default model is a slow homelab
// Ollama, and a latency light would sit amber forever. The music never stops for
// any of these, so "bad" means a listener can hear the DJ struggling, not that
// the station is off air.

export type Health = 'ok' | 'warn' | 'bad' | 'idle';

export interface HealthSignal {
  health: Health;
  note: string; // one plain-English line naming what drove the judgment
}

const share = (part: number, whole: number) => (whole > 0 ? part / whole : 0);

// Below this many calls one failure is a large share, so a rate can reach
// "worth a look" but not "needs attention": a fresh boot's first hiccup is not
// an emergency.
export const MIN_SAMPLE_FOR_BAD = 10;

const failing = (count: number): Health => (count >= MIN_SAMPLE_FOR_BAD ? 'bad' : 'warn');

export function llmHealth(l: { count: number; failed: number; successRate?: number }): HealthSignal {
  if (!l.count) return { health: 'idle', note: 'no model calls yet' };
  const rate = l.successRate ?? 1 - share(l.failed, l.count);
  const note = l.failed
    ? `${l.failed} of ${l.count} model calls failed`
    : `${l.count} model calls, none failed`;
  if (rate < 0.9) return { health: failing(l.count), note };
  if (rate < 0.95) return { health: 'warn', note };
  return { health: 'ok', note };
}

// A failed line is a link that never aired; a fallback aired in the backup
// voice. The second is audible but harmless, so it never goes past amber.
export function voiceFailureHealth(t: { count: number; failed: number }): HealthSignal {
  if (!t.count) return { health: 'idle', note: 'nothing spoken yet' };
  if (!t.failed) return { health: 'ok', note: `${t.count} lines spoken, none failed` };
  const note = `${t.failed} of ${t.count} lines failed to render`;
  return { health: share(t.failed, t.count) >= 0.1 ? failing(t.count) : 'warn', note };
}

export function voiceFallbackHealth(t: { count: number; fellBack: number }): HealthSignal {
  if (!t.count) return { health: 'idle', note: 'nothing spoken yet' };
  if (!t.fellBack) return { health: 'ok', note: 'every line in the main voice' };
  return {
    health: 'warn',
    note: `${t.fellBack} ${t.fellBack === 1 ? 'line' : 'lines'} used the backup voice`,
  };
}

export function requestsHealth(r: { count: number; failed: number; successRate?: number | null }): HealthSignal {
  if (!r.count) return { health: 'idle', note: 'no listener requests yet' };
  const rate = r.successRate ?? 1 - share(r.failed, r.count);
  const note = r.failed
    ? `${r.failed} of ${r.count} requests not found`
    : `${r.count} requests, all found`;
  if (rate < 0.8) return { health: failing(r.count), note };
  if (rate < 0.9) return { health: 'warn', note };
  return { health: 'ok', note };
}

export function loadHealth(
  host: { cpus: number; loadavg: [number, number, number] } | null | undefined,
): HealthSignal {
  if (!host?.cpus) return { health: 'idle', note: 'host load unknown' };
  const l1 = host.loadavg[0];
  const note = `load ${l1.toFixed(2)} on ${host.cpus} cores`;
  if (l1 > host.cpus) return { health: 'bad', note };
  if (l1 > host.cpus * 0.7) return { health: 'warn', note };
  return { health: 'ok', note };
}

// memUsed is total − available (the controller's /system), so page cache does
// not count against it and a busy-but-healthy host stays ok. The warning starts
// at the rack's 80% red zone.
export function memoryHealth(
  host: { memUsed: number; memTotal: number } | null | undefined,
): HealthSignal {
  if (!host?.memTotal) return { health: 'idle', note: 'host memory unknown' };
  const frac = share(host.memUsed, host.memTotal);
  const note = `${Math.round(frac * 100)}% in use`;
  if (frac >= 0.95) return { health: 'bad', note };
  if (frac >= 0.8) return { health: 'warn', note };
  return { health: 'ok', note };
}

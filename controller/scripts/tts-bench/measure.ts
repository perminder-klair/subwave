// Pure helpers for tts-bench: engine specs, the clip-analysis parse, pace
// outliers and the per-engine summary. Nothing here imports src/, so
// scripts/tts-bench-measure.test.ts pins it without a station.

export type EngineSpec = {
  label: string;           // the spec as typed, e.g. "remote:mini:Jasper"
  engine: string;
  voice: string;           // '' = the engine's own default
  cloudProvider?: string;
};

// `engine[:voice]`, and `cloud:provider[:voice]`. Everything after the engine
// (or the provider) is the voice, colons included: a Remote server's voice
// vocabulary is its own, and may use them.
export function parseEngineSpec(spec: string): EngineSpec {
  const label = spec.trim();
  const i = label.indexOf(':');
  const engine = (i < 0 ? label : label.slice(0, i)).trim();
  const rest = i < 0 ? '' : label.slice(i + 1);
  if (engine !== 'cloud') return { label, engine, voice: rest.trim() };
  const j = rest.indexOf(':');
  const cloudProvider = (j < 0 ? rest : rest.slice(0, j)).trim();
  return { label, engine, voice: j < 0 ? '' : rest.slice(j + 1).trim(), cloudProvider: cloudProvider || undefined };
}

// The one ffmpeg pass every clip gets. framelog=verbose for the same reason
// audio/clip-level.ts gives: ffmpeg 5.1 has no `quiet` level.
export const SILENCE_FLOOR_DB = -50;
export const CLIP_ANALYSIS_FILTER = `silencedetect=noise=${SILENCE_FLOOR_DB}dB:d=0.02,ebur128=peak=true:framelog=verbose`;

// Input duration from ffmpeg's stream banner, in seconds.
export function parseDurationSec(stderr: string): number | null {
  const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  if (!m) return null;
  const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return Number.isFinite(sec) && sec > 0 ? sec : null;
}

// ebur128's summary true peak (needs peak=true). -inf is a silent clip.
export function parseTruePeakDb(stderr: string): number | null {
  const at = stderr.lastIndexOf('Summary:');
  if (at < 0) return null;
  const m = /True peak:\s*Peak:\s*(-?\d+(?:\.\d+)?|-inf)\s*dBFS/.exec(stderr.slice(at));
  if (!m || m[1] === '-inf') return null;
  return Number(m[1]);
}

// Silence at the head and tail of a clip, in ms, from silencedetect's log.
// ffmpeg 8 closes a run that reaches the end of the file with a silence_end;
// 5.1, the version in the images, leaves it open. Both read the same here.
export function parseEdgeSilenceMs(stderr: string, durationSec: number): { leadMs: number; trailMs: number } {
  const runs: Array<{ start: number; end: number | null }> = [];
  for (const m of stderr.matchAll(/silence_(start|end):\s*(-?\d+(?:\.\d+)?)/g)) {
    const t = Math.max(0, Number(m[2]));
    if (m[1] === 'start') runs.push({ start: t, end: null });
    else if (runs.length && runs[runs.length - 1].end === null) runs[runs.length - 1].end = t;
    // A silence_end with no open run is a run that began at 0 on a build that
    // reports only its end.
    else runs.push({ start: 0, end: t });
  }
  const EDGE = 0.015;
  const head = runs.find((r) => r.start <= EDGE);
  const tail = [...runs].reverse().find((r) => r.end === null || r.end >= durationSec - EDGE);
  return {
    leadMs: head ? Math.round(((head.end ?? durationSec) - head.start) * 1000) : 0,
    trailMs: tail ? Math.round((durationSec - tail.start) * 1000) : 0,
  };
}

export type Outcome = 'ok' | 'fell-back' | 'thrown' | 'unavailable';

export interface BenchRecord {
  engine: string;          // EngineSpec.label
  line: string;
  category: string;
  iteration: number;
  cold: boolean;           // the engine's first render this run: model load included
  outcome: Outcome;
  engineUsed?: string;     // what actually spoke, when speak() rescued
  error?: string;
  ms: number;
  chars: number;           // of the text the engine was handed, after normalizeForSpeech
  sentText?: string;
  audioSec?: number;
  rtf?: number;            // render seconds per audio second; under 1 is faster than real time
  cps?: number;            // spoken characters per audio second
  paceRatio?: number;      // see flagPace()
  lufs?: number | null;
  truePeakDb?: number | null;
  leadMs?: number;
  trailMs?: number;
  flags: string[];
  clip?: string;           // relative to the report dir
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Nearest-rank percentile.
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

// Thresholds for the per-clip flags.
export const PACE_FAST = 1.4;
export const PACE_SLOW = 0.7;
export const LONG_LEAD_MS = 500;
export const LONG_TAIL_MS = 800;
// True peak, not sample peak. Piper normalises every clip to exactly 0 dBFS,
// which is not clipping in the file, but its intersample peaks land above full
// scale, and a lossy encode can clip those unless the level comes down first.
export const PEAK_OVER_DBTP = 0;

// A clip spoken much faster or slower than it should be is usually a broken
// render: words skipped or the tail cut off (fast), a loop or a long pause
// (slow). "Should be" has two parts, so both come out before the comparison:
// each engine's own speaking rate (its median pace across every line), and
// each line's own density (the median of that, across engines), since a line
// of numbers reads slower per character than a line of names. paceRatio is
// what is left, 1.0 being typical. It needs two engines to mean much.
export function flagPace(records: BenchRecord[]): void {
  const ok = records.filter((r) => r.outcome === 'ok' && r.cps);
  const byEngine = new Map<string, number>();
  for (const e of new Set(ok.map((r) => r.engine))) {
    byEngine.set(e, median(ok.filter((r) => r.engine === e).map((r) => r.cps!))!);
  }
  const rel = new Map(ok.map((r) => [r, r.cps! / byEngine.get(r.engine)!]));
  const byLine = new Map<string, number>();
  for (const l of new Set(ok.map((r) => r.line))) {
    byLine.set(l, median(ok.filter((r) => r.line === l).map((r) => rel.get(r)!))!);
  }
  for (const r of ok) {
    const ratio = rel.get(r)! / byLine.get(r.line)!;
    r.paceRatio = Math.round(ratio * 100) / 100;
    if (ratio > PACE_FAST) r.flags.push('pace-fast');
    if (ratio < PACE_SLOW) r.flags.push('pace-slow');
  }
}

// The flags that need nothing but the clip itself.
export function clipFlags(r: Pick<BenchRecord, 'leadMs' | 'trailMs' | 'truePeakDb'>): string[] {
  const flags: string[] = [];
  if ((r.leadMs ?? 0) > LONG_LEAD_MS) flags.push('long-lead');
  if ((r.trailMs ?? 0) > LONG_TAIL_MS) flags.push('long-tail');
  if (r.truePeakDb != null && r.truePeakDb > PEAK_OVER_DBTP) flags.push('peak-over');
  return flags;
}

export interface EngineSummary {
  engine: string;
  ok: number;
  failed: number;          // thrown or fell back
  unavailable: boolean;
  coldMs: number | null;
  warmP50Ms: number | null;
  warmP95Ms: number | null;
  rtfP50: number | null;   // warm renders only
  cps: number | null;
  lufs: number | null;     // median
  lufsSpread: number | null; // max - min: how far the level wanders line to line
  peakMaxDb: number | null;
  leadMs: number | null;
  trailMs: number | null;
  flagged: number;
}

const round = (n: number | null, dp = 0) => (n == null ? null : Math.round(n * 10 ** dp) / 10 ** dp);

export function summarize(records: BenchRecord[]): EngineSummary[] {
  const engines = [...new Set(records.map((r) => r.engine))];
  return engines.map((engine) => {
    const mine = records.filter((r) => r.engine === engine);
    const ok = mine.filter((r) => r.outcome === 'ok');
    const warm = ok.filter((r) => !r.cold);
    const cold = ok.find((r) => r.cold);
    const lufs = ok.map((r) => r.lufs).filter((v): v is number => v != null);
    const peaks = ok.map((r) => r.truePeakDb).filter((v): v is number => v != null);
    return {
      engine,
      ok: ok.length,
      failed: mine.filter((r) => r.outcome === 'thrown' || r.outcome === 'fell-back').length,
      unavailable: mine.length > 0 && mine.every((r) => r.outcome === 'unavailable'),
      coldMs: cold ? cold.ms : null,
      warmP50Ms: round(percentile(warm.map((r) => r.ms), 50)),
      warmP95Ms: round(percentile(warm.map((r) => r.ms), 95)),
      rtfP50: round(median(warm.map((r) => r.rtf!).filter((v) => v != null)), 3),
      cps: round(median(ok.map((r) => r.cps!).filter((v) => v != null)), 1),
      lufs: round(median(lufs), 1),
      lufsSpread: lufs.length ? round(Math.max(...lufs) - Math.min(...lufs), 1) : null,
      peakMaxDb: peaks.length ? round(Math.max(...peaks), 1) : null,
      leadMs: round(median(ok.map((r) => r.leadMs!).filter((v) => v != null))),
      trailMs: round(median(ok.map((r) => r.trailMs!).filter((v) => v != null))),
      flagged: ok.filter((r) => r.flags.length).length,
    };
  });
}

export function formatSummary(rows: EngineSummary[]): string {
  const cols: Array<[string, (r: EngineSummary) => string]> = [
    ['engine', (r) => r.engine],
    ['ok', (r) => (r.unavailable ? 'n/a' : String(r.ok))],
    ['fail', (r) => String(r.failed)],
    ['cold ms', (r) => fmt(r.coldMs)],
    ['warm p50', (r) => fmt(r.warmP50Ms)],
    ['warm p95', (r) => fmt(r.warmP95Ms)],
    ['RTF p50', (r) => fmt(r.rtfP50)],
    ['chars/s', (r) => fmt(r.cps)],
    ['LUFS', (r) => fmt(r.lufs)],
    ['spread', (r) => fmt(r.lufsSpread)],
    ['peak', (r) => fmt(r.peakMaxDb)],
    ['lead ms', (r) => fmt(r.leadMs)],
    ['tail ms', (r) => fmt(r.trailMs)],
    ['flagged', (r) => String(r.flagged)],
  ];
  const cells = [cols.map(([h]) => h), ...rows.map((r) => cols.map(([, f]) => f(r)))];
  const widths = cols.map((_, i) => Math.max(...cells.map((row) => row[i].length)));
  return cells
    .map((row) => row.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  '))
    .join('\n');
}

function fmt(n: number | null): string {
  return n == null ? '-' : String(n);
}

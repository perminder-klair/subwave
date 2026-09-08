// Single-flight tracking for the tagger/analyzer/reconcile child processes.
import { spawn, ChildProcess } from 'node:child_process';
import { queue } from './queue.js';
import * as coverage from '../music/library-coverage.js';
import { syncAllAfterTag } from '../music/playlist-sync.js';
import { PROGRESS_PREFIX, EVENT_PREFIX, type TaggerProgress, type TaggerEvent } from '../music/tagger-progress.js';
import { writePidfile, clearPidfile, readPidfile, isPidAlive, MANAGED_ENV } from '../music/tagger-lock.js';

type TaggerMode = 'tag' | 'analyze' | 'reconcile';

// Raw console line, or a structured event relayed on the child's EVENT_PREFIX channel.
type LogEntry = string | TaggerEvent;

// In-memory only. outcome: exit 0 → 'ok'; killed by a signal → 'stopped'; else 'failed'.
type TaggerLastRun = {
  mode: TaggerMode;
  outcome: 'ok' | 'failed' | 'stopped';
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string;
};

type TaggerState = {
  running: boolean;
  startedAt: string | null;
  pid: number | null;
  lastLog: LogEntry[];
  // Single-flight across all three modes — they contend on the same library DB.
  mode: TaggerMode | null;
  // Latest [progress] sentinel; left in place after exit, UI gates display on `running`.
  progress: TaggerProgress | null;
  lastRun: TaggerLastRun | null;
};

export const tagger: TaggerState = {
  running: false, startedAt: null, pid: null, lastLog: [], mode: null, progress: null, lastRun: null,
};

// Buffer is capped at 100 in-process; admin surfaces only get this tail.
const TAGGER_LOG_TAIL = 30;

// Single snapshot source so GET /settings and GET /library/tagger can't drift.
export function taggerView(): TaggerState {
  return { ...tagger, lastLog: tagger.lastLog.slice(-TAGGER_LOG_TAIL) };
}

function stripLogPrefix(s: string): string {
  return s.replace(/^\[(tag|analyze|stats|scheduler|error)\]\s*/, '');
}

// Prefer the last structured 'error' event; else the last raw line that reads like
// one. The keyword fallback never scans event text (song titles false-positive).
function lastErrorText(): string | null {
  for (let i = tagger.lastLog.length - 1; i >= 0; i--) {
    const e = tagger.lastLog[i];
    if (typeof e === 'object' && e.kind === 'error') return e.text;
  }
  for (let i = tagger.lastLog.length - 1; i >= 0; i--) {
    const e = tagger.lastLog[i];
    if (
      typeof e === 'string' &&
      /(fail(ed)?|error|unreachable|preflight)/i.test(e) &&
      !/fail=0|0 failed/i.test(e)
    ) {
      return stripLogPrefix(e);
    }
  }
  return null;
}

// Live handle for stopTagger() — cleared on the exit handler.
let activeChild: ChildProcess | null = null;

// Caller must reject when `tagger.running` is already true.
// re-* flags map to music/tag-library.ts: reseed (rebuild track_vectors + re-embed),
// reEnrich (Last.fm tags + lyrics), reAnalyze (acoustic bpm/key), upgrade (re-LLM-tag
// rows with a stale prompt/model).
export function startTagger(
  opts: {
    limit?: number;
    reseed?: boolean;
    reEnrich?: boolean;
    reAnalyze?: boolean;
    upgrade?: boolean;
    // "Re-embed, then continue tagging". Only honoured when reseed is the sole re-* pass.
    thenTag?: boolean;
    // Step toggles: undefined = run the step; false emits the skip flag.
    reconcile?: boolean;
    enrich?: boolean;
    tagMoods?: boolean;
    analyze?: boolean;
    // Per-run Demucs override; undefined defers to the setting.
    vocal?: boolean;
  } = {},
) {
  const { limit, reseed, reEnrich, reAnalyze, upgrade, thenTag, reconcile, enrich, tagMoods, analyze, vocal } = opts;
  const args = ['src/music/tag-library.ts'];
  if (Number.isFinite(limit) && (limit as number) > 0) args.push('--limit', String(limit));
  if (reseed) args.push('--reseed');
  if (reEnrich) args.push('--re-enrich');
  if (reAnalyze) args.push('--re-analyze');
  if (upgrade) args.push('--upgrade');
  // Any re-* pass adds --rescan, which scopes every pass to already-done tracks and
  // suppresses forward discovery. Exception: a reseed-only "then tag" chain drops
  // --rescan so the forward pass also tags the untagged remainder. Any other re-*
  // flag keeps --rescan scoping and ignores thenTag.
  const reseedOnly = !!reseed && !reEnrich && !reAnalyze && !upgrade;
  const chainTag = reseedOnly && thenTag === true;
  const rescan = !!(reseed || reEnrich || reAnalyze || upgrade) && !chainTag;
  if (rescan) args.push('--rescan');
  // Only an explicit `false` skips; undefined keeps the phase on.
  if (enrich === false) args.push('--skip-enrich');
  if (tagMoods === false) args.push('--skip-tag');
  if (analyze === false) args.push('--skip-analyze');
  if (reconcile === false) args.push('--no-prune');
  if (analyze !== false && vocal === true) args.push('--vocal');
  if (analyze !== false && vocal === false) args.push('--no-vocal');

  const detail = [
    Number.isFinite(limit) && (limit as number) > 0 ? `limit=${limit}` : null,
    rescan ? 'rescan' : null,
    chainTag ? 'then-tag' : null,
    reseed ? 'reseed' : null,
    reEnrich ? 're-enrich' : null,
    reAnalyze ? 're-analyze' : null,
    upgrade ? 'upgrade' : null,
    enrich === false ? 'skip-enrich' : null,
    tagMoods === false ? 'skip-tag' : null,
    analyze === false ? 'skip-analyze' : null,
    reconcile === false ? 'no-prune' : null,
    analyze !== false && vocal === true ? 'vocal' : null,
    analyze !== false && vocal === false ? 'no-vocal' : null,
  ]
    .filter(Boolean)
    .join(', ');
  spawnChild('tag', args, detail);
}

// Standalone analysis pass (bpm/key/intro + CLAP audio embeddings). `audio` and
// `vocal` force backfill scopes that re-target rows missing an audio vector /
// vocal_ranges_json. Same single-flight slot; caller rejects when tagger.running.
export function startAnalyzer(opts: { limit?: number; audio?: boolean; vocal?: boolean } = {}) {
  const { limit, audio, vocal } = opts;
  const args = ['src/music/analyze-library.ts'];
  if (Number.isFinite(limit) && (limit as number) > 0) args.push('--limit', String(limit));
  if (audio) args.push('--audio');
  if (vocal) args.push('--vocal');
  const detail = [
    Number.isFinite(limit) && (limit as number) > 0 ? `limit=${limit}` : null,
    audio ? 'audio' : null,
    vocal ? 'vocal' : null,
  ]
    .filter(Boolean)
    .join(', ');
  spawnChild('analyze', args, detail);
}

// Walk Navidrome and prune library rows it no longer contains. No embeddings, no
// LLM. The walk stamps era verdicts (#1418) and chains the incremental MusicBrainz
// original-year backfill. Same single-flight slot; caller rejects when running.
export function startReconcile() {
  spawnChild('reconcile', ['src/music/tag-library.ts', '--reconcile-only'], '');
}

function spawnChild(mode: TaggerMode, args: string[], detail: string) {
  const label = mode === 'tag' ? 'tagger' : mode === 'analyze' ? 'analyzer' : 'reconcile';
  // detached:true makes the child a process-GROUP leader so stopTagger can signal the
  // whole tree (npx → npm → sh → node tsx); child.pid alone is just the npx wrapper and
  // killing it orphans the real worker. Keep the stdio pipes and never unref().
  // MANAGED_ENV tells the CLI we own the pidfile written below.
  const child = spawn('npx', ['tsx', ...args], {
    cwd: '/app',
    detached: true,
    env: { ...process.env, [MANAGED_ENV]: '1' },
  });
  activeChild = child;
  const startedAt = new Date().toISOString();
  tagger.running = true;
  tagger.startedAt = startedAt;
  tagger.pid = child.pid ?? null;
  tagger.lastLog = [];
  tagger.mode = mode;
  tagger.progress = null;

  // A never-counted library nulls every panel percentage for the whole run. Guarded
  // on hasCount() so it fires at most once per install, not on every run.
  if (!coverage.hasCount()) coverage.refresh().catch(() => {});

  // Cross-restart lock: pid is the detached leader, so recoverFromRestart can
  // SIGTERM the whole group.
  if (child.pid) writePidfile({ pid: child.pid, mode, startedAt, args });

  // Per-stream line buffering: a `data` chunk can end mid-line, so each stream keeps
  // its own remainder. [progress] and [event] sentinels are kept out of the raw log.
  const makeCapture = () => {
    let remainder = '';
    return (chunk: Buffer) => {
      remainder += chunk.toString();
      const lines = remainder.split('\n');
      remainder = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith(PROGRESS_PREFIX)) {
          try {
            tagger.progress = JSON.parse(line.slice(PROGRESS_PREFIX.length)) as TaggerProgress;
          } catch { /* malformed sentinel — drop */ }
          continue;
        }
        if (line.startsWith(EVENT_PREFIX)) {
          try {
            const ev = JSON.parse(line.slice(EVENT_PREFIX.length)) as TaggerEvent;
            // makeEventLogger prints a terse echo just before this sentinel on the
            // same stream; drop it so the drawer has no duplicate line.
            const last = tagger.lastLog[tagger.lastLog.length - 1];
            if (typeof last === 'string' && stripLogPrefix(last) === ev.text) tagger.lastLog.pop();
            tagger.lastLog.push({ kind: ev.kind, text: ev.text, at: ev.at });
          } catch { /* malformed sentinel — drop */ }
          continue;
        }
        tagger.lastLog.push(line);
      }
      if (tagger.lastLog.length > 100) tagger.lastLog = tagger.lastLog.slice(-100);
    };
  };
  child.stdout.on('data', makeCapture());
  child.stderr.on('data', makeCapture());
  // An unhandled ChildProcess 'error' is thrown and would take the controller down,
  // so a failed spawn is reported like a non-zero exit instead. 'error' can also fire
  // after a successful spawn, where 'exit' owns the bookkeeping — hence the guard.
  child.on('error', (err) => {
    if (activeChild !== child) return;
    tagger.running = false;
    activeChild = null;
    clearPidfile();
    tagger.lastLog.push(`[error] ${err.message}`);
    tagger.lastRun = {
      mode,
      outcome: 'failed',
      exitCode: null,
      signal: null,
      error: err.message,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    queue.log('error', `${label} could not start: ${err.message}`);
  });
  child.on('exit', (code, signal) => {
    tagger.running = false;
    if (activeChild === child) activeChild = null;
    clearPidfile();
    tagger.lastLog.push(`[exit ${signal || code}]`);
    // Signal (incl. Stop / restart-kill) → 'stopped'; exit 0 → 'ok'; else 'failed'.
    const outcome: TaggerLastRun['outcome'] = signal ? 'stopped' : code === 0 ? 'ok' : 'failed';
    tagger.lastRun = {
      mode,
      outcome,
      exitCode: code,
      signal: signal ?? null,
      error: outcome === 'failed' ? lastErrorText() : null,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    // The run just walked the catalogue, and nothing else recounts unattended
    // (#1570), so this is the one moment the total can refresh unasked.
    coverage.refresh().catch(() => {});
    // Top up sync-enabled playlists (append-only). Fire-and-forget so a sync error
    // never touches the tagger's path.
    if (outcome === 'ok') syncAllAfterTag().catch(() => {});
    queue.log('scheduler', `${label} finished (${signal ? `signal ${signal}` : `exit ${code}`})`);
  });
  queue.log('scheduler', `${label} started${detail ? ` (${detail})` : ''}`);
}

// Called once from server.ts startup. A pidfile naming a live process group is a
// detached run that outlived a controller restart; terminate it so the next Start
// can't create a second writer on the library DB. A stale pidfile is cleared.
export function recoverFromRestart(): void {
  const info = readPidfile();
  if (!info) return;
  if (!isPidAlive(info.pid)) {
    clearPidfile();
    return;
  }
  const { pid } = info;
  // Negative pid → the whole group. Timer is unref'd so it never holds the loop open.
  try { process.kill(-pid, 'SIGTERM'); }
  catch { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
  setTimeout(() => {
    if (isPidAlive(pid)) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }, 5000).unref();
  const mode = (info.mode === 'analyze' || info.mode === 'reconcile' ? info.mode : 'tag') as TaggerMode;
  tagger.lastRun = {
    mode,
    outcome: 'stopped',
    exitCode: null,
    signal: 'SIGTERM',
    error: 'Interrupted by a controller restart — the previous run was terminated.',
    startedAt: info.startedAt,
    finishedAt: new Date().toISOString(),
  };
  clearPidfile();
  queue.log('scheduler', `previous ${label(mode)} run (pid ${pid}) terminated after a controller restart`);
}

function label(mode: TaggerMode): string {
  return mode === 'tag' ? 'tagger' : mode === 'analyze' ? 'analyzer' : 'reconcile';
}

// Signals the child; the exit handler above clears `tagger.running`.
export function stopTagger(): { stopped: boolean } {
  if (!activeChild || !tagger.running) return { stopped: false };
  const pid = activeChild.pid;
  try {
    if (pid) {
      // Negative PID → the whole group, so the node/tsx worker dies and not just the
      // npx wrapper. Fall back to the lone process if the group send fails.
      try { process.kill(-pid, 'SIGTERM'); }
      catch { activeChild.kill('SIGTERM'); }
      // The npm/sh wrappers and tsx loader don't always forward SIGTERM.
      setTimeout(() => {
        if (tagger.running) {
          try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
        }
      }, 5000);
    } else {
      activeChild.kill('SIGTERM');
    }
    queue.log('scheduler', 'tagger stop requested (SIGTERM → process group)');
    return { stopped: true };
  } catch (err: any) {
    queue.log('error', `tagger stop failed: ${err.message}`);
    return { stopped: false };
  }
}

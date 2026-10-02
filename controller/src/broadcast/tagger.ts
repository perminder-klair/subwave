// Single-flight tracking for the tagger/analyzer/reconcile child processes.
import { spawn, ChildProcess } from 'node:child_process';
import { queue } from './queue.js';
import * as coverage from '../music/library-coverage.js';
import * as subsonic from '../music/subsonic.js';
import * as library from '../music/library.js';
import * as libraryDb from '../music/library-db.js';
import * as blocklist from '../music/blocklist.js';
import { clearPoolCache } from '../music/picker.js';
import { clearPlaylistCache } from '../music/show-playlist.js';
import { syncAllAfterTag } from '../music/playlist-sync.js';
import { applyPendingRotation } from '../music/id-rotation.js';
import { createIdRotationRecovery, type RotationRecoveryResult, type RotatedIdEvidence } from '../music/id-rotation-recovery.js';
import { refreshTaggerFallback, runTaggerFollowups, type MaintenanceMode } from './tagger-followups.js';
import { PROGRESS_PREFIX, EVENT_PREFIX, ROTATION_PREFIX, CATALOGUE_PREFIX, type TaggerProgress, type TaggerEvent, type TaggerRotation } from '../music/tagger-progress.js';
import { writePidfile, clearPidfile, readPidfile, isPidAlive, MANAGED_ENV } from '../music/tagger-lock.js';

type TaggerMode = MaintenanceMode;

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

const idRotationRecovery = createIdRotationRecovery({
  maintenanceRunning: () => tagger.running,
  getSong: subsonic.getSong,
  startReconcile: (evidence) => {
    // Re-check at the mutation boundary: detection performed network I/O and a
    // manual maintenance run may have started while it was awaiting Navidrome.
    if (tagger.running) return false;
    startReconcile({ automaticIdRotation: evidence });
    return true;
  },
  log: (message) => queue.log('scheduler', message),
});

// Called fire-and-forget from the push-resolution failure path. The recovery
// owns its single-flight guard and only starts a walk after both halves of the
// old-id -> canonical-id proof have landed.
export function considerIdRotationRecovery(track: {
  id?: string | null;
  title?: string | null;
  artist?: string | null;
}): Promise<RotationRecoveryResult> {
  return idRotationRecovery.inspect(track);
}

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

// applyPendingRotation serializes boot, sentinel and exit attempts itself.
// Failed/deferred state writes must hold the post-tag playlist sync.
async function applyRotationNow(): Promise<boolean> {
  try {
    return (await applyPendingRotation()).complete;
  } catch (err: any) {
    queue.log('error', `id-rotation state migration failed (will retry): ${err?.message || err}`);
    return false;
  }
}

// Spawn the tagger as a detached-from-our-event-loop child process. Caller is
// responsible for rejecting the request if `tagger.running` is already true.
// The re-* flags map straight to music/tag-library.ts: `reseed` drops + rebuilds
// track_vectors and re-embeds from scratch (embedding-model-swap recovery),
// `reEnrich` re-fetches Last.fm tags + lyrics, `reAnalyze` redoes acoustic
// bpm/key, `upgrade` re-LLM-tags rows whose prompt/model is stale. A "full
// re-scan" from the admin UI is reseed + reEnrich + reAnalyze together.
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
export function startReconcile(opts: { automaticIdRotation?: RotatedIdEvidence } = {}) {
  spawnChild(
    'reconcile',
    ['src/music/tag-library.ts', '--reconcile-only'],
    opts.automaticIdRotation ? 'automatic Navidrome ID-rotation recovery' : '',
    opts,
  );
}

function spawnChild(
  mode: TaggerMode,
  args: string[],
  detail: string,
  opts: { automaticIdRotation?: RotatedIdEvidence } = {},
) {
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

  let catalogueReady = false;
  let earlyRefresh: Promise<boolean> | null = null;
  const invalidatePools = async () => {
    clearPoolCache();
    clearPlaylistCache();
    // Playlist rules have their own pre-resolved member sets, also containing
    // song IDs. Refresh them before the fallback's absolute blocklist checks.
    await blocklist.refreshPlaylistMembers();
  };
  const refreshAutoPlaylist = async () => {
    const scheduler = await import('./scheduler.js');
    await scheduler.refreshAutoPlaylist();
  };
  const logError = (message: string) => queue.log('error', message);
  const refreshAfterCatalogue = async (): Promise<boolean> => refreshTaggerFallback({
    rotationSettled: await applyRotationNow(), invalidatePools, refreshAutoPlaylist, logError,
  });

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
        if (line.startsWith(ROTATION_PREFIX)) {
          try {
            const rot = JSON.parse(line.slice(ROTATION_PREFIX.length)) as TaggerRotation;
            queue.log('scheduler', `id-rotation: adopted ${rot.adopted} rotated Navidrome id(s) — migrating state files`);
            void applyRotationNow();
          } catch { /* malformed sentinel — drop; the exit handler retries */ }
          continue;
        }
        if (line.startsWith(CATALOGUE_PREFIX)) {
          try {
            const { walked } = JSON.parse(line.slice(CATALOGUE_PREFIX.length));
            if (Number.isSafeInteger(walked) && walked > 0 && !catalogueReady) {
              catalogueReady = true;
              // The child may now spend hours enriching. Repair the air path
              // as soon as its complete walk and durable migration allow it.
              earlyRefresh = refreshAfterCatalogue().catch((err: unknown) => {
                logError(`catalogue fallback recovery failed: ${err instanceof Error ? err.message : String(err)}`);
                return false;
              });
            }
          } catch { /* malformed sentinel — exit retries */ }
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
    if (opts.automaticIdRotation) idRotationRecovery.automaticReconcileFailed();
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
    if (opts.automaticIdRotation && outcome !== 'ok') idRotationRecovery.automaticReconcileFailed();
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
    // Apply even after Stop/failure: adoption may already have committed.
    // Recipes must be migrated before sync can classify a playlist as missing.
    // Await an early build before the exit fallback; otherwise an older build
    // could finish after the newer one and overwrite it with a stale snapshot.
    Promise.resolve(earlyRefresh)
      .then(async (fallbackRefreshed) => {
        const settled = await applyRotationNow();
        if (!settled) {
          queue.log('error', 'playlist sync skipped — id-rotation state migration is still pending');
          if (opts.automaticIdRotation && outcome === 'ok') idRotationRecovery.automaticReconcileFailed();
          return;
        }
        const fallbackRestored = await runTaggerFollowups({
          mode,
          outcome,
          rotationSettled: settled,
          // A full tag run changes moods after its early rebuild, so it still
          // needs the normal final rebuild. Reconcile adds no later pool data.
          fallbackRefreshed: mode === 'reconcile' && fallbackRefreshed === true,
          syncPlaylists: syncAllAfterTag,
          invalidatePools,
          refreshAutoPlaylist,
          logError,
        });
        if (opts.automaticIdRotation && outcome === 'ok') {
          await library.load();
          const { storedId, canonicalId } = opts.automaticIdRotation;
          // Exit zero can mean a transient empty/no-op walk. Suppress future
          // probes only when this run actually repaired the confirmed track.
          if (!catalogueReady || !fallbackRestored || libraryDb.getTrack(storedId) || !libraryDb.getTrack(canonicalId)) {
            idRotationRecovery.automaticReconcileFailed();
          }
        }
      })
      .catch(() => {
        if (opts.automaticIdRotation && outcome === 'ok') idRotationRecovery.automaticReconcileFailed();
      });
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

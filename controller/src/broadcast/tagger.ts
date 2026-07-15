// Background tagger process tracking (single-flight). The tagger is a
// standalone script (music/tag-library.js) spawned as a child process; this
// module holds the live state shared between the routes that start it
// (/tag-library) and the ones that report on it (/settings).
import { spawn, ChildProcess } from 'node:child_process';
import { queue } from './queue.js';
import * as coverage from '../music/library-coverage.js';
import { syncAllAfterTag } from '../music/playlist-sync.js';
import { PROGRESS_PREFIX, EVENT_PREFIX, type TaggerProgress, type TaggerEvent } from '../music/tagger-progress.js';
import { writePidfile, clearPidfile, readPidfile, isPidAlive, MANAGED_ENV } from '../music/tagger-lock.js';

type TaggerMode = 'tag' | 'analyze' | 'reconcile';

// A captured log line is either a raw string (untouched console output) or a
// structured event relayed from the child's EVENT_PREFIX channel. The web panel
// is the only consumer of this payload; it renders strings via a slim beautifier
// and events by kind.
type LogEntry = string | TaggerEvent;

// Summary of the most-recently-finished run, kept in memory (no disk) so the
// idle panel can surface a failure instead of burying `[exit 1]` in the log
// drawer. `outcome`: exit 0 → 'ok'; killed by a signal (Stop button, or the
// restart-kill in recoverFromRestart) → 'stopped'; any non-zero exit → 'failed'.
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
  // Which script the live child is: 'tag' (tag-library), 'analyze' (the
  // acoustic/audio-embedding pass via analyze-library), or 'reconcile' (the
  // tag-library --reconcile-only walk+prune). Single-flight across all three —
  // they contend on the same library DB and analysis backend.
  mode: TaggerMode | null;
  // Latest structured progress sentinel from the child ([progress] lines on
  // stdout — see music/tagger-progress.ts). Left in place after exit so the
  // last payload doubles as a what-just-finished summary; the UI gates its
  // display on `running`.
  progress: TaggerProgress | null;
  // Outcome of the last run, or null before any run this process lifetime.
  lastRun: TaggerLastRun | null;
};

export const tagger: TaggerState = {
  running: false, startedAt: null, pid: null, lastLog: [], mode: null, progress: null, lastRun: null,
};

// How many trailing log entries the admin surfaces receive. The full buffer is
// capped at 100 in-process; the UI only ever renders the recent tail.
const TAGGER_LOG_TAIL = 30;

// The tagger snapshot the admin routes serialise — full state with lastLog sliced
// to the recent tail. Single source so GET /settings and GET /library/tagger
// can't drift on how much log they ship (they poll at different cadences).
export function taggerView(): TaggerState {
  return { ...tagger, lastLog: tagger.lastLog.slice(-TAGGER_LOG_TAIL) };
}

// Strip a module's console tag so a plain echo can be matched against its event
// text (for the capture-side de-dup below), and so the last-error fallback reads
// cleanly.
function stripLogPrefix(s: string): string {
  return s.replace(/^\[(tag|analyze|stats|scheduler|error)\]\s*/, '');
}

// Best error text for lastRun.error: prefer the last structured 'error' event
// (authoritative — the child declared it a failure), else fall back to the last
// raw line that reads like one. The keyword fallback lives here (server-side)
// now, off the operator's screen, and never scans event text — so it can't
// false-positive on a song title carried inside an [llm-debug-raw] dump.
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
    // "Re-embed, then continue tagging" chain (the stale-embedding banner's
    // "Re-embed now"). Only honoured when reseed is the SOLE re-* pass — see the
    // --rescan suppression below.
    thenTag?: boolean;
    // Forward-run step toggles from the admin Run tab. undefined = run the step
    // (back-compat: callers that omit these get a full run); false emits the
    // matching skip flag. Reconcile-*only* is a separate path (startReconcile).
    reconcile?: boolean;
    enrich?: boolean;
    tagMoods?: boolean;
    analyze?: boolean;
    // Per-run Demucs override (only meaningful when analyze runs). true forces
    // the vocal pass on, false forces it off; undefined defers to the setting.
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
  // Any re-* pass means this came from the admin Re-scan tab → --rescan, which
  // scopes every pass to already-done tracks and suppresses forward discovery of
  // the untagged remainder. (Raw CLI re-* flags without --rescan keep their
  // documented per-flag, full-library meaning.)
  //
  // Exception — the reseed-only "then tag" chain: dropping --rescan runs raw
  // --reseed, whose forward pass drops all vectors, RE-EMBEDS THE WHOLE LIBRARY
  // (phaseEmbed's allTaggedIds sweep re-vectorises the tagged set the drop wiped),
  // then seed→propagate→active-learn tags the untagged remainder — exactly the run
  // the stale-embedding banner was blocking. Only when reseed is the sole re-*
  // pass: mixing forward discovery into a targeted reEnrich/reAnalyze/upgrade
  // re-scan isn't well-defined, so any other re-* flag keeps today's --rescan
  // scoping and ignores thenTag.
  const reseedOnly = !!reseed && !reEnrich && !reAnalyze && !upgrade;
  const chainTag = reseedOnly && thenTag === true;
  const rescan = !!(reseed || reEnrich || reAnalyze || upgrade) && !chainTag;
  if (rescan) args.push('--rescan');
  // Step deselections → skip flags. Only an explicit `false` skips; undefined
  // leaves the phase on so omitting the fields keeps the legacy full-run.
  if (enrich === false) args.push('--skip-enrich');
  if (tagMoods === false) args.push('--skip-tag');
  if (analyze === false) args.push('--skip-analyze');
  if (reconcile === false) args.push('--no-prune');
  // Vocal override only applies when the analyze phase actually runs.
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

// Spawn the standalone analysis pass (bpm/key/intro + CLAP audio embeddings
// when settings.audio.embeddings / ANALYZE_AUDIO_EMBEDDING is on). `audio`
// forces the --audio backfill scope so already-analysed tracks that lack an
// audio vector are re-targeted — what the admin "Analyze audio" button wants.
// Same single-flight state as the tagger; caller rejects when tagger.running.
// `vocal` forces the --vocal Demucs backfill scope (re-targets tracks missing
// vocal_ranges_json) — what the admin "Backfill vocal analysis" button wants.
export function startAnalyzer(opts: { limit?: number; audio?: boolean; vocal?: boolean } = {}) {
  // No --skip-walk: the script's default policy (walk Navidrome only when the
  // catalogue is empty) is the right bootstrap for a first-ever run.
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

// Spawn the standalone reconcile pass: walk Navidrome and prune library rows
// for tracks it no longer contains. No embeddings, no LLM — the cheap "clear
// orphaned entries" path behind the admin "Reconcile with Navidrome" button.
// Same single-flight slot as the tagger/analyzer; caller rejects when running.
export function startReconcile() {
  spawnChild('reconcile', ['src/music/tag-library.ts', '--reconcile-only'], '');
}

function spawnChild(mode: TaggerMode, args: string[], detail: string) {
  const label = mode === 'tag' ? 'tagger' : mode === 'analyze' ? 'analyzer' : 'reconcile';
  // detached:true makes the child a process-GROUP leader, so stopTagger can
  // signal the whole tree at once (npx → npm → sh → node tsx → loader). Without
  // it, child.pid is just the npx wrapper — SIGTERM'ing it killed the wrapper
  // and ORPHANED the real worker, which kept tagging (the broken-Stop bug). We
  // keep the stdio pipes and never unref(), so capture + exit tracking still work.
  // MANAGED_ENV tells the CLI it was spawned by us so it won't fight over the
  // pidfile we write below (the file names the wrapper — the CLI's own ancestor).
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

  // Write the cross-restart lock: pid is the detached leader, so recoverFromRestart
  // can SIGTERM the whole group after a controller restart. Guarded on a real pid.
  if (child.pid) writePidfile({ pid: child.pid, mode, startedAt, args });

  // Per-stream line buffering: a `data` chunk can end mid-line, so each stream
  // keeps its own remainder. [progress] sentinel lines feed tagger.progress and
  // [event] lines become structured lastLog entries — both kept out of the raw
  // log stream.
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
            // makeEventLogger prints the terse `[tag] …` echo immediately before
            // this sentinel (same stdout stream), so drop that trailing echo and
            // keep only the structured entry — no duplicate line in the drawer.
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
    // The run just walked the whole Navidrome catalogue, so library-coverage's
    // 6h-TTL total is now the stalest number on the page — refresh it in the
    // background (fire-and-forget) so the hero meter reflects the fresh count.
    coverage.refresh().catch(() => {});
    // A clean tagging/reconcile run may have added new library songs — top up any
    // sync-enabled playlists (append-only, no-op when none exist). Fire-and-forget
    // so a sync error never touches the tagger's own path.
    if (outcome === 'ok') syncAllAfterTag().catch(() => {});
    queue.log('scheduler', `${label} finished (${signal ? `signal ${signal}` : `exit ${code}`})`);
  });
  queue.log('scheduler', `${label} started${detail ? ` (${detail})` : ''}`);
}

// Boot recovery — called once from server.ts startup. If a pidfile names a live
// process group, it's a run we lost track of across a controller restart (the
// child is detached and kept running while our in-memory state reset). Terminate
// it so the next Start can't create a second writer on the library DB, and record
// the interruption so the panel shows why the run ended. A stale pidfile (dead
// pid — e.g. a fresh container with a new pid namespace) is silently cleared.
export function recoverFromRestart(): void {
  const info = readPidfile();
  if (!info) return;
  if (!isPidAlive(info.pid)) {
    clearPidfile();
    return;
  }
  const { pid } = info;
  // Negative pid → the whole group (detached leader), escalating to SIGKILL like
  // stopTagger; the timer is unref'd so it never holds the event loop open.
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

// Stop the running tagger by signalling its child. The exit handler above
// flips `tagger.running` false once the process actually exits.
// Returns { stopped: true } if a signal was sent, { stopped: false } if no
// process was running.
export function stopTagger(): { stopped: boolean } {
  if (!activeChild || !tagger.running) return { stopped: false };
  const pid = activeChild.pid;
  try {
    if (pid) {
      // Negative PID → signal the whole process GROUP (the child is its leader,
      // detached:true above), so the actual node/tsx worker dies, not just the
      // npx wrapper. Fall back to the lone process if the group send fails.
      try { process.kill(-pid, 'SIGTERM'); }
      catch { activeChild.kill('SIGTERM'); }
      // Escalate to SIGKILL on the group if it's still alive after 5s — the
      // npm/sh wrappers and the tsx loader don't always forward SIGTERM.
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

// Background tagger process tracking (single-flight). The tagger is a
// standalone script (music/tag-library.js) spawned as a child process; this
// module holds the live state shared between the routes that start it
// (/tag-library) and the ones that report on it (/settings).
import { spawn, ChildProcess } from 'node:child_process';
import { queue } from './queue.js';
import { PROGRESS_PREFIX, type TaggerProgress } from '../music/tagger-progress.js';

type TaggerState = {
  running: boolean;
  startedAt: string | null;
  pid: number | null;
  lastLog: string[];
  // Which script the live child is: 'tag' (tag-library), 'analyze' (the
  // acoustic/audio-embedding pass via analyze-library), or 'reconcile' (the
  // tag-library --reconcile-only walk+prune). Single-flight across all three —
  // they contend on the same library DB and analysis backend.
  mode: 'tag' | 'analyze' | 'reconcile' | null;
  // Latest structured progress sentinel from the child ([progress] lines on
  // stdout — see music/tagger-progress.ts). Left in place after exit so the
  // last payload doubles as a what-just-finished summary; the UI gates its
  // display on `running`.
  progress: TaggerProgress | null;
};

export const tagger: TaggerState = {
  running: false, startedAt: null, pid: null, lastLog: [], mode: null, progress: null,
};

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
  const { limit, reseed, reEnrich, reAnalyze, upgrade, reconcile, enrich, tagMoods, analyze, vocal } = opts;
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
  const rescan = !!(reseed || reEnrich || reAnalyze || upgrade);
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

function spawnChild(mode: 'tag' | 'analyze' | 'reconcile', args: string[], detail: string) {
  const label = mode === 'tag' ? 'tagger' : mode === 'analyze' ? 'analyzer' : 'reconcile';
  // detached:true makes the child a process-GROUP leader, so stopTagger can
  // signal the whole tree at once (npx → npm → sh → node tsx → loader). Without
  // it, child.pid is just the npx wrapper — SIGTERM'ing it killed the wrapper
  // and ORPHANED the real worker, which kept tagging (the broken-Stop bug). We
  // keep the stdio pipes and never unref(), so capture + exit tracking still work.
  const child = spawn('npx', ['tsx', ...args], { cwd: '/app', detached: true });
  activeChild = child;
  tagger.running = true;
  tagger.startedAt = new Date().toISOString();
  tagger.pid = child.pid ?? null;
  tagger.lastLog = [];
  tagger.mode = mode;
  tagger.progress = null;

  // Per-stream line buffering: a `data` chunk can end mid-line, so each stream
  // keeps its own remainder. [progress] sentinel lines are parsed into
  // tagger.progress and kept out of lastLog.
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
    tagger.lastLog.push(`[exit ${signal || code}]`);
    queue.log('scheduler', `${label} finished (${signal ? `signal ${signal}` : `exit ${code}`})`);
  });
  queue.log('scheduler', `${label} started${detail ? ` (${detail})` : ''}`);
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

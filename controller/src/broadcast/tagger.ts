// Background tagger process tracking (single-flight). The tagger is a
// standalone script (music/tag-library.js) spawned as a child process; this
// module holds the live state shared between the routes that start it
// (/tag-library) and the ones that report on it (/settings).
import { spawn, ChildProcess } from 'node:child_process';
import { queue } from './queue.js';

type TaggerState = {
  running: boolean;
  startedAt: string | null;
  pid: number | null;
  lastLog: string[];
};

export const tagger: TaggerState = { running: false, startedAt: null, pid: null, lastLog: [] };

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
  } = {},
) {
  const { limit, reseed, reEnrich, reAnalyze, upgrade } = opts;
  const args = ['src/music/tag-library.ts'];
  if (Number.isFinite(limit) && (limit as number) > 0) args.push('--limit', String(limit));
  if (reseed) args.push('--reseed');
  if (reEnrich) args.push('--re-enrich');
  if (reAnalyze) args.push('--re-analyze');
  if (upgrade) args.push('--upgrade');

  const child = spawn('npx', ['tsx', ...args], { cwd: '/app', detached: false });
  activeChild = child;
  tagger.running = true;
  tagger.startedAt = new Date().toISOString();
  tagger.pid = child.pid ?? null;
  tagger.lastLog = [];

  const capture = (chunk: Buffer) => {
    const lines = chunk.toString().split('\n').filter((l: string) => l.trim());
    tagger.lastLog.push(...lines);
    if (tagger.lastLog.length > 100) tagger.lastLog = tagger.lastLog.slice(-100);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('exit', (code, signal) => {
    tagger.running = false;
    if (activeChild === child) activeChild = null;
    tagger.lastLog.push(`[exit ${signal || code}]`);
    queue.log('scheduler', `tagger finished (${signal ? `signal ${signal}` : `exit ${code}`})`);
  });
  const detail = [
    Number.isFinite(limit) && (limit as number) > 0 ? `limit=${limit}` : null,
    reseed ? 'reseed' : null,
    reEnrich ? 're-enrich' : null,
    reAnalyze ? 're-analyze' : null,
    upgrade ? 'upgrade' : null,
  ]
    .filter(Boolean)
    .join(', ');
  queue.log('scheduler', `tagger started${detail ? ` (${detail})` : ''}`);
}

// Stop the running tagger by signalling its child. The exit handler above
// flips `tagger.running` false once the process actually exits.
// Returns { stopped: true } if a signal was sent, { stopped: false } if no
// process was running.
export function stopTagger(): { stopped: boolean } {
  if (!activeChild || !tagger.running) return { stopped: false };
  try {
    activeChild.kill('SIGTERM');
    queue.log('scheduler', 'tagger stop requested (SIGTERM)');
    return { stopped: true };
  } catch (err: any) {
    queue.log('error', `tagger stop failed: ${err.message}`);
    return { stopped: false };
  }
}

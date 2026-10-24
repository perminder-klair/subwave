import type { LiveNotesItem } from './live-summary.js';
import { dashboardReadInDatabase, type DashboardRead } from './dashboard-reads.js';
import { searchResearchStoriesInDatabase } from './research-repository.js';
import {externalDiscoveriesInDatabase} from './external-discoveries.js';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { open } from './db.js';
import { buildConnectionLibraryPatch, connectionRevision, publishConnectionLibraryPatch,
  type ConnectionLibraryPatch } from './library-connections.js';
import { researchConnectionsOverviewInDatabase } from './connections-overview.js';
import type { ConnectionEdgeType } from './research-repository.js';

let child: ChildProcess | null = null;
let sequence = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> }>();
const cache = new Map<string, { revision: number; json: string }>();
const dashboardCache = new Map<string, { until: number; json: string }>();
const dashboardFlights = new Map<string, Promise<string>>();
let dashboardEpoch = 0;
const inFlight = new Map<string, Promise<string>>();

function clearIdleTimer() { if (idleTimer) clearTimeout(idleTimer); idleTimer = null; }
function releaseWhenIdle() {
  clearIdleTimer();
  if (!pending.size) { child?.channel?.unref(); idleTimer = setTimeout(stopConnectionCompute, 60_000).unref(); }
}
export function stopConnectionCompute(): void {
  clearIdleTimer();
  const previous = child;
  child = null;
  previous?.kill();
  for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('Connection worker stopped')); }
  pending.clear();
}

/** Restored revisions may equal old values while their actual facts differ. */
export function clearConnectionComputeCache():void {
  stopConnectionCompute();cache.clear();inFlight.clear();
  dashboardEpoch++;dashboardCache.clear();dashboardFlights.clear();
}

function compute<T>(path: string, kind: 'overview' | 'matches' | 'discoveries' | 'library-stories' | 'dashboard', edges?: readonly ConnectionEdgeType[], input?: Parameters<typeof searchResearchStoriesInDatabase>[1], dashboard?: DashboardRead): Promise<T> {
  clearIdleTimer();
  if (!child) {
    const proc = fork(fileURLToPath(new URL('./connection-compute-worker.ts', import.meta.url)), [], {
      execArgv: ['--import', import.meta.resolve('tsx')],
      serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    child = proc;
    proc.stderr?.on('data', (chunk: Buffer) => console.warn('[sleeve-notes] Connection worker:', chunk.toString().trim()));
    const failed = (error: Error) => { if (child === proc) { stopConnectionCompute(); console.warn('[sleeve-notes]', error.message); } };
    proc.on('error', failed);
    proc.on('exit', (code) => failed(new Error(`Connection worker exited (${code})`)));
    proc.on('message', (message: { id: number; result?: unknown; error?: string }) => {
      const call = pending.get(message.id);
      if (!call) return;
      clearTimeout(call.timer); pending.delete(message.id);
      if (message.error) call.reject(new Error(message.error)); else call.resolve(message.result);
      releaseWhenIdle();
    });
    proc.unref(); proc.channel?.unref();
  }
  const proc = child;
  proc.channel?.ref();
  return new Promise<T>((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      stopConnectionCompute();
      reject(new Error('Connection calculation timed out'));
    }, 60_000).unref();
    pending.set(id, { resolve: (result) => resolve(result as T), reject, timer });
    proc.send({ id, path, kind, edges, input, dashboard }, (error) => {
      if (error) {
        clearTimeout(timer); pending.delete(id); reject(error); releaseWhenIdle();
      }
    });
  });
}

export async function reconcileConnectionsInBackground(db: Database.Database): Promise<number | null> {
  const patch = db.memory ? buildConnectionLibraryPatch(db)
    : await compute<ConnectionLibraryPatch>(db.name, 'matches');
  return publishConnectionLibraryPatch(db, patch) ? patch.factsRevision : null;
}

/** O(1) invalidation, shared in-flight reads, bounded cache, pre-serialized JSON. */
export function cachedConnectionsOverview(edges: readonly ConnectionEdgeType[], kind: 'overview'|'discoveries'='overview', refresh=false, db=open()): Promise<string> {
  const revision = connectionRevision(db, 'overview');
  const key = JSON.stringify([db.name, kind, [...edges].sort()]);
  const saved = cache.get(key);
  if (!refresh && saved?.revision === revision) return Promise.resolve(saved.json);
  const flightKey = `${key}:${revision}`;
  const running = inFlight.get(flightKey);
  if (running) return running;
  const task = (async () => {
    const result = db.memory ? { revision, json: JSON.stringify(kind==='discoveries'?externalDiscoveriesInDatabase(db):{ active: true, ...researchConnectionsOverviewInDatabase(db, edges) }) }
      : await compute<{ revision: number; json: string }>(db.name, kind, edges);
    // A computed snapshot stays internally consistent even if fresh facts
    // arrive during the calculation; the next read will see the new revision.
    const current = cache.get(key);
    if (!current || current.revision <= result.revision) {
      cache.delete(key); cache.set(key, result);
      while (cache.size > 4) cache.delete(cache.keys().next().value!);
    }
    return result.json;
  })().finally(() => { inFlight.delete(flightKey); });
  inFlight.set(flightKey, task);
  return task;
}


/** Keep relationship grouping and page selection off the broadcast event loop. */
export async function libraryConnectionStoriesInBackground(db: Database.Database, input: Parameters<typeof searchResearchStoriesInDatabase>[1]) {
  return db.memory ? searchResearchStoriesInDatabase(db, input)
    : compute<ReturnType<typeof searchResearchStoriesInDatabase>>(db.name, 'library-stories', undefined, input);
}

/** Bounded, short-lived display cache. Never used for broadcast selection.
 * Own writes invalidate immediately; external writes and cooldowns expire in 3s.
 * Serialize in the worker so large readouts do not get cloned/stringified here.
 */
export function cachedDashboardRead(input: DashboardRead, db = open()): Promise<string> {
  if (input.kind === 'live-summary') {
    // Queue items carry unrelated persona/transition data. Send only display inputs.
    const track = (t: LiveNotesItem['track'] | null) => t ? {
      id: t.id, subsonic_id: t.subsonic_id, title: t.title, artist: t.artist,
      album: t.album, artistId: t.artistId, albumId: t.albumId,
    } : null;
    const item = (i: LiveNotesItem | null): LiveNotesItem | null => i ? {
      track: track(i.track)!, sleeveClaimUseId: i.sleeveClaimUseId, introScript: i.introScript,
    } : null;
    input = {kind: 'live-summary', args: [track(input.args[0]), item(input.args[1]), item(input.args[2])]};
  }
  if (db.memory) return Promise.resolve(JSON.stringify(dashboardReadInDatabase(db, input)));
  const changes = (db.prepare('SELECT total_changes() AS n').get() as {n: number}).n;
  const key = JSON.stringify([db.name, changes, input]);
  const saved = dashboardCache.get(key);
  if (saved && saved.until > Date.now()) return Promise.resolve(saved.json);
  const running = dashboardFlights.get(key);
  if (running) return running;
  const epoch = dashboardEpoch;
  const task = compute<string>(db.name, 'dashboard', undefined, undefined, input).then(json => {
    if (epoch === dashboardEpoch) {
      dashboardCache.delete(key);
      dashboardCache.set(key, {until: Date.now() + 3_000, json});
      while (dashboardCache.size > 4) dashboardCache.delete(dashboardCache.keys().next().value!);
    }
    return json;
  }).finally(() => { if (dashboardFlights.get(key) === task) dashboardFlights.delete(key); });
  dashboardFlights.set(key, task);
  return task;
}

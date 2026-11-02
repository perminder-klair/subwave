// Whether the mixer can read the MUSIC_LIBRARY_PATH mount, proven with a real
// file off it (radio.liq `path_readable`) and cached per mount. subsonic
// .getLocalPath() reads the cached answer and never waits on this: the push path
// must not depend on telnet, so until a mount is proven the pick streams. Why,
// and what each answer means, is in library-mount-policy.ts.
//
// Re-proven every minute by the scheduler and after a mixer restart. A lost
// proof tells onLibraryMountLost, because auto.m3u still holds local paths.
import { opendir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { onMixerRestart, pathReadable } from '../broadcast/liquidsoap-control.js';
import type { MountProof, MountState } from './library-mount-policy.js';

// A bound on a library with a lot of artwork, not on a real one: the walk stops
// at the first audio file.
const SAMPLE_WALK_LIMIT = 20_000;
const AUDIO_FILE = /\.(mp3|flac|ogg|oga|opus|m4a|mp4|aac|wav|aiff?|wma|ape|wv|mpc)$/i;
// One telnet line carries the path.
const UNSENDABLE = /[\r\n\0]/;
// Long enough for the container restart policy and a mixer boot; the minute's
// tick covers one that takes longer.
const REPROVE_AFTER_RESTART_MS = 15_000;

let proof: MountProof | null = null;
// Bumped by a mixer restart: an answer asked before it says nothing about the
// mixer that comes back.
let generation = 0;
// A proof has stood since the last time the lost listeners were told, so local
// paths may be sitting in auto.m3u.
let localPathsOut = false;
let inFlight: Promise<MountProof | null> | null = null;
let reproveTimer: NodeJS.Timeout | null = null;
const lostListeners = new Set<() => void>();

/** The cached answer. Synchronous on purpose: this is all the push path reads. */
export function libraryMountProven(mount: string): boolean {
  return proof?.mount === mount && proof.state === 'proven';
}

export function onLibraryMountLost(listener: () => void): void {
  lostListeners.add(listener);
}

async function findSample(mount: string): Promise<string | null> {
  const dirs = [mount];
  let seen = 0;
  while (dirs.length > 0) {
    const dir = dirs.pop() as string;
    let entries;
    try {
      entries = await opendir(dir);
    } catch {
      continue;
    }
    for await (const entry of entries) {
      seen += 1;
      if (seen > SAMPLE_WALK_LIMIT) return null;
      if (entry.name.startsWith('.') || UNSENDABLE.test(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isFile() && AUDIO_FILE.test(entry.name)) return path;
      if (entry.isDirectory()) dirs.push(path);
    }
  }
  return null;
}

// The last sample while it is still there, so a re-proof walks nothing.
async function sampleFor(mount: string): Promise<string | null> {
  if (proof?.mount === mount && proof.sample) {
    try {
      await access(proof.sample);
      return proof.sample;
    } catch { /* gone: walk again */ }
  }
  return findSample(mount);
}

async function prove(mount: string): Promise<MountProof | null> {
  const asked = generation;
  const sample = await sampleFor(mount).catch(() => null);
  const reply = sample ? await pathReadable(sample) : 'no-sample';
  if (asked !== generation) return proof;
  const states: Record<typeof reply, MountState> = { yes: 'proven', no: 'unreadable', unknown: 'unknown', 'no-sample': 'no-sample' };
  proof = { mount, state: states[reply], sample };
  if (proof.state === 'proven') {
    localPathsOut = true;
  } else if (localPathsOut) {
    localPathsOut = false;
    for (const listener of lostListeners) listener();
  }
  return proof;
}

/**
 * Ask the mixer now, and cache the answer. Never throws; null when no mount is
 * set, which asks nothing. Concurrent callers share one question.
 */
export function proveLibraryMount(): Promise<MountProof | null> {
  const mount = process.env.MUSIC_LIBRARY_PATH;
  if (!mount) {
    proof = null;
    return Promise.resolve(null);
  }
  inFlight ??= prove(mount).finally(() => { inFlight = null; });
  return inFlight;
}

// Called as a restart starts and again once it has landed. The mixer that comes
// back may not have the mount, so nothing stands until it says so.
function forgetAfterMixerRestart(): void {
  generation += 1;
  proof = null;
  if (reproveTimer) clearTimeout(reproveTimer);
  reproveTimer = setTimeout(() => { void proveLibraryMount(); }, REPROVE_AFTER_RESTART_MS);
  reproveTimer.unref();
}
onMixerRestart(forgetAfterMixerRestart);

/** Test and offline-harness hook: a harness that mounts the library into its own mixer. */
export function _markLibraryMountProven(mount: string): void {
  proof = { mount, state: 'proven', sample: null };
}

/** Test hook: back to a process that has asked nothing. */
export function _resetLibraryMount(): void {
  generation += 1;
  proof = null;
  localPathsOut = false;
  if (reproveTimer) clearTimeout(reproveTimer);
  reproveTimer = null;
}

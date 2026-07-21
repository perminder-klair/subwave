// Filesystem scanner for the local-folder source: walk the music root, parse
// tags with music-metadata, and hold an in-memory index. A persisted cache
// (state/local-music-index.json) keyed by relative path lets restarts and
// rescans skip re-parsing files whose (mtime, size) are unchanged, so a rescan
// of a large library is stat-only except for genuinely new/changed files.

import { opendir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import { config } from '../../../config.js';
import { mapPool } from '../../../util/async-pool.js';
import { buildIndex, EMPTY_INDEX, type CachedFileRecord, type LibraryIndex } from './model.js';

const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wav']);
const CACHE_VERSION = 1;
const PARSE_CONCURRENCY = 8;

export interface ScanStatus {
  state: 'idle' | 'scanning';
  root: string;
  trackCount: number;
  lastScanAt: string | null;
  startedAt: string | null;
  filesSeen: number;
  parsed: number;
  reused: number;
  failed: number;
  lastError: string | null;
}

export function musicRoot(): string {
  return config.music.localDir;
}

function cachePath(): string {
  return `${config.stateDir}/local-music-index.json`;
}

let index: LibraryIndex = EMPTY_INDEX;
let cache = new Map<string, CachedFileRecord>();
let running: Promise<LibraryIndex> | null = null;
let periodicTimer: ReturnType<typeof setInterval> | null = null;
let started = false;

const status: ScanStatus = {
  state: 'idle',
  root: '',
  trackCount: 0,
  lastScanAt: null,
  startedAt: null,
  filesSeen: 0,
  parsed: 0,
  reused: 0,
  failed: 0,
  lastError: null,
};

export function getIndex(): LibraryIndex {
  return index;
}

export function getStatus(): ScanStatus {
  return { ...status, root: musicRoot(), trackCount: index.tracks.size };
}

// Load the persisted cache and build the index from it — instant serve on
// restart, no filesystem walk. Safe to call when the cache is absent (fresh
// install): the index just starts empty until the first scan() lands.
export async function initFromCache(): Promise<void> {
  try {
    const raw = await readFile(cachePath(), 'utf8');
    const data = JSON.parse(raw);
    if (data?.version === CACHE_VERSION && data.root === musicRoot() && data.files) {
      cache = new Map(Object.entries(data.files));
      index = buildIndex(cache);
      status.lastScanAt = data.scannedAt || null;
    }
  } catch {
    // No cache (or unreadable/stale) — start empty; scan() will populate.
  }
}

// Recursively collect audio files under the root. Follows symlinked FILES
// (stat, not lstat) but does NOT descend symlinked directories — a cheap guard
// against cycles. Skips dotfiles and dot-directories.
async function walk(dir: string, root: string, out: Array<{ rel: string; mtimeMs: number; size: number }>): Promise<void> {
  let handle;
  try {
    handle = await opendir(dir);
  } catch {
    return; // unreadable dir — skip
  }
  for await (const entry of handle) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, root, out);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!AUDIO_EXTS.has(ext)) continue;
      try {
        const st = await stat(full); // resolves symlinked files
        if (!st.isFile()) continue;
        out.push({ rel: path.relative(root, full), mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // vanished between readdir and stat — ignore
      }
    }
  }
}

async function parseOne(abs: string): Promise<Partial<CachedFileRecord>> {
  const mm = await parseFile(abs, { duration: true });
  const common = mm.common || ({} as any);
  return {
    title: common.title ?? null,
    artist: common.artist ?? common.albumartist ?? null,
    album: common.album ?? null,
    year: typeof common.year === 'number' ? common.year : null,
    genre: Array.isArray(common.genre) && common.genre.length ? String(common.genre[0]) : null,
    durationSec: typeof mm.format?.duration === 'number' ? Math.round(mm.format.duration) : null,
  };
}

// Scan the folder, reusing cached records for unchanged files. Single-flight:
// concurrent callers share the one in-flight scan.
export function scan(): Promise<LibraryIndex> {
  if (running) return running;
  running = doScan().finally(() => { running = null; });
  return running;
}

async function doScan(): Promise<LibraryIndex> {
  const root = musicRoot();
  // The controller owns the folder's existence — don't depend on the broadcast
  // entrypoint having scaffolded it (older broadcast images won't have).
  mkdirSync(root, { recursive: true });

  status.state = 'scanning';
  status.startedAt = new Date().toISOString();
  status.filesSeen = 0;
  status.parsed = 0;
  status.reused = 0;
  status.failed = 0;
  status.lastError = null;

  try {
    const found: Array<{ rel: string; mtimeMs: number; size: number }> = [];
    await walk(root, root, found);
    status.filesSeen = found.length;

    const next = new Map<string, CachedFileRecord>();
    const toParse: Array<{ rel: string; mtimeMs: number; size: number }> = [];
    for (const f of found) {
      const prev = cache.get(f.rel);
      if (prev && prev.mtimeMs === f.mtimeMs && prev.size === f.size) {
        next.set(f.rel, prev);
        status.reused++;
      } else {
        toParse.push(f);
      }
    }

    await mapPool(toParse, PARSE_CONCURRENCY, async (f) => {
      try {
        const tags = await parseOne(path.join(root, f.rel));
        next.set(f.rel, {
          mtimeMs: f.mtimeMs, size: f.size,
          title: tags.title ?? null,
          artist: tags.artist ?? null,
          album: tags.album ?? null,
          year: tags.year ?? null,
          genre: tags.genre ?? null,
          durationSec: tags.durationSec ?? null,
        });
        status.parsed++;
      } catch {
        // Corrupt/unreadable file — exclude it (Liquidsoap would likely fail to
        // decode it too) and count it so the operator sees why it's missing.
        status.failed++;
      }
    });

    cache = next;
    index = buildIndex(cache);
    await persist(root);
    status.lastScanAt = new Date().toISOString();
    return index;
  } catch (err: any) {
    status.lastError = err?.message || String(err);
    return index;
  } finally {
    status.state = 'idle';
  }
}

async function persist(root: string): Promise<void> {
  const payload = {
    version: CACHE_VERSION,
    root,
    scannedAt: new Date().toISOString(),
    files: Object.fromEntries(cache),
  };
  const dest = cachePath();
  const tmp = `${dest}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(payload));
    await rename(tmp, dest);
  } catch {
    // Persist is best-effort — a failed write just means the next boot re-scans.
  }
}

// Periodic rescan (stat-only for unchanged files, so cheap). Guarded by the
// single-flight scan(); the interval fires and the shared promise dedupes.
export function startPeriodicRescan(minutes = 60): void {
  if (periodicTimer) return;
  periodicTimer = setInterval(() => { void scan(); }, Math.max(1, minutes) * 60 * 1000);
  if (typeof periodicTimer.unref === 'function') periodicTimer.unref();
}

// One-time init: warm the index from the persisted cache and start the periodic
// rescan. Idempotent — safe to call from boot AND from a runtime source switch
// (settings/onboarding), so the local source works whether it was active at boot
// or selected later without a restart. Does NOT scan; callers kick scan() when
// they want a fresh walk (and can await it before rebuilding the playlist).
export async function ensureStarted(): Promise<void> {
  if (started) return;
  started = true;
  await initFromCache();
  startPeriodicRescan();
}

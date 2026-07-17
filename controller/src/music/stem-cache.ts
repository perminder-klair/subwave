// Stem cache (feature: stem-blend transitions) — per-track Demucs stem
// windows persisted by the analyzer worker (head 40s + tail 20s, 4 FLACs
// each) under `<stateDir>/stems/<trackId>/`, so a transition render is a
// fast mix of cached stems instead of a fresh separation inside the drain
// deadline. The controller owns the LIFECYCLE (this module: paths, presence
// checks, byte-budget LRU sweep); the analyzer owns the WRITES
// (analyze_worker.py write_stems — the same shared volume).

import { readdir, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import * as settings from '../settings.js';

export const STEM_NAMES = ['drums', 'bass', 'other', 'vocals'] as const;
export type StemWindow = 'head' | 'tail';

export function stemsRoot(): string {
  return path.join(config.stateDir, 'stems');
}

export function dirFor(trackId: string): string {
  // Track ids are Navidrome UUID-ish tokens; guard the join anyway so a
  // hostile id can never escape the cache root.
  return path.join(stemsRoot(), path.basename(String(trackId)));
}

export function stemPath(trackId: string, window: StemWindow, stem: string): string {
  return path.join(dirFor(trackId), `${window}-${stem}.flac`);
}

// Whether a track has a complete stem set for the given window. The render
// op is cache-hit-only, so "all four present" is the eligibility fact.
export async function hasWindow(trackId: string, window: StemWindow): Promise<boolean> {
  try {
    const checks = await Promise.all(
      STEM_NAMES.map(s => stat(stemPath(trackId, window, s)).then(st => st.size > 0, () => false)),
    );
    return checks.every(Boolean);
  } catch {
    return false;
  }
}

// Byte-budget LRU sweep: newest track-dirs (by max file mtime — a re-analysis
// refreshes a dir's slot) are kept, oldest evicted until the cache fits the
// operator's budget (settings.audio.stemCacheGb). No existing LRU utility in
// the repo — byte accounting follows archives.pruneOlderThan, the sweep shape
// follows piper.cleanupOldVoices. ENOENT-tolerant throughout: the analyzer
// may be writing a dir while we scan.
export async function sweep(budgetBytes?: number): Promise<{ removed: number; freedBytes: number }> {
  const budget = budgetBytes ?? Math.max(1, Number(settings.get()?.audio?.stemCacheGb) || 15) * 1024 ** 3;
  let entries: string[];
  try {
    entries = await readdir(stemsRoot());
  } catch {
    return { removed: 0, freedBytes: 0 }; // no cache dir yet
  }

  const dirs: Array<{ dir: string; bytes: number; mtimeMs: number }> = [];
  for (const name of entries) {
    const dir = path.join(stemsRoot(), name);
    try {
      const st = await stat(dir);
      if (!st.isDirectory()) continue;
      let bytes = 0;
      let mtimeMs = 0;
      for (const f of await readdir(dir)) {
        try {
          const fst = await stat(path.join(dir, f));
          bytes += fst.size;
          if (fst.mtimeMs > mtimeMs) mtimeMs = fst.mtimeMs;
        } catch { /* file vanished mid-scan */ }
      }
      dirs.push({ dir, bytes, mtimeMs });
    } catch { /* dir vanished mid-scan */ }
  }

  let total = dirs.reduce((n, d) => n + d.bytes, 0);
  if (total <= budget) return { removed: 0, freedBytes: 0 };

  dirs.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
  let removed = 0;
  let freedBytes = 0;
  for (const d of dirs) {
    if (total <= budget) break;
    try {
      await rm(d.dir, { recursive: true, force: true });
      total -= d.bytes;
      freedBytes += d.bytes;
      removed += 1;
    } catch { /* best-effort — retry next sweep */ }
  }
  return { removed, freedBytes };
}

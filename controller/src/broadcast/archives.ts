// Hourly archive index over the MP3s radio.liq writes to
// `${STATE_DIR}/archive/%Y-%m-%d/%H-00.mp3`. Read-only; each GET re-scans (a
// two-level walk, one entry per hour).

import { readdir, stat, rm } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from '../config.js';

const ARCHIVE_ROOT = join(config.stateDir, 'archive');

// Date directories: "YYYY-MM-DD". Hour files: "HH-00.mp3".
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HOUR_RE = /^(\d{2})-00\.mp3$/;

export interface ArchiveEntry {
  // YYYY-MM-DD/HH-00.mp3 — the safe relative path used by the download route.
  path: string;
  date: string;   // YYYY-MM-DD
  hour: number;   // 0-23
  bytes: number;
  mtime: string;  // ISO
}

// Scan the archive tree, newest first. `limit` bounds the response size.
export async function list({ limit = 500 }: { limit?: number } = {}): Promise<ArchiveEntry[]> {
  if (!existsSync(ARCHIVE_ROOT)) return [];
  let dayDirs: string[] = [];
  try {
    dayDirs = (await readdir(ARCHIVE_ROOT)).filter(d => DATE_RE.test(d)).sort().reverse();
  } catch {
    return [];
  }

  const out: ArchiveEntry[] = [];
  for (const date of dayDirs) {
    let files: string[] = [];
    try {
      files = await readdir(join(ARCHIVE_ROOT, date));
    } catch {
      continue;
    }
    // Hours descending so each day's newest hour appears first.
    files.sort().reverse();
    for (const f of files) {
      const m = f.match(HOUR_RE);
      if (!m) continue;
      const abs = join(ARCHIVE_ROOT, date, f);
      try {
        const st = await stat(abs);
        if (!st.isFile()) continue;
        out.push({
          path: `${date}/${f}`,
          date,
          hour: parseInt(m[1], 10),
          bytes: st.size,
          mtime: st.mtime.toISOString(),
        });
        if (out.length >= limit) return out;
      } catch {}
    }
  }
  return out;
}

// Resolve a client-supplied relative path against the archive root, rejecting
// anything that escapes the tree or doesn't match the canonical naming scheme.
// Returns the absolute path on success, or null if the input is unsafe / missing.
export function resolveEntry(rel: string): string | null {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 64) return null;
  const m = rel.match(/^(\d{4}-\d{2}-\d{2})\/(\d{2}-00\.mp3)$/);
  if (!m) return null;
  const abs = resolve(ARCHIVE_ROOT, rel);
  if (!abs.startsWith(ARCHIVE_ROOT + '/')) return null;
  if (!existsSync(abs)) return null;
  return abs;
}

export function openStream(abs: string) {
  return createReadStream(abs);
}

// Retention sweep: delete whole day directories older than `days`. 0 means keep
// forever and callers gate on that before calling. Day-granular on purpose —
// a YYYY-MM-DD cutoff can never touch the file Liquidsoap holds open, since
// today's dir is inside any positive window. `.ndignore` is untouched.
export async function pruneOlderThan(days: number): Promise<{ removed: number; bytes: number }> {
  if (!Number.isFinite(days) || days <= 0) return { removed: 0, bytes: 0 };
  if (!existsSync(ARCHIVE_ROOT)) return { removed: 0, bytes: 0 };
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  let dayDirs: string[] = [];
  try {
    dayDirs = (await readdir(ARCHIVE_ROOT)).filter(d => DATE_RE.test(d) && d < cutoff);
  } catch {
    return { removed: 0, bytes: 0 };
  }

  let removed = 0;
  let bytes = 0;
  for (const date of dayDirs) {
    const dir = join(ARCHIVE_ROOT, date);
    try {
      for (const f of await readdir(dir)) {
        if (!HOUR_RE.test(f)) continue;
        try {
          const st = await stat(join(dir, f));
          if (st.isFile()) { removed += 1; bytes += st.size; }
        } catch {}
      }
    } catch {}
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {}
  }
  return { removed, bytes };
}

// Delete every hourly recording. Only YYYY-MM-DD day directories are removed —
// the `.ndignore` the entrypoint drops here is left alone. Safe on air: an
// unlink only detaches the name and output.file reopens at the next HH:00.
export async function clearAll(): Promise<{ removed: number; bytes: number }> {
  if (!existsSync(ARCHIVE_ROOT)) return { removed: 0, bytes: 0 };
  let dayDirs: string[] = [];
  try {
    dayDirs = (await readdir(ARCHIVE_ROOT)).filter(d => DATE_RE.test(d));
  } catch {
    return { removed: 0, bytes: 0 };
  }

  let removed = 0;
  let bytes = 0;
  for (const date of dayDirs) {
    const dir = join(ARCHIVE_ROOT, date);
    try {
      for (const f of await readdir(dir)) {
        if (!HOUR_RE.test(f)) continue;
        try {
          const st = await stat(join(dir, f));
          if (st.isFile()) { removed += 1; bytes += st.size; }
        } catch {}
      }
    } catch {}
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {}
  }
  return { removed, bytes };
}

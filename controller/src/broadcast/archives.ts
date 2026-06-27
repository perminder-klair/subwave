// Hourly archive index.
//
// Liquidsoap writes one MP3 per hour to `${STATE_DIR}/archive/%Y-%m-%d/%H-00.mp3`
// (see liquidsoap/radio.liq's output.file block). This module exposes that
// tree to the admin UI as a listable + downloadable index — purely read-only
// over the existing on-disk layout.
//
// The pathing scheme is fixed and the operator never edits inside the
// archive directory by hand, so we don't watch for changes; each /archives
// GET re-scans. Two-level directory walk is cheap (one entry per hour).

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

// Scan the archive tree. Newest first. Bounded by `limit` to keep the response
// small for accounts with months of archives — the UI paginates client-side.
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

// Delete every hourly recording under the archive root. Only YYYY-MM-DD day
// directories are removed — anything else in the tree (notably the `.ndignore`
// the broadcast entrypoint drops here to keep these mixdowns out of a
// co-located Navidrome scan) is left untouched. Returns how many hour files
// were removed and the bytes freed, for the operator's confirmation toast.
//
// Safe to run while on air: if Liquidsoap currently holds this hour's file
// open, the unlink just detaches the name — it keeps writing to the now-orphan
// inode and reopens a fresh file at the next HH:00 (output.file reopen_when).
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
    // Tally the hour files before the directory goes, for the report.
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

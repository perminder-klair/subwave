// Admin-gated backup / restore of station config + the tag DB.
//
// Export bundles the station-defining state into a single downloadable zip:
// settings (personas, DJ prompt, LLM/TTS config — written from the redacted
// view so API keys never leave the box), the mood/tag database, and operator
// media (jingles, SFX, reference voices, themes, skills). Host-specific and
// secret files (Navidrome creds, icecast secrets, live session/queue/logs) are
// deliberately excluded.
//
// Import reverses it: settings flow back through settings.update() (which keeps
// existing API keys via the 'set' sentinel and regenerates the liquidsoap_*.txt
// files), the tag DB is swapped in and reloaded live, and media folders are
// extracted back under STATE_DIR. See discussion #404.
//
// Two restore entry points share one `applyBackupZip()` core:
//   POST /backup/import       — the zip is the raw request body (browser upload).
//   POST /backup/import-file  — restore a zip already sitting in STATE_DIR.
// The disk path exists because a big-library backup (29k tracks ⇒ a tag DB well
// over 100 MB) can exceed an edge proxy's upload cap (Cloudflare rejects with a
// 413 before the request ever reaches the controller). Dropping the file into
// the station's state/ folder and restoring from there bypasses the proxy body
// limit entirely. GET /backup/restorable lists the candidate zips. See #612.
import express from 'express';
import AdmZip from 'adm-zip';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, readdir, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATE_DIR, DATABASE_URL } from '../config.js';
import * as settings from '../settings.js';
import * as library from '../music/library.js';
import * as libraryDb from '../music/library-db.js';
import { requireAdmin } from '../middleware/auth.js';

export const router = express.Router();

const BACKUP_FORMAT = 'subwave-backup';
const BACKUP_VERSION = 1;

// Top-level state files copied verbatim (settings.json + library.db are handled
// specially; manifest.json is generated).
const INCLUDE_FILES = ['jingles.json', 'jingles.m3u', 'sfx.json'] as const;
// Top-level state directories copied whole.
const INCLUDE_DIRS = [
  'persona-avatars',
  'jingles',
  'sfx',
  'voices',
  'themes',
  'skills',
] as const;
// Everything an import is allowed to write under STATE_DIR (besides the
// specially-handled settings.json / library.db).
const RESTORABLE = new Set<string>([...INCLUDE_FILES, ...INCLUDE_DIRS]);

const appVersion = (() => {
  // Build-arg wins (set from `git describe` by scripts/update.sh and the
  // publish-images CI) so an image built off `develop` reports its true version
  // rather than the stale package.json number, which only bumps on `main`.
  // Mirrors web/next.config.js.
  const fromEnv = process.env.SUBWAVE_BUILD_VERSION;
  if (fromEnv) return fromEnv.replace(/^v/, '');
  try {
    const p = fileURLToPath(new URL('../../package.json', import.meta.url));
    return JSON.parse(readFileSync(p, 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
})();

// The top-level path segment of a zip entry ('jingles/foo.wav' -> 'jingles').
function topSegment(entryName: string): string {
  return entryName.replace(/\\/g, '/').split('/')[0];
}

// Reject absolute paths and any '..' traversal so a malicious zip can't write
// outside STATE_DIR.
function isSafeEntry(entryName: string): boolean {
  const n = entryName.replace(/\\/g, '/');
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n)) return false;
  return !n.split('/').includes('..');
}

// ---------------------------------------------------------------------------
// GET /backup/export — download a zip snapshot of station config + tag DB.
// ---------------------------------------------------------------------------
router.get('/backup/export', requireAdmin, async (req, res) => {
  if (DATABASE_URL) {
    res.status(501).json({
      error: 'Library backup is not supported in Postgres mode. Use pg_dump instead.',
      hint: `pg_dump "${DATABASE_URL}" -Fc -f subwave-library.dump`,
    });
    return;
  }
  let tmpDir: string | null = null;
  try {
    await settings.load();
    const zip = new AdmZip();

    // Settings — redacted so API keys / webhook auth never leave the box. This
    // object also carries shows + schedule, so they round-trip too.
    zip.addFile(
      'settings.json',
      Buffer.from(JSON.stringify(settings.getRedacted(), null, 2)),
    );

    // Tag DB — consistent online backup (WAL-safe), not a raw file copy.
    if (existsSync(join(STATE_DIR, 'library.db'))) {
      tmpDir = await mkdtemp(join(tmpdir(), 'subwave-backup-'));
      const dbTmp = join(tmpDir, 'library.db');
      await library.load(); // ensure the DB handle is open before backing up
      await libraryDb.backup(dbTmp);
      zip.addLocalFile(dbTmp, '', 'library.db');
    }

    for (const f of INCLUDE_FILES) {
      const p = join(STATE_DIR, f);
      if (existsSync(p)) zip.addLocalFile(p, '', f);
    }
    for (const d of INCLUDE_DIRS) {
      const p = join(STATE_DIR, d);
      if (existsSync(p)) zip.addLocalFolder(p, d);
    }

    const manifest = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      appVersion,
      createdAt: new Date().toISOString(),
      contents: zip.getEntries().map(e => e.entryName),
    };
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="subwave-backup-${stamp}.zip"`,
    );
    res.send(zip.toBuffer());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

// A restore outcome carries its own HTTP status so the validation failures
// (bad zip / wrong manifest / corrupt member) surface as 400s and only genuine
// surprises fall through to a 500. Both restore routes return it verbatim.
type RestoreOutcome =
  | { ok: true; status: 200; restored: string[]; requiresRestart: boolean }
  | { ok: false; status: number; error: string };

// Shared restore core for both the upload (POST /backup/import) and the disk
// (POST /backup/import-file) routes. Validates the manifest before touching any
// state, then restores settings → tag DB → media. Manages its own tmp dir.
async function applyBackupZip(body: Buffer): Promise<RestoreOutcome> {
  if (!Buffer.isBuffer(body) || body.length === 0) {
    return { ok: false, status: 400, error: 'expected a zip file body' };
  }

  let zip: AdmZip;
  try {
    zip = new AdmZip(body);
  } catch {
    return { ok: false, status: 400, error: 'not a valid zip file' };
  }

  // Validate manifest before touching any state.
  const manifestEntry = zip.getEntry('manifest.json');
  if (!manifestEntry) {
    return { ok: false, status: 400, error: 'missing manifest.json — not a SUB/WAVE backup' };
  }
  let manifest: any;
  try {
    manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
  } catch {
    return { ok: false, status: 400, error: 'corrupt manifest.json' };
  }
  if (manifest?.format !== BACKUP_FORMAT) {
    return { ok: false, status: 400, error: 'not a SUB/WAVE backup' };
  }
  if (manifest?.version !== BACKUP_VERSION) {
    return { ok: false, status: 400, error: `unsupported backup version: ${manifest?.version}` };
  }

  const restored: string[] = [];
  let requiresRestart = false;
  let tmpDir: string | null = null;
  try {
    // 1) Settings — back through update() so they validate, the 'set' apiKey
    //    sentinel keeps existing keys, and the liquidsoap_*.txt files + the
    //    schedule.json split are regenerated.
    const settingsEntry = zip.getEntry('settings.json');
    if (settingsEntry) {
      let parsed: any;
      try {
        parsed = JSON.parse(settingsEntry.getData().toString('utf8'));
      } catch {
        return { ok: false, status: 400, error: 'corrupt settings.json in backup' };
      }
      const result = await settings.update(parsed);
      requiresRestart = Boolean(result.requiresRestart);
      restored.push('settings.json');
    }

    // 2) Tag DB — extract to tmp, swap the live file, reopen.
    const dbEntry = zip.getEntry('library.db');
    if (dbEntry) {
      if (DATABASE_URL) {
        return {
          ok: false,
          status: 501,
          error: 'library.db restore is not supported in Postgres mode. Use pg_restore instead.',
        };
      }
      tmpDir = await mkdtemp(join(tmpdir(), 'subwave-restore-'));
      const dbTmp = join(tmpDir, 'library.db');
      zip.extractEntryTo(dbEntry, tmpDir, false, true);
      await libraryDb.restoreFromFile(dbTmp);
      await library.reload();
      restored.push('library.db');
    }

    // 3) Media files + dirs — extract allow-listed entries back under
    //    STATE_DIR, rejecting anything outside it.
    const touched = new Set<string>();
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const name = entry.entryName;
      if (name === 'manifest.json' || name === 'settings.json' || name === 'library.db') continue;
      if (!isSafeEntry(name) || !RESTORABLE.has(topSegment(name))) continue;
      zip.extractEntryTo(entry, STATE_DIR, true, true);
      touched.add(topSegment(name));
    }
    for (const t of touched) restored.push(t);

    return { ok: true, status: 200, restored, requiresRestart };
  } finally {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// POST /backup/import — restore a previously-exported zip. Body is the raw zip
// (the global express.json parser caps at 600kb and can't carry it), so a
// route-scoped raw parser buffers it instead.
//
// NOTE: a big backup can still be rejected upstream — Cloudflare and many
// reverse proxies cap request bodies (Cloudflare's free/pro limit is 100 MB),
// so the controller's 500mb cap here is not the only gate. When the upload is
// too large, use POST /backup/import-file (the file is read off disk, never
// uploaded through the proxy). See #612.
// ---------------------------------------------------------------------------
router.post(
  '/backup/import',
  requireAdmin,
  express.raw({ type: () => true, limit: '500mb' }),
  async (req, res) => {
    try {
      const outcome = await applyBackupZip(req.body);
      if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
      res.json({ ok: true, restored: outcome.restored, requiresRestart: outcome.requiresRestart });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);

// Only top-level *.zip files are candidate backups. A name that doesn't survive
// basename() unchanged (slashes, traversal) or isn't a .zip is rejected so the
// disk-restore route can never read outside STATE_DIR.
function isSafeBackupName(name: string): boolean {
  if (typeof name !== 'string' || !name) return false;
  if (basename(name) !== name) return false;
  return name.toLowerCase().endsWith('.zip');
}

// ---------------------------------------------------------------------------
// GET /backup/restorable — list backup zips sitting in STATE_DIR, newest first.
// The escape hatch when a backup is too big to upload through an edge proxy:
// the operator copies the zip into the station's state/ folder and restores it
// from here without it ever traversing the proxy. See #612.
// ---------------------------------------------------------------------------
router.get('/backup/restorable', requireAdmin, async (_req, res) => {
  try {
    const names = await readdir(STATE_DIR).catch(() => [] as string[]);
    const files: { name: string; size: number; mtime: string }[] = [];
    for (const name of names) {
      if (!isSafeBackupName(name)) continue;
      try {
        const st = await stat(join(STATE_DIR, name));
        if (!st.isFile()) continue;
        files.push({ name, size: st.size, mtime: st.mtime.toISOString() });
      } catch {
        /* vanished between readdir and stat — skip */
      }
    }
    files.sort((a, b) => b.mtime.localeCompare(a.mtime));
    res.json({ stateDir: STATE_DIR, files });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /backup/import-file — restore a zip already present in STATE_DIR. Body is
// a tiny JSON `{ file }` (handled by the global express.json parser), so the
// large zip is read off disk instead of being uploaded — sidestepping any proxy
// request-body cap. See #612.
// ---------------------------------------------------------------------------
router.post('/backup/import-file', requireAdmin, async (req, res) => {
  try {
    const file = (req.body && (req.body as any).file) as unknown;
    if (!isSafeBackupName(file as string)) {
      return res.status(400).json({ error: 'invalid backup file name' });
    }
    const path = join(STATE_DIR, file as string);
    if (!existsSync(path)) {
      return res.status(404).json({ error: `no such backup in state dir: ${file}` });
    }
    const body = await readFile(path);
    const outcome = await applyBackupZip(body);
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.json({ ok: true, restored: outcome.restored, requiresRestart: outcome.requiresRestart });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

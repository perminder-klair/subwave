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
//   POST /backup/import       — the zip is the raw request body (browser upload)
//   POST /backup/import-file  — restore a zip already sitting in STATE_DIR
// The disk path exists because a big-library backup (29k tracks → a tag DB well
// over 100 MB) can exceed an edge proxy's upload cap — Cloudflare 413s before
// the request reaches the controller — and dropping the file into state/
// bypasses that entirely. GET /backup/restorable lists candidates (#612).
//
// The EXPORT side is symmetrically shared: `buildBackupZip()` (backup/zip.ts)
// is the one assembly, because the scheduled backup (#1570) writes the same
// archive to disk and `POST /backup/import-file` cannot tell the two apart.
import express from 'express';
import AdmZip from 'adm-zip';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, readdir, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { STATE_DIR } from '../config.js';
import * as settings from '../settings.js';
import * as library from '../music/library.js';
import * as libraryDb from '../music/library-db.js';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  INCLUDE_DIRS,
  INCLUDE_FILES,
  buildBackupZip,
} from '../backup/zip.js';
import { isScheduledBackupName } from '../backup/pure.js';
import { clearUserThemeCache } from '../themes.js';
import { requireAdmin } from '../middleware/auth.js';

export const router = express.Router();

// Everything an import is allowed to write under STATE_DIR (besides the
// specially-handled settings.json / library.db).
const RESTORABLE = new Set<string>([...INCLUDE_FILES, ...INCLUDE_DIRS]);

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
  try {
    const zip = await buildBackupZip();
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="subwave-backup-${stamp}.zip"`,
    );
    res.send(zip.toBuffer());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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
    // 1) Media files + dirs — extract allow-listed entries back under STATE_DIR,
    //    rejecting anything outside it. This MUST run before settings.update():
    //    settings validation resolves theme.active + shows[].themeId against the
    //    theme registry, which reads custom themes from state/themes/. Restore a
    //    backup whose active theme is a custom one and, if the theme files aren't
    //    on disk yet, update() throws `theme.active "<id>" is not a known theme
    //    id` and aborts the whole restore (issue #917). Extract first, then drop
    //    the 30s user-theme cache so update() sees the just-restored themes.
    const touched = new Set<string>();
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const name = entry.entryName;
      if (name === 'manifest.json' || name === 'settings.json' || name === 'library.db') continue;
      if (!isSafeEntry(name) || !RESTORABLE.has(topSegment(name))) continue;
      zip.extractEntryTo(entry, STATE_DIR, true, true);
      touched.add(topSegment(name));
    }
    if (touched.has('themes')) clearUserThemeCache();
    for (const t of touched) restored.push(t);

    // 2) Settings — back through update() so they validate, the 'set' apiKey
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

    // 3) Tag DB — extract to tmp, swap the live file, reopen.
    const dbEntry = zip.getEntry('library.db');
    if (dbEntry) {
      tmpDir = await mkdtemp(join(tmpdir(), 'subwave-restore-'));
      const dbTmp = join(tmpDir, 'library.db');
      zip.extractEntryTo(dbEntry, tmpDir, false, true);
      await libraryDb.restoreFromFile(dbTmp);
      await library.reload();
      restored.push('library.db');
    }

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
//
// `auto` marks the ones the schedule wrote (#1570) — the same grammar retention
// prunes by, asked once here rather than re-spelled in the browser, so the list
// cannot disagree with the sweep about which files are the station's own.
// ---------------------------------------------------------------------------
router.get('/backup/restorable', requireAdmin, async (_req, res) => {
  try {
    const names = await readdir(STATE_DIR).catch(() => [] as string[]);
    const files: { name: string; size: number; mtime: string; auto: boolean }[] = [];
    for (const name of names) {
      if (!isSafeBackupName(name)) continue;
      try {
        const st = await stat(join(STATE_DIR, name));
        if (!st.isFile()) continue;
        files.push({
          name,
          size: st.size,
          mtime: st.mtime.toISOString(),
          auto: isScheduledBackupName(name),
        });
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
// GET /backup/file/:name — download a zip that is ALREADY in STATE_DIR.
//
// GET /backup/export builds a fresh archive, which is the wrong thing for a
// scheduled backup: the operator wants the snapshot taken at 04:23 last
// Tuesday, not a new one taken now. Without this, every file the schedule
// writes lives only on the disk it exists to protect (#1570).
//
// Same name guard as the restore side (`isSafeBackupName` — basename-identical,
// `.zip` only), so this can no more read outside STATE_DIR than
// POST /backup/import-file can.
// ---------------------------------------------------------------------------
router.get('/backup/file/:name', requireAdmin, async (req, res) => {
  try {
    const name = req.params.name;
    if (!isSafeBackupName(name)) {
      return res.status(400).json({ error: 'invalid backup file name' });
    }
    const path = join(STATE_DIR, name);
    if (!existsSync(path)) {
      return res.status(404).json({ error: `no such backup in state dir: ${name}` });
    }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(await readFile(path));
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

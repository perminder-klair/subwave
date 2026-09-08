// Admin-gated backup / restore of station config + the tag DB (#404).
// Export excludes host-specific and secret files (Navidrome creds, icecast
// secrets, live session/queue/logs); settings are written from the redacted view.
// Two restore entry points share `applyBackupZip()`: the upload route and the
// disk route, which exists because a big backup exceeds edge proxy upload caps
// (#612). Export assembly is shared with the scheduled backup (#1570).
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

// Everything an import may write under STATE_DIR (settings.json / library.db
// are handled separately).
const RESTORABLE = new Set<string>([...INCLUDE_FILES, ...INCLUDE_DIRS]);

function topSegment(entryName: string): string {
  return entryName.replace(/\\/g, '/').split('/')[0];
}

// Reject absolute paths and '..' traversal so a zip can't write outside STATE_DIR.
function isSafeEntry(entryName: string): boolean {
  const n = entryName.replace(/\\/g, '/');
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n)) return false;
  return !n.split('/').includes('..');
}

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

// Carries its own HTTP status so validation failures surface as 400s and only
// genuine surprises fall through to a 500. Both restore routes return it verbatim.
type RestoreOutcome =
  | { ok: true; status: 200; restored: string[]; requiresRestart: boolean }
  | { ok: false; status: number; error: string };

// Shared restore core. Validates the manifest before touching any state.
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
    // 1) Media — must run BEFORE settings.update(): settings validation resolves
    //    theme.active / shows[].themeId against themes read from state/themes/,
    //    so a custom theme not yet on disk aborts the whole restore (#917).
    //    Clear the user-theme cache after extracting.
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

    // 2) Settings — via update() so the 'set' apiKey sentinel keeps existing keys
    //    and liquidsoap_*.txt + schedule.json are regenerated.
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

// Body is the raw zip; the global express.json parser caps at 600kb, hence the
// route-scoped raw parser. The 500mb cap here is not the only gate — proxies cap
// request bodies too, so oversized uploads go via /backup/import-file (#612).
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

// Only top-level *.zip names, so the disk routes can never read outside STATE_DIR.
function isSafeBackupName(name: string): boolean {
  if (typeof name !== 'string' || !name) return false;
  if (basename(name) !== name) return false;
  return name.toLowerCase().endsWith('.zip');
}

// Lists every top-level zip in STATE_DIR, newest first, including ones the
// operator hand-copied there (#612). `auto` uses the same name grammar retention
// prunes by (#1570) so the list can't disagree with the sweep.
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

// Downloads an EXISTING zip rather than building a fresh one, so a scheduled
// backup can leave the disk it protects (#1570).
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

// Body is a tiny JSON `{ file }`; the zip is read off disk, sidestepping proxy
// request-body caps (#612).
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

// Exports omit host secrets and live state, using redacted settings (#404).
// Upload and disk restore share applyBackupZip; disk restore bypasses proxy caps (#612).
// Scheduled exports share the assembly path (#1570).
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
import { clearUserThemeCache, themeIdsAfterImport } from '../themes.js';
import { migrateImportedPersona } from '../personas/import-migration.js';
import { requireAdmin } from '../middleware/auth.js';
import * as jingles from '../broadcast/jingles.js';
import * as sfx from '../broadcast/sfx.js';
import {
  SKILL_BUNDLE_MAX_BYTES,
  restoreSkillMembers,
  skillMemberOf,
  type SkillMember,
} from '../skills/install.js';
import { isSafeZipEntry, readZipEntryCapped } from '../util/zip-entry.js';

export const router = express.Router();

// Everything an import may write under STATE_DIR (settings.json / library.db
// are handled separately).
const RESTORABLE = new Set<string>([...INCLUDE_FILES, ...INCLUDE_DIRS]);

// Members that are never extracted as-is. The sidecars go through the module
// that owns them (jingles.restoreMeta / sfx.restoreMeta) — the same name rules
// those modules apply to a bundled or uploaded file — and jingles.m3u is not
// read at all: it is regenerated from the restored jingles.json. skills/** goes
// through the skill import's guards, so any tool.mjs arrives quarantined.
const ROUTED_FILES = new Set<string>(['jingles.json', 'jingles.m3u', 'sfx.json']);

// manifest.json, settings.json, a theme and a sidecar are read into memory, so
// each is bounded by its DECLARED size before it is inflated. Generous: a
// settings.json is tens of kilobytes.
const JSON_MEMBER_MAX_BYTES = 16 * 1024 * 1024;

function topSegment(entryName: string): string {
  return entryName.replace(/\\/g, '/').split('/')[0];
}

// Parse a JSON member, or say why it can't be. `null` data = absent.
function readJsonMember(zip: AdmZip, name: string): { data: unknown } | { error: string } | null {
  const entry = zip.getEntry(name);
  if (!entry) return null;
  const buf = readZipEntryCapped(entry, JSON_MEMBER_MAX_BYTES);
  if (!buf) return { error: `${name} is too large` };
  try {
    return { data: JSON.parse(buf.toString('utf8')) };
  } catch {
    return { error: `corrupt ${name}` };
  }
}

// A sidecar's one structural requirement, checked before anything is written.
function isSidecar(data: unknown): boolean {
  const items = (data as any)?.items;
  return !!items && typeof items === 'object' && !Array.isArray(items);
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
  | {
    ok: true; status: 200; restored: string[]; requiresRestart: boolean;
    // Members left out by a guard, and skills whose code waits for review.
    skipped: string[]; skillsAwaitingReview: string[];
  }
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

  const manifestRead = readJsonMember(zip, 'manifest.json');
  if (!manifestRead) {
    return { ok: false, status: 400, error: 'missing manifest.json — not a SUB/WAVE backup' };
  }
  if ('error' in manifestRead) return { ok: false, status: 400, error: manifestRead.error };
  const manifest: any = manifestRead.data;
  if (manifest?.format !== BACKUP_FORMAT) {
    return { ok: false, status: 400, error: 'not a SUB/WAVE backup' };
  }
  if (manifest?.version !== BACKUP_VERSION) {
    return { ok: false, status: 400, error: `unsupported backup version: ${manifest?.version}` };
  }

  const settingsRead = readJsonMember(zip, 'settings.json');
  let settingsPatch: Record<string, unknown> | null = null;
  if (settingsRead) {
    if ('error' in settingsRead) return { ok: false, status: 400, error: `${settingsRead.error} in backup` };
    const parsed = settingsRead.data;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, status: 400, error: 'settings.json must be a settings object' };
    }
    settingsPatch = { ...parsed };
    if (Array.isArray(settingsPatch.personas)) {
      settingsPatch.personas = settingsPatch.personas.map(migrateImportedPersona);
    }
    const themes = new Map<string, string>();
    for (const entry of zip.getEntries()) {
      const name = entry.entryName.replace(/\\/g, '/');
      if (!entry.isDirectory && name === `themes/${basename(name)}` && name.endsWith('.json')) {
        const buf = readZipEntryCapped(entry, JSON_MEMBER_MAX_BYTES);
        if (!buf) return { ok: false, status: 400, error: `${name} is too large` };
        themes.set(basename(name), buf.toString('utf8'));
      }
    }
    const themeIds = await themeIdsAfterImport(themes);
    try {
      await settings.prepareUpdate(settingsPatch, { themeIds });
    } catch (err) {
      return { ok: false, status: 400, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // The routed members, read and checked before anything is written, so a bad
  // one refuses the restore rather than landing half of it.
  const sidecars: { file: 'jingles.json' | 'sfx.json'; data: unknown }[] = [];
  for (const file of ['jingles.json', 'sfx.json'] as const) {
    const read = readJsonMember(zip, file);
    if (!read) continue;
    if ('error' in read) return { ok: false, status: 400, error: `${read.error} in backup` };
    if (!isSidecar(read.data)) return { ok: false, status: 400, error: `${file} in backup is not a sidecar` };
    sidecars.push({ file, data: read.data });
  }
  const skillMembers: SkillMember[] = [];
  const skipped: string[] = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory || topSegment(entry.entryName) !== 'skills') continue;
    if (!isSafeZipEntry(entry.entryName)) continue;
    const member = skillMemberOf(entry.entryName);
    if ('reason' in member) {
      skipped.push(`${entry.entryName}: ${member.reason}`);
      continue;
    }
    const data = readZipEntryCapped(entry, SKILL_BUNDLE_MAX_BYTES);
    if (!data) return { ok: false, status: 400, error: `${entry.entryName} is too large for a skill file` };
    skillMembers.push({ ...member, data });
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
      if (!isSafeZipEntry(name) || !RESTORABLE.has(topSegment(name))) continue;
      // Routed root files have no children; extraction collapses aliases like sfx.json/.
      if (ROUTED_FILES.has(topSegment(name)) || topSegment(name) === 'skills') continue;
      zip.extractEntryTo(entry, STATE_DIR, true, true);
      touched.add(topSegment(name));
    }
    if (touched.has('themes')) clearUserThemeCache();
    for (const t of touched) restored.push(t);

    // 1b) Sidecars through their owners; the playlist is rebuilt, never copied.
    for (const { file, data } of sidecars) {
      const { dropped } = file === 'jingles.json'
        ? await jingles.restoreMeta(data)
        : await sfx.restoreMeta(data);
      for (const name of dropped) skipped.push(`${file}: "${name}" is not a usable entry`);
      restored.push(file);
    }

    // 1c) Skills through the import's guards: any tool.mjs not already live
    //     (or shipped in this image) waits as tool.mjs.pending for review.
    let skillsAwaitingReview: string[] = [];
    if (skillMembers.length) {
      const result = await restoreSkillMembers(skillMembers);
      skipped.push(...result.skipped);
      skillsAwaitingReview = result.quarantined;
      if (result.restored.length) restored.push('skills');
    }

    // 2) Settings — via update() so the 'set' apiKey sentinel keeps existing keys
    //    and liquidsoap_*.txt + schedule.json are regenerated.
    if (settingsPatch) {
      const result = await settings.update(settingsPatch);
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

    return { ok: true, status: 200, restored, requiresRestart, skipped, skillsAwaitingReview };
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
      res.json({
        ok: true,
        restored: outcome.restored,
        requiresRestart: outcome.requiresRestart,
        skipped: outcome.skipped,
        skillsAwaitingReview: outcome.skillsAwaitingReview,
      });
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
    res.json({
      ok: true,
      restored: outcome.restored,
      requiresRestart: outcome.requiresRestart,
      skipped: outcome.skipped,
      skillsAwaitingReview: outcome.skillsAwaitingReview,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

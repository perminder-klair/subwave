// The backup ZIP builder — the half of routes/backup.ts that has two callers.
//
// `GET /backup/export` streams the bytes into an HTTP response; the scheduled
// backup (backup/scheduled.ts) writes the same bytes into STATE_DIR. Both must
// produce the SAME archive — a scheduled zip that differed from a hand-pressed
// one would restore differently, and `POST /backup/import-file` cannot tell
// them apart. Hence one builder rather than a second assembly next to the cron.
//
// What goes in (and what deliberately does not) is documented on the route.
// The short version: settings from the REDACTED view so API keys never leave
// the box, a WAL-safe libraryDb.backup() rather than a raw file copy, and the
// operator media dirs. Host-specific and secret files stay put.
import AdmZip from 'adm-zip';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATE_DIR } from '../config.js';
import * as settings from '../settings.js';
import * as library from '../music/library.js';
import * as libraryDb from '../music/library-db.js';

export const BACKUP_FORMAT = 'subwave-backup';
export const BACKUP_VERSION = 1;

// Top-level state files copied verbatim (settings.json + library.db are handled
// specially; manifest.json is generated).
export const INCLUDE_FILES = ['jingles.json', 'jingles.m3u', 'sfx.json'] as const;
// Top-level state directories copied whole.
export const INCLUDE_DIRS = [
  'persona-avatars',
  'jingles',
  'sfx',
  'voices',
  'themes',
  'skills',
] as const;

export const appVersion = (() => {
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

/**
 * Build the station snapshot. Returns a fully-populated `AdmZip` — the caller
 * decides whether that becomes a response body (`toBuffer()`) or a file.
 *
 * The tmp dir the WAL-safe DB copy lands in is managed here and gone by the
 * time this resolves: `addLocalFile` reads its source eagerly, so the entry is
 * already in memory. A caller must not hold a path into it.
 */
export async function buildBackupZip(): Promise<AdmZip> {
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

    // Listed BEFORE the manifest is added, so `contents` never names itself.
    const manifest = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      appVersion,
      createdAt: new Date().toISOString(),
      contents: zip.getEntries().map(e => e.entryName),
    };
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));

    return zip;
  } finally {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

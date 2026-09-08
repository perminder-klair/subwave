// One-shot, idempotent import of the pre-SQLite state/moods.json into the
// tracks table. Runs on open and archives the JSON once it has been folded in.

import { existsSync } from 'node:fs';
import { readFile, rename } from 'node:fs/promises';
import { LEGACY_MOODS_JSON, requireDb } from './handle.js';
import { normaliseYear } from './rows.js';

// A track entry as the legacy state/moods.json carried it: hand-migrated, so
// every field is optional, and only what the insert reads is declared.
interface LegacyMoodsTrack {
  title?: string;
  artist?: string;
  album?: string;
  year?: number | string;
  genre?: string;
  duration?: number;
  moods?: string[];
  energy?: string;
  taggedAt?: string;
}

export async function maybeMigrateFromMoodsJson(): Promise<void> {
  if (!existsSync(LEGACY_MOODS_JSON)) return;
  const d = requireDb();

  const before = (d.prepare('SELECT COUNT(*) AS n FROM tracks').get() as { n: number }).n;

  const raw = await readFile(LEGACY_MOODS_JSON, 'utf8');
  let parsed: { tracks?: Record<string, LegacyMoodsTrack> } | null;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`[library-db] moods.json parse failed (${err.message}); skipping migration`);
    return;
  }
  const entries: [string, LegacyMoodsTrack][] = parsed?.tracks ? Object.entries(parsed.tracks) : [];
  if (entries.length === 0) {
    console.log('[library-db] moods.json is empty; archiving anyway');
    await archiveMoodsJson();
    return;
  }

  const insert = d.prepare(`
    INSERT OR IGNORE INTO tracks (
      id, title, artist, album, year, genres, duration_sec,
      moods, energy, source, tagger_version, tagged_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = d.transaction((rows: [string, LegacyMoodsTrack][]) => {
    for (const [id, t] of rows) {
      insert.run(
        id,
        t.title ?? null,
        t.artist ?? null,
        t.album ?? null,
        normaliseYear(t.year),
        t.genre ? JSON.stringify([t.genre]) : null,
        Number.isFinite(t.duration) ? t.duration : null,
        Array.isArray(t.moods) ? JSON.stringify(t.moods) : '[]',
        ['low', 'medium', 'high'].includes(t.energy!) ? t.energy : null,
        'legacy-v1',
        1,
        typeof t.taggedAt === 'string' ? t.taggedAt : null,
      );
    }
  });
  tx(entries);

  const after = (d.prepare('SELECT COUNT(*) AS n FROM tracks').get() as { n: number }).n;
  const inserted = after - before;
  console.log(
    `[library-db] migrated ${inserted} new entries from moods.json (${entries.length} in file, ${before} already present)`,
  );
  await archiveMoodsJson();
}

async function archiveMoodsJson(): Promise<void> {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const archived = `${LEGACY_MOODS_JSON}.archived.${ts}`;
  try {
    await rename(LEGACY_MOODS_JSON, archived);
    console.log(`[library-db] archived legacy moods.json → ${archived}`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[library-db] could not archive moods.json: ${err.message}`);
    }
  }
}



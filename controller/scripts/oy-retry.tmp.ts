import Database from 'better-sqlite3';
import { lookupOriginalYear } from '../src/music/musicbrainz.js';

const db = new Database(process.env.VDB!);
// Reset resolutions that violate the new file-year cap (originals can't
// post-date the file's own release) so they re-resolve under the fixed rules.
const bad = db.prepare(`UPDATE tracks SET original_year=NULL, original_year_source=NULL
  WHERE is_compilation=1 AND original_year IS NOT NULL AND year IS NOT NULL AND original_year > year`).run();
console.log('reset cap-violating rows:', bad.changes);

const rows = db.prepare(`SELECT id, title, artist, year FROM tracks
  WHERE is_compilation=1 AND original_year IS NULL AND original_year_checked_at IS NOT NULL`).all() as any[];
console.log('retrying misses:', rows.length);

const upd = db.prepare(`UPDATE tracks SET
  original_year = COALESCE(?, original_year),
  original_year_source = CASE WHEN ? IS NOT NULL THEN 'musicbrainz' ELSE original_year_source END,
  original_year_checked_at = ? WHERE id = ?`);

let checked = 0, resolved = 0;
for (const r of rows) {
  const y = await lookupOriginalYear({ title: r.title, artist: r.artist, year: r.year });
  upd.run(y, y, new Date().toISOString(), r.id);
  checked++; if (y != null) resolved++;
  if (checked % 50 === 0) console.log(`retry ${checked}/${rows.length} (${resolved} newly resolved)`);
}
console.log(`RETRY DONE: ${resolved}/${rows.length} newly resolved`);

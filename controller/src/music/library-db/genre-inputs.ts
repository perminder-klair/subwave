// A version that moves on every write to what the genre-suggestion walk reads
// (#1991), and on nothing else. changeToken() moves on any commit, and on air
// every aired track's plays row is one, so a cache keyed on it was invalidated
// every few minutes by writes that cannot change a genre.
//
// The walk reads tracks' rowid, id and genres, the text vector per id, and
// (for the tagged count per genre) whether a track has moods. The tracks half is
// enforced by the schema: these triggers fire for every connection, the tagger
// and analyzer children included, and for raw SQL as much as for this module.
// track_vectors is a vec0 virtual table, which cannot carry a trigger, so every
// statement that writes it is paired with touchGenreInputs() in the same
// function; scripts/genre-inputs.test.ts holds src/ to that.
//
// Outside the user_version chain, like track_facet_status, and checked on every
// open: a migration that rebuilds tracks drops its triggers with the table, and
// the next ensure puts them back. A changed definition needs a new trigger
// name, since IF NOT EXISTS never replaces one. A migration that drops
// tracks.genres or tracks.moods must DROP TRIGGER genre_inputs_tracks_update
// first: SQLite refuses to drop a column a trigger names, and the walk reading
// one fewer column needs a new definition here anyway.
//
// An accelerator, not schema, like the count indexes: without it genre
// suggestions are only re-walked more often. So nothing here may fail an open,
// a read or a vector write. Until an open has put the table, its row and every
// trigger in place, the token is changeToken(), and a bump with no table to
// bump is a no-op.

import Database from 'better-sqlite3';
import { getDbNonce, requireDb } from './handle.js';
import { changeToken } from './stats.js';

const BUMP = 'UPDATE genre_inputs SET version = version + 1 WHERE pk = 1;';
const TRIGGERS = ['genre_inputs_tracks_insert', 'genre_inputs_tracks_update', 'genre_inputs_tracks_delete'];
const STATE_SQL = `SELECT (SELECT COUNT(*) FROM sqlite_master
                            WHERE type = 'trigger' AND name IN (${TRIGGERS.map(() => '?').join(', ')})) AS triggers,
                          (SELECT version FROM genre_inputs WHERE pk = 1) AS version`;

const missingTable = (err: unknown) => /no such table: (?:main\.)?genre_inputs\b/.test((err as Error)?.message ?? '');

// The version, or null unless the table, its row and all three triggers are in
// place. A missing trigger counts: a version nothing bumps would freeze, and
// a frozen token serves one walk forever.
function trackedVersion(d: Database.Database): number | null {
  let row: { triggers: number; version: number | null };
  try {
    row = d.prepare(STATE_SQL).get(...TRIGGERS) as typeof row;
  } catch (err) {
    if (missingTable(err)) return null;
    throw err;
  }
  return row.triggers === TRIGGERS.length && row.version !== null ? row.version : null;
}

// Reads first and writes only when something is missing. Every process opens
// through here, and INSERT OR IGNORE takes the write lock even when the row is
// there: a tagger or analyzer child opening while another connection holds a
// long write would wait out the busy timeout. One transaction, so the table
// never stands without the triggers that move it.
//
// A failure warns rather than throws (an upgrade's first open while another
// connection writes for longer than the busy timeout). Throwing was not a
// retry: open() sets the handle before migrate(), so the next load() found it
// set, skipped migrate(), and the process ran on without the table. Returns
// whether everything is in place.
export function ensureGenreInputs(d: Database.Database): boolean {
  try {
    if (trackedVersion(d) !== null) return true;
    d.transaction(() => d.exec(`
      CREATE TABLE IF NOT EXISTS genre_inputs (
        pk      INTEGER PRIMARY KEY CHECK (pk = 1),
        version INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO genre_inputs (pk, version) VALUES (1, 0);
      CREATE TRIGGER IF NOT EXISTS genre_inputs_tracks_insert AFTER INSERT ON tracks BEGIN
        ${BUMP}
      END;
      -- Any change of moods, not only tagged-ness: that test parses JSON, and a
      -- trigger that can throw would fail the tagger's write instead of a read.
      CREATE TRIGGER IF NOT EXISTS genre_inputs_tracks_update AFTER UPDATE OF id, genres, moods ON tracks
      WHEN OLD.id IS NOT NEW.id OR OLD.genres IS NOT NEW.genres OR OLD.moods IS NOT NEW.moods
      BEGIN
        ${BUMP}
      END;
      CREATE TRIGGER IF NOT EXISTS genre_inputs_tracks_delete AFTER DELETE ON tracks BEGIN
        ${BUMP}
      END;
    `)).immediate();
    return true;
  } catch (err) {
    console.warn(
      `[library-db] genre_inputs not ensured (${(err as Error).message}); ` +
        'genre suggestions key on every commit until the next open retries',
    );
    return false;
  }
}

// For a writer of track_vectors, after its write and inside its transaction
// where it has one. With no table there is no version to move, and the token
// is then changeToken(), which the write itself moves.
export function touchGenreInputs(d: Database.Database = requireDb()): void {
  try {
    d.prepare(BUMP).run();
  } catch (err) {
    if (!missingTable(err)) throw err;
  }
}

// One statement: the version by primary key and the three triggers by name.
// The nonce keeps versions from different handles apart, as in changeToken().
// Anything missing falls back to the token that moves on everything, and the
// next open puts it back.
export function genreInputsToken(): string {
  const version = trackedVersion(requireDb());
  return version === null ? `any.${changeToken()}` : `${getDbNonce()}.${version}`;
}

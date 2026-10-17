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
// name, since IF NOT EXISTS never replaces one.

import Database from 'better-sqlite3';
import { getDbNonce, requireDb } from './handle.js';
import { changeToken } from './stats.js';

const BUMP = 'UPDATE genre_inputs SET version = version + 1 WHERE pk = 1;';
const TRIGGERS = ['genre_inputs_tracks_insert', 'genre_inputs_tracks_update', 'genre_inputs_tracks_delete'];

// Reads first and writes only when something is missing. Every process opens
// through here, and INSERT OR IGNORE takes the write lock even when the row is
// there: a tagger or analyzer child opening while another connection holds a
// long write would wait out the busy timeout and fail its open(). One
// transaction, so the table never stands without the triggers that move it.
export function ensureGenreInputs(d: Database.Database): void {
  const present = new Set((d.prepare(
    `SELECT name FROM sqlite_master
      WHERE (type = 'table' AND name = 'genre_inputs')
         OR (type = 'trigger' AND name IN (${TRIGGERS.map(() => '?').join(', ')}))`,
  ).all(...TRIGGERS) as Array<{ name: string }>).map((r) => r.name));
  if (
    present.has('genre_inputs') &&
    TRIGGERS.every((name) => present.has(name)) &&
    d.prepare('SELECT 1 FROM genre_inputs WHERE pk = 1').get()
  ) return;
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
}

// For a writer of track_vectors, inside the same transaction as its write.
export function touchGenreInputs(d: Database.Database = requireDb()): void {
  d.prepare(BUMP).run();
}

// One primary-key read. The nonce keeps versions from different handles apart,
// as in changeToken(). A missing row would freeze the version, so it falls back
// to the token that moves on everything; the next open restores the row.
export function genreInputsToken(): string {
  const row = requireDb().prepare('SELECT version FROM genre_inputs WHERE pk = 1').get() as
    | { version: number }
    | undefined;
  return row ? `${getDbNonce()}.${row.version}` : `any.${changeToken()}`;
}

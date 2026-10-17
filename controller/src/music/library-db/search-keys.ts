// Stored search keys for the Library search's query language
// (music/search-query.ts): each track's folded name keys, its credited acts, its
// genre runs and its tag and mood lists, so a query compares stored text with
// native LIKE and = instead of running JS for every row.
//
// Kept current without touching any writer: a pure-SQL trigger (STALE_TRIGGER,
// no JS functions, so it fires on any connection and on an older controller)
// clears `search_fresh` when a source column changes, new rows start with it
// NULL, and before a query search refreshSearchKeys() recomputes just those rows,
// found through a partial index. It does nothing when the database has not
// changed since the last refresh.

import { getDbNonce, requireDb } from './handle.js';
import { safeParseArray } from './rows.js';
import { artistNameKey, artistParticipantKeys, nameKey } from '../recency.js';
import { genreRuns, normGenre } from '../genre-fold.js';

export const SEARCH_KEY_COLUMNS = [
  'title_key', 'artist_key', 'album_key', 'artist_keys',
  'genre_keys', 'genre_runs', 'tag_keys', 'mood_keys',
] as const;

// `genre` is not a source: it is generated from genres[0].
const SOURCE_COLUMNS = ['title', 'artist', 'album', 'genres', 'moods', 'audio_moods', 'lastfm_tags'];

/**
 * The schema migration 29 adds: the key columns, the stale marker, its trigger and index.
 * `UPDATE OF` fires whenever a statement names a column, and every tagger walk
 * upserts title/artist/album/genres unchanged, so the trigger only marks a row
 * whose value actually changed. Dropped first: CREATE ... IF NOT EXISTS would
 * keep an older definition.
 */
export const SEARCH_KEY_DDL = {
  columns: [...SEARCH_KEY_COLUMNS, 'search_fresh'] as const,
  trigger: `DROP TRIGGER IF EXISTS tracks_search_stale;
    CREATE TRIGGER tracks_search_stale AFTER UPDATE OF ${SOURCE_COLUMNS.join(', ')} ON tracks
    WHEN ${SOURCE_COLUMNS.map(c => `NEW.${c} IS NOT OLD.${c}`).join(' OR ')}
    BEGIN UPDATE tracks SET search_fresh = NULL WHERE id = NEW.id; END;`,
  index: 'CREATE INDEX IF NOT EXISTS tracks_search_stale_idx ON tracks(id) WHERE search_fresh IS NULL;',
};

/** Separates the keys in a list column; a typed query can never contain it. */
export const KEY_SEP = '\u001f';

const keyList = (keys: Iterable<string>): string => {
  const set = new Set([...keys].filter(Boolean));
  return set.size ? `${KEY_SEP}${[...set].join(KEY_SEP)}${KEY_SEP}` : '';
};

// As show-filter's trackGenres reads them: the `genres` array, strings or
// OpenSubsonic `{ name }` objects. Always valid JSON: the generated `genre`
// column's index makes SQLite refuse anything else on write.
function genreList(genresJson: string | null): string[] {
  const parsed: unknown[] = genresJson ? JSON.parse(genresJson) : [];
  return parsed
    .map(g => (typeof g === 'string' ? g : String((g as { name?: unknown })?.name ?? '')))
    .filter(Boolean);
}

interface SourceRow {
  id: string;
  title: string | null; artist: string | null; album: string | null;
  genres: string | null;
  moods: string | null; audio_moods: string | null; lastfm_tags: string | null;
}

let refreshedAt: string | null = null;

const changeMark = (): string => {
  const d = requireDb();
  const changes = (d.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
  return `${getDbNonce()}:${d.pragma('data_version', { simple: true })}:${changes}`;
};

/** Bring every row's search keys up to date with its source fields. */
export function refreshSearchKeys(): void {
  if (changeMark() === refreshedAt) return;
  const d = requireDb();
  // Outside a write lock first: most refreshes find nothing to do, and waiting
  // for the lock while a tagger walk holds it would stall the event loop.
  if (!d.prepare('SELECT 1 FROM tracks WHERE search_fresh IS NULL LIMIT 1').get()) {
    refreshedAt = changeMark();
    return;
  }
  const select = d.prepare(`SELECT id, ${SOURCE_COLUMNS.join(', ')} FROM tracks WHERE search_fresh IS NULL`);
  const update = d.prepare(
    `UPDATE tracks SET ${SEARCH_KEY_COLUMNS.map(c => `${c} = ?`).join(', ')}, search_fresh = 1 WHERE id = ?`,
  );
  // Read and write under one write lock (IMMEDIATE): the tagger and analyzer are
  // other processes, and a row they change between a separate SELECT and this
  // write would be marked fresh with keys built from its old values.
  d.transaction(() => {
    for (const r of select.all() as SourceRow[]) {
      const genres = genreList(r.genres);
      const moods = [...safeParseArray(r.moods ?? '[]'), ...safeParseArray(r.audio_moods ?? '[]')];
      const lastfm = safeParseArray(r.lastfm_tags ?? '[]');
      const artist = r.artist ?? '';
      update.run(
        nameKey(r.title), nameKey(artist), nameKey(r.album),
        keyList(artist ? [artistNameKey(artist), ...artistParticipantKeys(artist)] : []),
        keyList(genres.map(normGenre)),
        keyList(genres.flatMap(genreRuns)),
        keyList([...genres, ...moods, ...lastfm].map(nameKey)),
        keyList(moods.map(nameKey)),
        r.id,
      );
    }
  }).immediate();
  refreshedAt = changeMark();
}

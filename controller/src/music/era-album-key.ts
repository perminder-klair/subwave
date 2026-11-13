// The era review's album identity (Library → Era): the (album artist, album)
// pair folded to lowercase-trim and joined with NUL, so two artists with an
// identically named album stay two albums, and case or stray whitespace never
// mints a second override. Every consumer keys through albumEraKey in JS or
// ERA_ALBUM_KEY_SQL in SQL, never a hand-rolled join (music/era-review.ts).
//
// A module of its own, importing nothing, because the library's index list
// (library-db/stats.ts) builds an expression index on ERA_ALBUM_KEY_SQL, and
// SQLite uses an expression index only for a query whose expression is the
// same one: the index and every lookup must share this one string.

/** SQLite's own fold, reproduced: LOWER() changes only ASCII A-Z and TRIM()
 *  strips only spaces. JS toLowerCase()/trim() fold far more ('À' → 'à', tabs,
 *  NBSP), and a key folded differently on the two sides never matches: the
 *  override is refused as "not scanned" ('Volume 7 L'Homme À La Tête De Chou',
 *  'Erlend Øye'). */
function sqliteFold(s: string | null | undefined): string {
  return (s ?? '').replace(/^ +| +$/g, '').replace(/[A-Z]/g, c => c.toLowerCase());
}

/** The override table's primary key for an (album artist, album) pair. */
export function albumEraKey(albumArtist: string | null | undefined, album: string | null | undefined): string {
  return `${sqliteFold(albumArtist)}\u0000${sqliteFold(album)}`;
}

/** SQL twin of albumEraKey over the tracks columns. Keep the two in step
 *  (albumEraKey folds the way these SQLite built-ins do). Unqualified on
 *  purpose: idx_tracks_era_album_key is built on exactly this expression. */
export const ERA_ALBUM_KEY_SQL =
  "LOWER(TRIM(COALESCE(album_artist, ''))) || char(0) || LOWER(TRIM(COALESCE(album, '')))";

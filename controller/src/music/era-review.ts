// Era review: the operator surface over the anthology detector's
// verdict. era-suspect.ts owns the judgement; this module keys albums the way
// overrides are stored, applies an operator's record at walk time, answers the
// admin Library → Era tab's questions, and writes the CSV export.
//
// One override row per album holds the operator's record: its KIND
// (album-kind.ts; else the title's suggestion is written per track) and/or a
// DECISION, the way out of the review list:
//   'trusted' — the album year is right: era_untrusted 0 on every track;
//   'year'    — one year for every track: a MANUAL original year on each, which
//               no lookup overwrites and the walk re-applies to tracks added
//               later; the stored verdict goes back to the walk's own. A year
//               the operator typed for a track is not the decision's: that
//               track keeps (and reads as) its own. Each track the decision
//               writes records what it held before, and removing the decision
//               puts exactly that back (tracks.setDecisionOriginalYear), as
//               the walk does for a track that leaves the album for one with
//               no year decision (applyWalkForcedYear);
//   'suspect' — per-track years: era_untrusted 1, each track resolved by the
//               lookups or by hand.
// An album leaves "To review" once it is DONE: trusted, one year, or every
// track holding a recording year.
//
// Album identity is the (album artist, album) pair folded to
// lowercase-trim and joined with NUL, so two artists with an identically
// named album stay two albums, and case or stray whitespace never mints a
// second override. Every consumer — the walk, the override application, the
// listing — must key through albumEraKey (or ERA_ALBUM_KEY_SQL in SQL), never
// a hand-rolled join.
//
// Functions take the better-sqlite3 handle explicitly rather than reaching
// through library-db, so the routes and tests share one code path. The
// exception is a decision's per-track writes (the stored verdict, a one-year
// decision's year), which go through library-db/tracks.ts on the library's own
// (same) handle, so the text vector and the year facet follow them by the
// rules every other era write uses.

import type Database from 'better-sqlite3';
import { decisionRecordKeys, eraSnapshot, markTextVectorDirtyIfEraMoved, restoreDecisionOriginalYear, setDecisionOriginalYear, setStoredEraVerdict } from './library-db/tracks.js';
import { ORIGINAL_YEAR_MIN, isValidOriginalYear, originalYearMax } from '../schemas/library.js';
import { isAlbumKind, labelOwner, ownerFolderOf, suggestAlbumKind, suggestedDecision, type AlbumKind, type EraDecision, type OwnerContext, type OwnerInput } from './album-kind.js';
import { artistParticipantKeys } from './recency.js';
import { ERA_ALBUM_KEY_SQL, albumEraKey } from './era-album-key.js';
import { fileNameOf, folderOf, groupCopies, mainFolderOf, type CopyInput } from './era-copies.js';

export type EraVerdict = EraDecision;

/** The operator's record for one album. */
export interface EraOverride {
  verdict: EraVerdict | null;
  forcedYear: number | null;
  kind: AlbumKind | null;
}

// The album key lives in era-album-key.ts (one string shared with its index).
export { albumEraKey, ERA_ALBUM_KEY_SQL };

/** The selection both the listing and the CSV export answer over: tracks the
 *  walk marked untrusted, plus every track of an overridden album (a trusted
 *  override zeroes era_untrusted, and the operator still needs to find it). */
const ERA_SELECTION_SQL = `(t.era_untrusted = 1 OR o.album_key IS NOT NULL)`;

/** The per-track year state: the original-year lookup's answer, if any. */
const YEAR_STATE_SQL = `CASE
  WHEN t.original_year IS NOT NULL THEN 'resolved'
  WHEN t.original_year_checked_at IS NOT NULL THEN 'not found'
  ELSE 'unchecked'
END`;

/** One era_override row as stored. */
interface EraOverrideRow { verdict: EraVerdict | null; forced_year: number | null; kind: string | null }

// The one reading of a stored row: a year only on a 'year' decision, and a
// kind only when it is still a known one.
function toOverride(r: EraOverrideRow): EraOverride {
  return {
    verdict: r.verdict ?? null,
    forcedYear: r.verdict === 'year' ? r.forced_year ?? null : null,
    kind: isAlbumKind(r.kind) ? r.kind : null,
  };
}

export function loadEraOverrides(d: Database): Map<string, EraOverride> {
  const rows = d.prepare(`SELECT album_key, verdict, forced_year, kind FROM era_override`).all() as
    Array<EraOverrideRow & { album_key: string }>;
  return new Map(rows.map(r => [r.album_key, toOverride(r)]));
}

/** Where a walk reads an album's record: a Map snapshot (tests, the listing)
 *  or liveEraOverrides, which reads each album as the walk reaches it. */
export interface EraOverrideLookup {
  get(albumKey: string): EraOverride | null | undefined;
}

/**
 * The walk's view of the era records: each album's record read from the table
 * when the walk reaches it, never a snapshot taken before the run. A run walks
 * for a long time, and with tagging on a schedule an operator's click can land
 * mid-run: from a snapshot, a one-year decision removed after the run began
 * would still be applied (applyWalkForcedYear), written back as a manual year
 * that no later run takes away. One indexed read per song.
 */
export function liveEraOverrides(d: Database): EraOverrideLookup {
  const stmt = d.prepare(`SELECT verdict, forced_year, kind FROM era_override WHERE album_key = ?`);
  return {
    get(albumKey: string) {
      const r = stmt.get(albumKey) as EraOverrideRow | undefined;
      return r ? toOverride(r) : null;
    },
  };
}

function loadOverrideRow(d: Database, albumKey: string): EraOverride | null {
  return liveEraOverrides(d).get(albumKey) ?? null;
}

// Write the record, or drop the row once it carries nothing.
function writeOverride(d: Database, albumKey: string, o: EraOverride): void {
  if (!o.verdict && !o.kind) {
    d.prepare(`DELETE FROM era_override WHERE album_key = ?`).run(albumKey);
    return;
  }
  d.prepare(
    `INSERT INTO era_override (album_key, verdict, forced_year, kind, set_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(album_key) DO UPDATE SET verdict = excluded.verdict, forced_year = excluded.forced_year,
       kind = excluded.kind, set_at = excluded.set_at`,
  ).run(albumKey, o.verdict, o.verdict === 'year' ? o.forcedYear : null, o.kind, new Date().toISOString());
}

export interface EraWalkSong {
  albumArtist?: string | null;
  album?: string | null;
  albumEraUntrusted?: boolean | null;
  albumEraReason?: string | null;
  /** The album record's originalReleaseDate year, and the file's own year. */
  albumOriginalYear?: number | null;
  year?: number | null;
  /** The walk's album-level inputs to album-kind.labelOwner(). */
  albumOwner?: OwnerInput | null;
}

export interface EraWalkFields {
  eraUntrusted: boolean | null;
  eraReason: string | null;
  albumArtist: string | null;
  /** The effective kind: the operator's, else the title's suggestion on a
   *  flagged album, else null. */
  albumKind: AlbumKind | null;
  /** A 'year' decision's year, for the walk to write as the track's manual
   *  original year when it does not hold one already. */
  forcedYear: number | null;
  /** The album tag's year to record as the track's original year
   *  ('album-tag'), or null (albumTagYear). */
  originalYear: number | null;
}

/**
 * The album tag's year (#842, #1418), but only when it says something, which
 * needs both:
 *  - the album is not era-suspect: on a reissue anthology that date is the
 *    reissue's own, so recording it states the wrong year AND hides the track
 *    from the MusicBrainz pass, which skips resolved rows. Suspect is the
 *    detector's flag OR the operator's Suspect decision, which outranks a
 *    detector that later stops flagging the album (operator curation outranks
 *    the detector). A Trust decision does not release it: the operator
 *    confirmed the file's year, which is what a trusted album resolves to with
 *    no album-tag year;
 *  - it differs from the file's `year` (equal tells us nothing).
 * NULL is behaviour-neutral: resolveEraYear falls through to `year` for a
 * trusted album, and it keeps the track eligible for a lookup.
 */
function albumTagYear(song: EraWalkSong, o: EraOverride | null | undefined): number | null {
  if (song.albumEraUntrusted || o?.verdict === 'suspect') return null;
  const ord = song.albumOriginalYear ?? null;
  if (ord == null) return null;
  return ord === (song.year ?? null) ? null : ord;
}

/**
 * The walk's half of a one-year decision, run after the track's row holds the
 * album the walk just read (`albumKey`, the album's `forcedYear` if it has a
 * one-year decision):
 *  - on an album with a one-year decision, a track the decision has not
 *    written yet (added after the decision, cleared by hand, or arrived from
 *    another album) gets the album's year, recorded as this album's decision's
 *    so removing it gives the track back what it had. A track that came from
 *    another album's year decision keeps its first record, which now names
 *    this album. A track the operator set by hand keeps its own
 *    (tracks.setDecisionOriginalYear skips it);
 *  - on an album without one, a track still holding another album's record
 *    has left that album (retagged, or the album renamed so its key moved):
 *    it gets back what it held, as removing the decision would have done,
 *    since that removal looks tracks up by the old key and would never find
 *    it (#2319). A rename is treated as a move: the album returns to review.
 *    A record with no key (written before #2319) is left as it is. Leaving
 *    is judged on the album key the row holds (tracks.decisionRecordKeys),
 *    the one the decision's removal would look the track up by.
 * Returns whether the track's year was written or restored.
 */
export function applyWalkForcedYear(id: string, albumKey: string, forcedYear: number | null): boolean {
  if (forcedYear != null) return setDecisionOriginalYear(id, forcedYear, albumKey);
  // Judged against the key the row holds, the one a decision's removal looks
  // the track up by: a walk whose server leaves out the album artist keeps the
  // stored one, and must not read that as the track leaving its album.
  const keys = decisionRecordKeys(id);
  if (!keys?.heldBy || keys.heldBy === keys.current) return false;
  return restoreDecisionOriginalYear(id);
}

// The stored verdict a decision implies: trusted 0, per-track 1, otherwise
// (one year, or no decision) the walk's own — a forced year resolves the era
// on its own, so it needs no verdict.
function verdictFor(o: EraOverride | null | undefined, walk: boolean | null): boolean | null {
  if (o?.verdict === 'trusted') return false;
  if (o?.verdict === 'suspect') return true;
  return walk;
}

/**
 * The override-aware era fields one walked song contributes to its row. A
 * decision replaces the walk's stored VERDICT; `eraReason` stays whatever the
 * walk computed — it is audit truth about why the detector flagged the album,
 * and an override must never rewrite it.
 */
export function eraWalkFields(
  song: EraWalkSong,
  overrides: EraOverrideLookup,
  ownerCtx?: OwnerContext,
): EraWalkFields {
  const albumArtist = song.albumArtist ?? null;
  const o = overrides.get(albumEraKey(albumArtist, song.album));
  const reason = song.albumEraReason ?? null;
  return {
    eraUntrusted: verdictFor(o, song.albumEraUntrusted ?? null),
    eraReason: reason,
    albumArtist,
    albumKind: o?.kind ?? (song.albumEraUntrusted
      ? suggestAlbumKind({ album: song.album, reason, label: song.albumOwner ? labelOwner(song.albumOwner, ownerCtx) : null })
      : null),
    forcedYear: o?.forcedYear ?? null,
    originalYear: albumTagYear(song, o),
  };
}

// A folder holding albums by at least this many different album artists is
// one of the library's own sorting folders, not an owner (album-kind).
const CONTAINER_FOLDER_OWNERS = 5;
const OWNER_CONTEXT_TTL_MS = 10 * 60_000;
let ownerContextMemo: { at: number; d: Database; ctx: OwnerContext } | null = null;

/**
 * What album-kind.labelOwner() needs to know about the whole library: whether
 * a name is an artist on any track (every act credited, folded as the artist
 * guards fold names, recency.artistParticipantKeys, so "Bob Sinclar & DJ
 * Gregory" is an artist because Bob Sinclar is), and whether a folder sorts
 * many owners' albums. One pass over the tracks (file_path is a wide-row
 * read, about a second on 72k tracks): taken once per walk, and memoised for
 * ten minutes for the Era tab's clicks.
 */
export function libraryOwnerContext(d: Database, { fresh = false } = {}): OwnerContext {
  const now = Date.now();
  if (!fresh && ownerContextMemo && ownerContextMemo.d === d && now - ownerContextMemo.at < OWNER_CONTEXT_TTL_MS) {
    return ownerContextMemo.ctx;
  }
  const known = new Set<string>();
  const owners = new Map<string, Set<string>>();
  for (const r of d.prepare('SELECT artist, album_artist, file_path FROM tracks').iterate() as Iterable<{ artist: string | null; album_artist: string | null; file_path: string | null }>) {
    if (r.artist) for (const k of artistParticipantKeys(r.artist)) known.add(k);
    const folder = ownerFolderOf(r.file_path);
    if (folder && r.album_artist) {
      const set = owners.get(folder) ?? new Set<string>();
      if (set.size < CONTAINER_FOLDER_OWNERS) set.add(r.album_artist.trim().toLowerCase());
      owners.set(folder, set);
    }
  }
  const ctx: OwnerContext = {
    isArtist: (name: string) => artistParticipantKeys(name).some(k => known.has(k)),
    isContainerFolder: (name: string) => (owners.get(name)?.size ?? 0) >= CONTAINER_FOLDER_OWNERS,
  };
  ownerContextMemo = { at: now, d, ctx };
  return ctx;
}

/** A row the walk has judged since the era columns were added: it stored the album artist, or a
 *  reason. Only such a row's key is the one the walk will look up, and only its
 *  era_reason says what the walk decided. */
const SCANNED_SQL = `(album_artist IS NOT NULL OR era_reason IS NOT NULL)`;

/** Has the walk judged any track of this album since the era columns were added? An override set
 *  before that would key on a NULL album artist the next walk then fills in,
 *  orphaning it, so the route refuses until a library scan has run. */
export function albumScanned(d: Database, albumKey: string): boolean {
  return !!d.prepare(
    `SELECT 1 FROM tracks WHERE ${ERA_ALBUM_KEY_SQL} = ? AND ${SCANNED_SQL} LIMIT 1`,
  ).get(albumKey);
}

// The stored verdict each row should hold, as SQL: a decision's, or the walk's
// own, which a scanned row's era_reason records (non-NULL exactly when the
// detector flagged it; it travels with the verdict, tracks.upsertTrackMeta).
function wantSql(verdict: EraVerdict | null): string {
  if (verdict === 'trusted') return '0';
  if (verdict === 'suspect') return '1';
  return `(CASE WHEN era_reason IS NOT NULL THEN 1 ELSE 0 END)`;
}

/**
 * Record, change, or remove the operator's DECISION for one album, and apply
 * it to the existing rows at once — no walk needed for a click to take effect.
 * The album's kind is kept.
 *
 *  - The stored verdict moves only on rows whose value changes
 *    (tracks.setStoredEraVerdict), and the text vector is marked only where
 *    the embedding's `Era:` line really moves (markTextVectorDirtyIfEraChanged,
 *    the one rule for it), judged once per track across the whole change
 *    (tracks.eraSnapshot), never per step. A resolved track keeps its vector.
 *  - 'year' writes `year` as the MANUAL original year of every track but one
 *    the operator set by hand (tracks.setDecisionOriginalYear, which records
 *    what the track held, and under which album key). Leaving 'year'
 *    restores, on exactly the tracks it wrote, what each held before
 *    (tracks.restoreDecisionOriginalYear); a hand-set track, or one whose own
 *    year merely equals the decision's, is not the decision's to clear.
 *  - `null` (Reset) restores the walk's own verdict; unscanned rows are left to
 *    the walk.
 *
 * Returns the number of tracks changed (verdict flipped or year written).
 */
export function setEraOverride(
  d: Database,
  albumKey: string,
  verdict: EraVerdict | null,
  opts: { year?: number | null } = {},
): number {
  if (verdict === 'year' && !isValidOriginalYear(opts.year)) {
    throw new Error(`a year decision needs a year between ${ORIGINAL_YEAR_MIN} and ${originalYearMax()}`);
  }
  return d.transaction(() => {
    const before = loadOverrideRow(d, albumKey);
    writeOverride(d, albumKey, {
      verdict,
      forcedYear: verdict === 'year' ? (opts.year as number) : null,
      kind: before?.kind ?? null,
    });
    const changed = new Set<string>();
    // Every write below reaches only this album's tracks. Their `Era:` line is
    // compared once, across the whole decision change, so a step that passes
    // through "unknown" (Trust ↔ one year of the file's own year) marks
    // nothing it ends up not moving (#2319).
    const albumIds = (d.prepare(`SELECT id FROM tracks WHERE ${ERA_ALBUM_KEY_SQL} = ?`).all(albumKey) as Array<{ id: string }>)
      .map(r => r.id);
    const eraBefore = eraSnapshot(albumIds);
    const deferred = { markVector: false };

    // Leaving a one-year decision gives each track it wrote back what it held.
    // A change of year needs no undo: the record keeps the track's own year.
    if (before?.verdict === 'year' && verdict !== 'year') {
      const ids = d.prepare(
        `SELECT id FROM tracks WHERE ${ERA_ALBUM_KEY_SQL} = ? AND era_forced_from IS NOT NULL`,
      ).all(albumKey) as Array<{ id: string }>;
      for (const { id } of ids) if (restoreDecisionOriginalYear(id, deferred)) changed.add(id);
    }

    const want = wantSql(verdict);
    const scope = verdict === 'trusted' || verdict === 'suspect' ? '' : `AND ${SCANNED_SQL}`;
    const flips = d.prepare(
      `SELECT id, ${want} AS want FROM tracks
        WHERE ${ERA_ALBUM_KEY_SQL} = ? ${scope}
          AND era_untrusted IS NOT ${want}`,
    ).all(albumKey) as Array<{ id: string; want: number }>;
    for (const { id, want: untrusted } of flips) {
      // The year facet reads the verdict (a trusted album needs no lookup), so
      // its row is re-derived like any walk that changes the era columns.
      setStoredEraVerdict(id, untrusted === 1, deferred);
      changed.add(id);
    }

    if (verdict === 'year') {
      for (const id of albumIds) if (setDecisionOriginalYear(id, opts.year as number, albumKey, deferred)) changed.add(id);
    }
    markTextVectorDirtyIfEraMoved(eraBefore);
    return changed.size;
  })();
}

/**
 * Set or clear the operator's KIND for one album, applied at once to every
 * track's album_kind (what a show's excludedAlbumKinds reads). `null` goes back
 * to the title's suggestion on a flagged track. The decision is kept. Returns
 * the number of tracks whose kind changed.
 */
export function setEraKind(d: Database, albumKey: string, kind: AlbumKind | null): number {
  return d.transaction(() => {
    const before = loadOverrideRow(d, albumKey);
    writeOverride(d, albumKey, {
      verdict: before?.verdict ?? null,
      forcedYear: before?.forcedYear ?? null,
      kind,
    });
    const rows = d.prepare(
      `SELECT id, album, era_reason, album_kind, album_artist, artist, file_path FROM tracks WHERE ${ERA_ALBUM_KEY_SQL} = ?`,
    ).all(albumKey) as Array<{
      id: string; album: string | null; era_reason: string | null; album_kind: string | null;
      album_artist: string | null; artist: string | null; file_path: string | null;
    }>;
    const set = d.prepare(`UPDATE tracks SET album_kind = ? WHERE id = ?`);
    // The walk's own label signal, read back from the stored rows.
    const label = labelOwner({
      albumArtist: rows.find(r => r.album_artist)?.album_artist ?? null,
      path: rows.find(r => r.file_path)?.file_path ?? null,
      trackArtists: rows.map(r => r.artist),
    }, libraryOwnerContext(d));
    let n = 0;
    for (const r of rows) {
      const want = kind ?? (r.era_reason ? suggestAlbumKind({ album: r.album, reason: r.era_reason, label }) : null);
      if (want === r.album_kind) continue;
      set.run(want, r.id);
      n += 1;
    }
    return n;
  })();
}

export interface EraAlbumRow {
  albumKey: string;
  album: string | null;
  albumArtist: string | null;
  /** The stored walk reason (audit truth); null when the walk never flagged
   *  it and only an override put this album on the list. */
  reason: string | null;
  tracks: number;
  yearResolved: number;
  yearNotFound: number;
  yearUnchecked: number;
  /** The album's own release-year tag, as the walk stored it. */
  year: number | null;
  overridden: boolean;
  /** False until a library scan has judged this album since the update; the
   *  override buttons wait for it (albumScanned). */
  scanned: boolean;
  /** The operator's decision, when there is one. */
  verdict: EraVerdict | null;
  /** A 'year' decision's year. */
  forcedYear: number | null;
  /** The effective kind (the operator's, else the title's suggestion). */
  kind: AlbumKind | null;
  /** True when the operator chose the kind; false when it is the suggestion. */
  kindSet: boolean;
  /** The decision that usually fits the kind (album-kind.suggestedDecision). */
  suggestedVerdict: EraVerdict | null;
  /** Out of the review list: trusted, one year, or every track has a year. */
  done: boolean;
  /** The folder holding most of the album's files (era-copies.mainFolderOf). */
  mainFolder: string | null;
  /** Files that are another copy of a recording already counted (a playlist
   *  folder's copy, a file kept twice); `tracks` still counts them. */
  copies: number;
}

export function listEraAlbums(d: Database): EraAlbumRow[] {
  const rows = d.prepare(
    `SELECT
       ${ERA_ALBUM_KEY_SQL} AS era_album_key,
       MAX(t.album) AS album,
       MAX(t.album_artist) AS album_artist,
       MAX(t.era_reason) AS era_reason,
       COUNT(*) AS tracks,
       SUM(CASE WHEN ${YEAR_STATE_SQL} = 'resolved' THEN 1 ELSE 0 END) AS year_resolved,
       SUM(CASE WHEN ${YEAR_STATE_SQL} = 'not found' THEN 1 ELSE 0 END) AS year_not_found,
       SUM(CASE WHEN ${YEAR_STATE_SQL} = 'unchecked' THEN 1 ELSE 0 END) AS year_unchecked,
       MAX(t.year) AS year,
       MAX(CASE WHEN o.album_key IS NOT NULL THEN 1 ELSE 0 END) AS overridden,
       MAX(CASE WHEN ${SCANNED_SQL} THEN 1 ELSE 0 END) AS scanned,
       MAX(o.verdict) AS verdict,
       MAX(o.forced_year) AS forced_year,
       MAX(o.kind) AS kind_set,
       MAX(t.album_kind) AS album_kind
     FROM tracks t
     LEFT JOIN era_override o ON o.album_key = ${ERA_ALBUM_KEY_SQL}
     WHERE ${ERA_SELECTION_SQL}
     GROUP BY era_album_key
     ORDER BY tracks DESC, era_album_key ASC`,
  ).all() as Array<{
    era_album_key: string; album: string | null; album_artist: string | null; era_reason: string | null;
    tracks: number; year_resolved: number; year_not_found: number; year_unchecked: number;
    year: number | null; overridden: number; scanned: number; verdict: EraVerdict | null;
    forced_year: number | null; kind_set: string | null; album_kind: string | null;
  }>;
  const files = new Map<string, CopyInput[]>();
  for (const f of d.prepare(
    `SELECT ${ERA_ALBUM_KEY_SQL} AS k, t.id, t.title, t.artist, t.duration_sec, t.file_path
       FROM tracks t
       LEFT JOIN era_override o ON o.album_key = ${ERA_ALBUM_KEY_SQL}
      WHERE ${ERA_SELECTION_SQL}`,
  ).all() as Array<{ k: string; id: string; title: string | null; artist: string | null; duration_sec: number | null; file_path: string | null }>) {
    const list = files.get(f.k) ?? [];
    list.push({ id: f.id, title: f.title, artist: f.artist, durationSec: f.duration_sec, filePath: f.file_path });
    files.set(f.k, list);
  }
  return rows.map(r => {
    const albumFiles = files.get(r.era_album_key) ?? [];
    const groups = groupCopies(albumFiles);
    const kindSet = isAlbumKind(r.kind_set);
    const kind = kindSet ? r.kind_set as AlbumKind : isAlbumKind(r.album_kind) ? r.album_kind : null;
    const verdict = r.verdict ?? null;
    return {
    albumKey: r.era_album_key,
    album: r.album,
    albumArtist: r.album_artist,
    reason: r.era_reason,
    tracks: r.tracks,
    yearResolved: r.year_resolved,
    yearNotFound: r.year_not_found,
    yearUnchecked: r.year_unchecked,
    year: r.year,
    overridden: !!r.overridden,
    scanned: !!r.scanned,
    verdict,
    forcedYear: verdict === 'year' ? r.forced_year : null,
    kind,
    kindSet,
    suggestedVerdict: suggestedDecision(kind),
    done: verdict === 'trusted' || verdict === 'year' || r.year_not_found + r.year_unchecked === 0,
    mainFolder: mainFolderOf(albumFiles),
    copies: albumFiles.length - groups.length,
    };
  });
}

export interface EraTrackRow {
  id: string;
  title: string | null;
  artist: string | null;
  year: number | null;
  originalYear: number | null;
  originalYearSource: string | null;
  yearState: 'resolved' | 'not found' | 'unchecked';
  durationSec: number | null;
  /** The file's own name, which usually carries the track number. */
  fileName: string | null;
  /** The file's folder, only when it is NOT the album's main folder. */
  folder: string | null;
  /** Other copies of this recording (same title, artist and length): a year
   *  set here is written to them too. */
  copies: Array<{ id: string; folder: string | null }>;
}

/** One album's tracks for the per-track year editor, a recording's copies
 *  folded under one entry (era-copies.ts). */
export function listEraAlbumTracks(d: Database, albumKey: string): EraTrackRow[] {
  const rows = d.prepare(
    `SELECT t.id, t.title, t.artist, t.year, t.original_year, t.original_year_source, ${YEAR_STATE_SQL} AS year_state,
            t.duration_sec, t.file_path
       FROM tracks t WHERE ${ERA_ALBUM_KEY_SQL} = ?`,
  ).all(albumKey) as Array<{
    id: string; title: string | null; artist: string | null; year: number | null;
    original_year: number | null; original_year_source: string | null; year_state: EraTrackRow['yearState'];
    duration_sec: number | null; file_path: string | null;
  }>;
  const input = rows.map(r => ({ ...r, durationSec: r.duration_sec, filePath: r.file_path }));
  const main = mainFolderOf(input);
  return groupCopies(input, main).map(({ primary: r, copies }) => ({
    id: r.id, title: r.title, artist: r.artist, year: r.year,
    originalYear: r.original_year, originalYearSource: r.original_year_source, yearState: r.year_state,
    durationSec: r.duration_sec,
    fileName: fileNameOf(r.file_path),
    folder: folderOf(r.file_path) === main ? null : folderOf(r.file_path),
    copies: copies.map(c => ({ id: c.id, folder: folderOf(c.file_path) })),
  }));
}

export interface EraSummary {
  albums: number;
  tracks: number;
  /** Tracks per stored walk reason (unflagged override tracks carry none). */
  byReason: Record<string, number>;
  overridden: number;
}

export function countEraSummary(d: Database): EraSummary {
  const totals = d.prepare(
    `SELECT
       COUNT(DISTINCT ${ERA_ALBUM_KEY_SQL}) AS albums,
       COUNT(*) AS tracks,
       COUNT(DISTINCT CASE WHEN o.album_key IS NOT NULL THEN ${ERA_ALBUM_KEY_SQL} END) AS overridden
     FROM tracks t
     LEFT JOIN era_override o ON o.album_key = ${ERA_ALBUM_KEY_SQL}
     WHERE ${ERA_SELECTION_SQL}`,
  ).get() as { albums: number; tracks: number; overridden: number };
  const reasons = d.prepare(
    `SELECT t.era_reason AS reason, COUNT(*) AS n
       FROM tracks t
       LEFT JOIN era_override o ON o.album_key = ${ERA_ALBUM_KEY_SQL}
      WHERE ${ERA_SELECTION_SQL} AND t.era_reason IS NOT NULL
      GROUP BY t.era_reason`,
  ).all() as Array<{ reason: string; n: number }>;
  return {
    albums: totals.albums,
    tracks: totals.tracks,
    byReason: Object.fromEntries(reasons.map(r => [r.reason, r.n])),
    overridden: totals.overridden,
  };
}

function csvField(v: unknown): string {
  if (v == null) return '';
  let s = String(v);
  // A spreadsheet opens a cell that starts with = + - @ (or a tab or CR before
  // one) as a formula. Titles and paths are anyone's text, so such a cell is
  // prefixed with ' (OWASP's CSV injection advice), which shows it as typed.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  // Quote only where RFC4180 demands it; keep plain fields bare for the eye.
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC4180 export of every track on an era-suspect album (same selection as
 *  listEraAlbums), one row per track. The operator reviews the tail of it in
 *  a spreadsheet and brings the album back for the next walk to re-read. */
export function exportEraCsv(d: Database): string {
  const header = 'id,artist,title,album,album_artist,era_reason,album_kind,decision,forced_year,overridden,year,original_year,original_year_source,year_state,file_path,file_suffix,bit_rate,file_size,duration_sec';
  const rows = d.prepare(
    `SELECT t.id, t.artist, t.title, t.album, t.album_artist, t.era_reason,
            COALESCE(o.kind, t.album_kind) AS album_kind, o.verdict AS decision, o.forced_year,
            CASE WHEN o.album_key IS NOT NULL THEN 1 ELSE 0 END AS overridden,
            t.year, t.original_year, t.original_year_source,
            ${YEAR_STATE_SQL} AS year_state,
            t.file_path, t.file_suffix, t.bit_rate, t.file_size, t.duration_sec
       FROM tracks t
       LEFT JOIN era_override o ON o.album_key = ${ERA_ALBUM_KEY_SQL}
      WHERE ${ERA_SELECTION_SQL}
      ORDER BY t.artist COLLATE NOCASE, t.album COLLATE NOCASE, t.id`,
  ).all() as Array<Record<string, unknown>>;
  const lines = [header];
  for (const r of rows) {
    lines.push([
      r.id, r.artist, r.title, r.album, r.album_artist, r.era_reason, r.album_kind, r.decision, r.forced_year,
      r.overridden, r.year, r.original_year, r.original_year_source, r.year_state, r.file_path, r.file_suffix,
      r.bit_rate, r.file_size, r.duration_sec,
    ].map(csvField).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

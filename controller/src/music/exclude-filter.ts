// Exclude-rule resolver for the picker pool and the agent tool surface.
//
// Resolves every enabled `mode: 'exclude'` rule into concrete sets the
// candidate-builder + the AI SDK tools can intersect against. Playlist /
// album exclusions are expanded into song-id sets so the agent can never
// fetch a blocked track via similarSongs / searchLibrary / etc.

import * as settings from '../settings.js';
import * as subsonic from './subsonic.js';

export type ExcludeFilter = {
  ids: Set<string>;
  genres: Set<string>;
  artistIds: Set<string>;
  artistNames: Set<string>;
  albumIds: Set<string>;
  // True iff there is at least one active exclude rule. Cheap shortcut so
  // hot paths can skip the per-candidate matchExclude call entirely.
  active: boolean;
};

const EMPTY: ExcludeFilter = {
  ids: new Set(),
  genres: new Set(),
  artistIds: new Set(),
  artistNames: new Set(),
  albumIds: new Set(),
  active: false,
};

// Memoised expansion of playlist/album sources to song-id sets. Sources change
// at human pace; refreshing on every pick would be wasteful.
const EXPAND_TTL_MS = 30 * 60 * 1000;
const expandCache = new Map<string, { ids: Set<string>; at: number }>();

async function expandPlaylist(ref: string): Promise<Set<string>> {
  const key = `playlist:${ref}`;
  const hit = expandCache.get(key);
  if (hit && Date.now() - hit.at < EXPAND_TTL_MS) return hit.ids;
  const ids = new Set<string>();
  try {
    const songs = (await subsonic.getPlaylist(ref)) || [];
    for (const s of songs) if (s?.id) ids.add(s.id);
  } catch {}
  expandCache.set(key, { ids, at: Date.now() });
  return ids;
}

async function expandAlbum(ref: string): Promise<Set<string>> {
  const key = `album:${ref}`;
  const hit = expandCache.get(key);
  if (hit && Date.now() - hit.at < EXPAND_TTL_MS) return hit.ids;
  const ids = new Set<string>();
  try {
    const songs = (await subsonic.getAlbum(ref)) || [];
    for (const s of songs) if (s?.id) ids.add(s.id);
  } catch {}
  expandCache.set(key, { ids, at: Date.now() });
  return ids;
}

export async function build(): Promise<ExcludeFilter> {
  const rules = (settings.get().rules || []).filter(
    (r: any) => r.enabled && r.mode === 'exclude',
  );
  if (!rules.length) return EMPTY;
  const out: ExcludeFilter = {
    ids: new Set(),
    genres: new Set(),
    artistIds: new Set(),
    artistNames: new Set(),
    albumIds: new Set(),
    active: true,
  };
  for (const r of rules) {
    const { kind, ref } = r.source;
    if (kind === 'genre') {
      out.genres.add(ref.toLowerCase().trim());
    } else if (kind === 'artist') {
      // Operators pick artists by id from the autocomplete, so ref is normally
      // an id — but accept a free-text name match too (case-insensitive)
      // because the genre/artist autocomplete is best-effort.
      out.artistIds.add(ref);
      out.artistNames.add(ref.toLowerCase().trim());
    } else if (kind === 'album') {
      out.albumIds.add(ref);
      for (const id of await expandAlbum(ref)) out.ids.add(id);
    } else if (kind === 'playlist') {
      for (const id of await expandPlaylist(ref)) out.ids.add(id);
    }
  }
  return out;
}

// Matches a single candidate against the filter. Songs that match are blocked.
export function matches(filter: ExcludeFilter, candidate: any): boolean {
  if (!filter.active) return false;
  if (candidate?.id && filter.ids.has(candidate.id)) return true;
  if (candidate?.albumId && filter.albumIds.has(candidate.albumId)) return true;
  if (candidate?.artistId && filter.artistIds.has(candidate.artistId)) return true;
  const artistKey = (candidate?.artist || '').toLowerCase().trim();
  if (artistKey && filter.artistNames.has(artistKey)) return true;
  const genreKey = (candidate?.genre || '').toLowerCase().trim();
  if (genreKey && filter.genres.has(genreKey)) return true;
  return false;
}

export const EMPTY_FILTER = EMPTY;

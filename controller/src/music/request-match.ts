// Direct requests: interpret once, then resolve identity and eligibility in code.
// No model tools or station/session state belong in this module.
export interface RequestMatch {
  kind?: string;
  title?: string | null;
  album?: string | null;
  artist?: string | null;
  genre?: string | null;
  language?: string | null;
  mood?: string | null;
  sort?: string | null;
  scope?: string;
  search_terms?: string[];
  intent?: string;
  ack?: string;
  unsupported?: string[];
  // Controller-owned marker; never part of the model's interpretation schema.
  literal?: boolean;
}

export interface RequestSong {
  id: string;
  title?: string;
  artist?: string;
  album?: string;
  year?: number;
  originalReleaseDate?: { year?: number; month?: number; day?: number };
  releaseDate?: string;
  genre?: string;
  genres?: Array<string | { name: string }>;
  language?: string;
  languages?: string[];
  moods?: string[];
  [key: string]: unknown;
}

export interface RequestCatalog {
  searchPage(query: string, options: { songCount: number; songOffset: number }): Promise<{ songs: RequestSong[]; rawCount: number }>;
  resolveArtist(name: string): Promise<{ id: string; name?: string } | null>;
  getArtist(id: string): Promise<{ album?: Array<{ id: string; name?: string; title?: string; year?: number; originalReleaseDate?: { year?: number; month?: number; day?: number }; releaseDate?: string }> } | null>;
  getAlbum(id: string): Promise<RequestSong[]>;
  getTopSongs(name: string, options: { count: number }): Promise<RequestSong[]>;
  resolveGenreName(name: string): Promise<string | null>;
  getSongsByGenreSampled(genre: string, options: { count: number }): Promise<RequestSong[]>;
}

export interface RequestSelection {
  track: RequestSong | null;
  source: string;
  outcome: 'matched' | 'substituted' | 'cooldown' | 'already-queued' | 'no-match' | 'unsupported';
  errors: string[];
  unmetPreferences?: string[];
}

// Backstop for common conditions a small model can silently omit. Quoted
// names are data: "Everything but the Girl" is not an exclusion instruction.
// This is deliberately bounded, not a second natural-language interpreter.
export function directRequestUnsupported(text: string, match: RequestMatch = {}): string[] {
  const prose = text.replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|(?<![\p{L}\p{N}])'[^'\n]+'(?![\p{L}\p{N}])/gu, ' <name> ');
  const reasons = new Set((match.unsupported || []).filter(reason => reason.trim()));
  if (/\b(?:anything|something|music|songs?|tracks?)\s+(?:except|excluding|but(?: not)?)\b|\b(?:but not|but no|excluding|except(?: for)?|other than)\s+\S|\b(?:do not|don't|don’t)\s+play\b/i.test(prose)) reasons.add('exclusions');
  if (/\b(?:19|20)\d0s\b|\b(?:from|during|in)\s+(?:the\s+)?(?:19|20)\d{2}\b/i.test(prose)) reasons.add('era');
  if (/\b(?:instrumental|acoustic|live)\s+(?:only|music|songs?|tracks?|versions?)\b|\b(?:only|strictly)\s+(?:instrumental|acoustic|live)\b|\bwithout\s+(?:vocals|singing|lyrics)\b/i.test(prose)) reasons.add('recording condition');
  if (/\b(?:song|track|one)\s+(?:from|in)\s+(?:that|the|a)\s+(?:new\s+)?(?:film|movie|show|advert|commercial)\b|\b(?:song|track|one)\s+(?:with|containing|that has)\s+(?:the\s+)?(?:lyrics|words|line)\b/i.test(prose)) reasons.add('external identification');
  if (/\b(?:one|song|track|music)\s+(?:we|you|I)\s+(?:discussed|mentioned|requested|talked about)\s+(?:earlier|before|yesterday|last)\b/i.test(prose)) reasons.add('earlier conversation');
  return [...reasons];
}

export function requestName(value: unknown): string {
  return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[’‘']/g, '').replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim();
}

export function requestArtistMatches(want: unknown, song: RequestSong): boolean {
  const artist = requestName(want);
  if (!artist) return true;
  const credits = [song.artist, ...(Array.isArray(song.artists) ? song.artists.map(a => (a as { name?: string })?.name) : [])];
  return credits.some(credit => {
    if (requestName(credit) === artist) return true;
    // A complete credited name, never an isolated shared word such as "The".
    return String(credit ?? '').split(/\s+(?:feat\.?|featuring|ft\.?)\s+|\s+[&]\s+|;\s*/i)
      .some(part => requestName(part) === artist);
  });
}

export function requestedTitle(match: RequestMatch): string | null {
  if (match.title?.trim()) return match.title.trim();
  if (match.album) return null;
  // A modern reply explicitly saying "no title" must not turn a stray vibe
  // search term into a named recording. Legacy replies can still omit title.
  if (match.title === null && (match.mood || match.genre || match.language)) return null;
  // Compatibility with pre-field model replies and the model-free parser.
  const attributes = [match.artist, match.genre, match.language, match.mood].map(requestName);
  return match.search_terms?.find(term => requestName(term) && !attributes.includes(requestName(term)))?.trim() || null;
}

export function requestTitleMatches(want: unknown, got: unknown): boolean {
  if (requestName(want) === requestName(got)) return true;
  // A mastering suffix does not change the recording. Live/remix/acoustic
  // versions DO, and remain distinct unless the listener asked for them.
  const mastering = (value: unknown) => String(value ?? '').replace(/\s*(?:[-–—]\s*|\(|\[)(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?[\])]?\s*$/i, '');
  return requestName(mastering(want)) === requestName(want) && requestName(want) === requestName(mastering(got));
}

export function modelFreeRequest(text: string): RequestMatch {
  const cleaned = text.replace(/^\s*(?:please\s+)?(?:can|could|would)\s+you\s+/i, '')
    .replace(/^\s*(?:please\s+)?(?:play|put on|queue|request)\s+/i, '').replace(/\s+please[.!?]*$/i, '').trim();
  const unquote = (s: string) => s.replace(/^["'“‘]|["'”’][.!?]*$/g, '').trim();
  const by = cleaned.match(/^(.+?)\s+by\s+(.+?)[.!?]*$/i);
  const describedArtist = cleaned.match(/^(?:some|anything|something|music|a song|a track)\s+.+?\s+by\s+(.+?)[.!?]*$/i);
  if (describedArtist) return { kind: 'track', artist: unquote(describedArtist[1]), title: null,
    unsupported: ['description needs interpretation'], search_terms: [], ack: '' };
  const artistOnly = cleaned.match(/^(?:some|anything by|something by|music by)\s+(.+?)[.!?]*$/i);
  if (artistOnly) return { kind: 'track', artist: unquote(artistOnly[1]), title: null, album: null, search_terms: [], scope: 'song', ack: '' };
  const comma = !by && cleaned.match(/^([^,]+),\s*(.+)$/);
  const title = unquote(by?.[1] || comma?.[2] || cleaned);
  const artist = by?.[2] || comma?.[1] || null;
  return { kind: 'track', title, album: null, artist: artist ? unquote(artist) : null,
    search_terms: [title], genre: null, language: null, mood: null, sort: null,
    scope: 'song', intent: 'library search without model interpretation', ack: '' };
}

// One chronological scale; precise original dates precede release/year fallbacks.
export function requestReleaseRank(album: { year?: number; originalReleaseDate?: { year?: number; month?: number; day?: number }; releaseDate?: string }): number {
  const date = album.originalReleaseDate;
  if (date?.year) return date.year * 10000 + (date.month || 1) * 100 + (date.day || 1);
  const release = new Date(album.releaseDate || '');
  if (Number.isFinite(release.getTime())) return release.getUTCFullYear() * 10000 + (release.getUTCMonth() + 1) * 100 + release.getUTCDate();
  return album.year ? album.year * 10000 + 101 : 0;
}

export async function resolveDirectRequest(match: RequestMatch, deps: {
  catalog: RequestCatalog;
  recentIds: Set<string>;
  queuedIds: Set<string>;
  currentId?: string | null;
  moodSongs(mood: string): Promise<RequestSong[]>;
  fallbackSongs(): Promise<RequestSong[]>;
  similarSongs?(): Promise<RequestSong[]>;
  random?: () => number;
}): Promise<RequestSelection> {
  const { catalog, recentIds, queuedIds, currentId } = deps;
  const errors: string[] = [];
  if (match.unsupported?.some(reason => reason.trim())) return { track: null, source: 'unsupported', outcome: 'unsupported', errors };
  const safe = async <T>(source: string, run: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await run(); } catch (err) { errors.push(`${source}: ${err instanceof Error ? err.message : String(err)}`); return fallback; }
  };
  const title = requestedTitle(match);
  const moodPool = match.mood ? await safe('mood tracks', () => deps.moodSongs(match.mood!), []) : [];
  const moodIds = new Set(moodPool.map(song => song.id));
  const moodMatches = (song: RequestSong) => !match.mood || moodIds.has(song.id)
    || Boolean(song.moods?.some(m => requestName(m) === requestName(match.mood)));
  let resolvedArtistName = match.artist;
  const identity = (song: RequestSong) => (!title || requestTitleMatches(title, song.title))
    && requestArtistMatches(resolvedArtistName, song) && (!match.album || requestName(song.album) === requestName(match.album));
  const tags = (song: RequestSong) => [song.genre, ...(song.genres || []).map(g => typeof g === 'string' ? g : g.name)].map(requestName).filter(Boolean);
  let genre: string | null = null;
  let languageGenre: string | null = null;
  // The interpretation contract only supplies explicitly requested attributes.
  // These requirements also apply to named songs and every alternative.
  if (match.genre) genre = await safe('genre resolution', () => catalog.resolveGenreName(match.genre!), null);
  if (match.language) languageGenre = await safe('language resolution', () => catalog.resolveGenreName(match.language!), null);
  const constraints = (song: RequestSong, source: string) => {
    const genres = tags(song);
    if (match.genre && !(genre && source === `genre:${genre}`)
      && !genres.some(g => g === requestName(genre || match.genre) || g.split(' ').includes(requestName(match.genre)))) return false;
    if (match.language) {
      const languages = [song.language, ...(song.languages || []), ...genres].map(requestName);
      if (!(languageGenre && source === `language-genre:${languageGenre}`) && !languages.includes(requestName(match.language))) return false;
    }
    return true;
  };
  const eligible = (song: RequestSong) => !recentIds.has(song.id) && !queuedIds.has(song.id) && song.id !== currentId;
  const unique = (songs: RequestSong[]) => [...new Map(songs.filter(s => s?.id).map(s => [s.id, s])).values()];
  const choose = (songs: RequestSong[]) => {
    const moodHits = match.mood ? songs.filter(moodMatches) : [];
    const pool = moodHits.length ? moodHits : songs;
    return pool[Math.min(pool.length - 1, Math.floor((deps.random || Math.random)() * pool.length))] || null;
  };
  let held: { track: RequestSong; source: string } | null = null;
  const select = (songs: RequestSong[], source: string, exact = true): RequestSelection | null => {
    const pool = unique(songs).filter(s => constraints(s, source) && (!exact || identity(s)));
    const track = choose(pool.filter(eligible));
    if (track) {
      const unmetPreferences = moodMatches(track) ? [] : ['mood'];
      return { track, source, outcome: exact && !unmetPreferences.length ? 'matched' : 'substituted', errors, unmetPreferences };
    }
    // Preserve the requested identity for an honest refusal, never replace an
    // exact recording merely because it is queued or on cooldown.
    if (exact && pool.length && !held) held = { track: pool[0], source };
    return null;
  };
  const refusal = (): RequestSelection | null => held ? {
    ...held, outcome: queuedIds.has(held.track.id) || held.track.id === currentId ? 'already-queued' : 'cooldown', errors,
  } : null;
  const search = async (term: string) => {
    const found: RequestSong[] = [];
    // Bounded, deterministic pages. rawCount includes filtered/blocked rows.
    for (let songOffset = 0; songOffset < 100; songOffset += 25) {
      const page = await safe('search', () => catalog.searchPage(term, { songCount: 25, songOffset }), { songs: [], rawCount: 0 });
      found.push(...page.songs);
      if (found.some(s => identity(s) && constraints(s, 'search') && (Boolean(title) || eligible(s))) || page.rawCount < 25) break;
    }
    return unique(found);
  };
  let searched: RequestSong[] = [];
  const artistAlternatives: RequestSong[] = [];
  if (title) {
    searched = await search(title);
    const exact = select(searched, 'search:title');
    if (exact) return exact;
    const heldExact = refusal();
    if (heldExact) return heldExact;
    // Accent/punctuation variants or compilation indexing may need the artist
    // catalogue below; never union an artist query into a named-title lottery.
  }

  if (match.artist) {
    if (match.sort === 'popular' && !title && !match.album) {
      const popular = await safe('popular songs', () => catalog.getTopSongs(match.artist!, { count: 100 }), []);
      const candidates = unique(popular).filter(s => identity(s) && constraints(s, 'artist-popular'));
      const best = candidates.find(eligible) || candidates[0];
      const result = select(best ? [best] : [], 'artist-popular');
      if (result) return result;
    }
    const artist = await safe('artist resolution', () => catalog.resolveArtist(match.artist!), null);
    if (artist && (!match.literal || requestArtistMatches(match.artist, { id: artist.id, artist: artist.name }))) {
      resolvedArtistName = artist.name || match.artist;
      const full = await safe('artist albums', () => catalog.getArtist(artist.id), null);
      let albums = full?.album || [];
      if (match.album) albums = albums.filter(a => requestName(a.name || a.title) === requestName(match.album));
      if (match.sort === 'latest' || match.sort === 'oldest') {
        const direction = match.sort === 'latest' ? -1 : 1;
        albums = [...albums].sort((a, b) => {
          const left = requestReleaseRank(a), right = requestReleaseRank(b);
          return !left ? 1 : !right ? -1 : direction * (left - right);
        });
      } else if (albums.length) {
        const offset = Math.floor((deps.random || Math.random)() * albums.length);
        albums = [...albums.slice(offset), ...albums.slice(0, offset)];
      }
      const rankedSongs: Array<{ song: RequestSong; rank: number }> = [];
      const artistMoodPool: RequestSong[] = [];
      const rankIndividualTracks = !title && match.scope !== 'album' && (match.sort === 'latest' || match.sort === 'oldest');
      for (const album of albums.slice(0, 20)) {
        const songs = await safe('album tracks', () => catalog.getAlbum(album.id), []);
        if (title) artistAlternatives.push(...songs.filter(song => requestArtistMatches(resolvedArtistName, song)));
        if (rankIndividualTracks) {
          rankedSongs.push(...songs.map(song => ({ song, rank: requestReleaseRank(song) || requestReleaseRank(album) })));
          continue;
        }
        if (!title && match.mood) {
          artistMoodPool.push(...songs);
          continue;
        }
        const result = select(songs, 'artist-albums');
        if (result) return match.sort === 'popular' ? { ...result, outcome: 'substituted' } : result;
      }
      if (artistMoodPool.length) {
        const result = select(artistMoodPool, 'artist-mood');
        if (result) return match.sort === 'popular' ? { ...result, outcome: 'substituted' } : result;
      }
      if (rankIndividualTracks) {
        const ranks = [...new Set(rankedSongs.map(row => row.rank))].sort((a, b) => !a ? 1 : !b ? -1 : match.sort === 'latest' ? b - a : a - b);
        for (const rank of ranks) {
          const result = select(rankedSongs.filter(row => row.rank === rank).map(row => row.song), 'artist-release');
          if (result) return result;
        }
      }
    }
    // Song artists on compilations need not have an artist-album index entry.
    if (!title) {
      searched = await search(match.album || match.artist);
      const result = select(searched, 'search:artist');
      if (result) return match.sort ? { ...result, outcome: 'substituted' } : result;
    }
  } else if (match.album) {
    searched = await search(match.album);
    const result = select(searched, 'search:album');
    if (result) return result;
  }
  const identityRefusal = refusal();
  if (identityRefusal) return identityRefusal;

  if (!title && !match.album) {
    if (genre) {
      const result = select(await safe('genre tracks', () => catalog.getSongsByGenreSampled(genre!, { count: 100 }), []), `genre:${genre}`);
      if (result) return result;
    }
    if (languageGenre) {
      const result = select(await safe('language tracks', () => catalog.getSongsByGenreSampled(languageGenre!, { count: 100 }), []), `language-genre:${languageGenre}`);
      if (result) return result;
    }
    if (match.mood) {
      const result = select(moodPool, `library-mood:${match.mood}`);
      if (result) return result;
    }
    if (deps.similarSongs) {
      const result = select(await safe('similar tracks', deps.similarSongs, []), 'similar-to-current');
      if (result) return result;
    }
    const constrainedRefusal = refusal();
    if (constrainedRefusal) return constrainedRefusal;
  }
  // A failed interpreter cannot safely relax text it may have misread as a
  // name (e.g. "Queen in French"). Only verified literal identities can queue.
  if (match.literal) return { track: null, source: 'literal-no-match', outcome: 'no-match', errors };
  // Interpreted requests can offer alternatives within their hard constraints.
  const artistAlternative = select(artistAlternatives, 'artist-alternative', false);
  if (artistAlternative) return artistAlternative;
  const fallback = select([...searched, ...await safe('fallback tracks', deps.fallbackSongs, [])], 'fallback', false);
  return fallback || { track: null, source: errors.length ? 'lookup-error' : 'no-match', outcome: 'no-match', errors };
}

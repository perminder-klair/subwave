// Jamendo provider.
//
// A remote Creative-Commons catalogue (https://developer.jamendo.com). Unlike
// Navidrome it needs no self-hosting: the operator pastes a free client_id and
// the picker draws from Jamendo's public catalogue, streaming the public MP3s
// directly. Reuses the API shape proven by tools/jamendo/pull.mjs.
//
// Capability shape: a real LIBRARY (search / genre / similar / recently-added /
// by-artist) but with no personal surfaces (no starred, no playlists) and no
// finite library to walk (the catalogue is effectively unbounded — `libraryWalk`
// is false, so the embedding tagger skips it and Jamendo leans on its own
// tag/similar surfaces + Phase-1.5 Last.fm enrichment). Lyrics come from the
// shared LRCLIB enricher, not Jamendo.

import type { MusicSource, Song } from '../source-kit.js';
import { emptyDiscovery, namespaceId, parseId, buildAnnotateUri, sourceConfig } from '../source-kit.js';

// ---------------------------------------------------------------------------
// HTML-entity decode — Jamendo returns names with entities ("Beyonc&eacute;",
// "AC&amp;DC"); decode once so they land clean in paths, metadata, and the DJ's
// mouth. Same table as tools/jamendo/pull.mjs (HTML4/Latin-1 named refs +
// decimal/hex numeric refs).
const NAMED_ENTITIES: Record<string, number> = {nbsp:160,iexcl:161,cent:162,pound:163,curren:164,yen:165,brvbar:166,sect:167,uml:168,copy:169,ordf:170,laquo:171,not:172,shy:173,reg:174,macr:175,deg:176,plusmn:177,sup2:178,sup3:179,acute:180,micro:181,para:182,middot:183,cedil:184,sup1:185,ordm:186,raquo:187,frac14:188,frac12:189,frac34:190,iquest:191,Agrave:192,Aacute:193,Acirc:194,Atilde:195,Auml:196,Aring:197,AElig:198,Ccedil:199,Egrave:200,Eacute:201,Ecirc:202,Euml:203,Igrave:204,Iacute:205,Icirc:206,Iuml:207,ETH:208,Ntilde:209,Ograve:210,Oacute:211,Ocirc:212,Otilde:213,Ouml:214,times:215,Oslash:216,Ugrave:217,Uacute:218,Ucirc:219,Uuml:220,Yacute:221,THORN:222,szlig:223,agrave:224,aacute:225,acirc:226,atilde:227,auml:228,aring:229,aelig:230,ccedil:231,egrave:232,eacute:233,ecirc:234,euml:235,igrave:236,iacute:237,icirc:238,iuml:239,eth:240,ntilde:241,ograve:242,oacute:243,ocirc:244,otilde:245,ouml:246,divide:247,oslash:248,ugrave:249,uacute:250,ucirc:251,uuml:252,yacute:253,thorn:254,yuml:255,amp:38,lt:60,gt:62,quot:34,apos:39,OElig:338,oelig:339,Scaron:352,scaron:353,Yuml:376,circ:710,tilde:732,ndash:8211,mdash:8212,lsquo:8216,rsquo:8217,sbquo:8218,ldquo:8220,rdquo:8221,bdquo:8222,dagger:8224,Dagger:8225,bull:8226,hellip:8230,permil:8240,lsaquo:8249,rsaquo:8250,euro:8364,trade:8482};
function decode(s: any): string {
  return String(s ?? '').replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    const code = NAMED_ENTITIES[e]; // named refs are case-sensitive (Aacute ≠ aacute)
    return code ? String.fromCodePoint(code) : m;
  });
}

// Cover-art + stream URLs keyed by RAW track id. Jamendo cover/audio URLs aren't
// derivable from an id alone (no deterministic pattern), so we cache them as
// tracks flow through the provider. /cover/:id reads coverCache; getAnnotatedUri
// reads the URL off the song (persisted in queue.json) or this cache as a
// fallback. Bounded LRU-ish: oldest-inserted evicted past the cap.
const COVER_CACHE_MAX = 4000;
const coverCache = new Map<string, string>();
const streamCache = new Map<string, string>();
function remember(map: Map<string, string>, key: string, val: string) {
  if (!val) return;
  if (map.has(key)) map.delete(key);
  map.set(key, val);
  if (map.size > COVER_CACHE_MAX) map.delete(map.keys().next().value!);
}

// One GET against the Jamendo v3.0 API. Returns the `results` array, or [] on any
// failure (no client_id, network, non-success status) so every method degrades
// the same graceful way the picker/request cascade already expects.
async function jget(path: string, params: Record<string, any>): Promise<any[]> {
  const { clientId, apiBase } = sourceConfig().jamendo;
  if (!clientId) return [];
  const url = new URL(`${apiBase}/${path}`);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('format', 'json');
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return [];
    const data: any = await res.json();
    if (data?.headers?.status && data.headers.status !== 'success') return [];
    return Array.isArray(data?.results) ? data.results : [];
  } catch {
    return [];
  }
}

function yearOf(releasedate: any): number | undefined {
  const y = parseInt(String(releasedate || '').slice(0, 4), 10);
  return Number.isFinite(y) && y > 0 ? y : undefined;
}

// Jamendo tags live under musinfo.tags.{genres,vartags,instruments}; flatten the
// descriptive ones (genres + vartags) into a single comma genre string.
function tagList(t: any): string[] {
  const tags = t?.musinfo?.tags || {};
  const out = [
    ...(Array.isArray(tags.genres) ? tags.genres : []),
    ...(Array.isArray(tags.vartags) ? tags.vartags : []),
  ];
  return out.map((x: any) => String(x)).filter(Boolean);
}

function toSong(t: any): Song {
  const raw = String(t.id);
  const cover = t.album_image || t.image || '';
  remember(coverCache, raw, cover);
  remember(streamCache, raw, t.audio || '');
  const tags = tagList(t);
  return {
    id: namespaceId('jamendo', raw),
    title: decode(t.name),
    artist: decode(t.artist_name),
    album: decode(t.album_name),
    albumId: t.album_id ? namespaceId('jamendo', String(t.album_id)) : undefined,
    year: yearOf(t.releasedate),
    genre: tags.length ? tags[0] : undefined,
    duration: t.duration ? Number(t.duration) : undefined,
    coverArt: cover || undefined,
    _streamUrl: t.audio || '',
    _jamendoTags: tags,
  };
}

const POP = 'popularity_month';

export const jamendoSource: MusicSource = {
  ...emptyDiscovery,
  key: 'jamendo',
  capabilities: {
    pool: true,
    similar: true,        // tag/artist-based
    genre: true,          // fuzzytags
    playlists: false,
    starred: false,
    recentlyAdded: true,  // albums by releasedate
    frequent: true,       // albums by popularity (proxy for "frequent")
    artistGraph: true,    // top-songs / recent-by-artist
    sonicSimilarity: false,
    lyrics: false,        // LRCLIB enricher covers it
    libraryWalk: false,   // unbounded remote catalogue — not taggable
  },

  // Jamendo has no station archive of its own.
  isStationArchive: () => false,

  async search(query, { songCount = 20 } = {}) {
    return (await jget('tracks/', { search: query, limit: songCount, include: 'musicinfo' })).map(toSong);
  },

  async getRandomSongs({ size = 20, genre } = {}) {
    if (genre) {
      return (await jget('tracks/', { fuzzytags: genre, limit: size, order: POP })).map(toSong);
    }
    // No true random endpoint — sample a random page of popular tracks.
    const offset = Math.floor(Math.random() * 2000);
    return (await jget('tracks/', { limit: size, offset, order: POP })).map(toSong);
  },

  async getSongsByGenre(genre, { count = 20 } = {}) {
    return (await jget('tracks/', { fuzzytags: genre, limit: count, order: POP })).map(toSong);
  },

  // Jamendo matches tags fuzzily, so a free-text genre maps to itself.
  async resolveGenreName(name) {
    const v = String(name || '').toLowerCase().trim();
    return v || null;
  },

  async getSimilarSongs(id, { count = 20 } = {}) {
    const raw = parseId(id).raw;
    const [track] = await jget('tracks/', { id: raw, include: 'musicinfo' });
    const tags = track ? tagList(track) : [];
    let rows: any[] = [];
    if (tags.length) {
      rows = await jget('tracks/', { fuzzytags: tags.slice(0, 3).join(' '), limit: count + 6, order: POP });
    } else if (track?.artist_id) {
      rows = await jget('tracks/', { artist_id: track.artist_id, limit: count + 6, order: 'popularity_total' });
    }
    return rows.map(toSong).filter((s) => parseId(s.id).raw !== raw).slice(0, count);
  },

  async getRecentlyAddedAlbums({ size = 20 } = {}) {
    const rows = await jget('albums/', { order: 'releasedate_desc', limit: size });
    return rows.map((a: any) => ({ id: String(a.id), name: decode(a.name), artist: decode(a.artist_name), year: yearOf(a.releasedate) }));
  },

  async getFrequentAlbums({ size = 20 } = {}) {
    const rows = await jget('albums/', { order: 'popularity_total', limit: size });
    return rows.map((a: any) => ({ id: String(a.id), name: decode(a.name), artist: decode(a.artist_name), year: yearOf(a.releasedate) }));
  },

  async getAlbum(id) {
    return (await jget('tracks/', { album_id: parseId(id).raw, limit: 50, include: 'musicinfo' })).map(toSong);
  },

  async getSong(id) {
    const [t] = await jget('tracks/', { id: parseId(id).raw, include: 'musicinfo' });
    return t ? toSong(t) : null;
  },

  async searchArtists(query, { artistCount = 5 } = {}) {
    return (await jget('artists/', { namesearch: query, limit: artistCount }))
      .map((a: any) => ({ id: String(a.id), name: decode(a.name) }));
  },

  async resolveArtist(name) {
    const rows = await jget('artists/', { namesearch: name, limit: 5 });
    if (!rows.length) return null;
    const norm = (s: any) => String(s || '').toLowerCase().trim();
    const exact = rows.find((a: any) => norm(a.name) === norm(name));
    const hit = exact || rows[0];
    return { id: String(hit.id), name: decode(hit.name) };
  },

  async getArtist(id) {
    const raw = parseId(id).raw;
    const [artist] = await jget('artists/', { id: raw });
    if (!artist) return null;
    const albums = await jget('albums/', { artist_id: raw, order: 'releasedate_desc', limit: 20 });
    return {
      id: String(artist.id),
      name: decode(artist.name),
      album: albums.map((a: any) => ({ id: String(a.id), name: decode(a.name), year: yearOf(a.releasedate) })),
    };
  },

  async getTopSongs(artistName, { count = 10 } = {}) {
    const artist = await jamendoSource.resolveArtist(artistName);
    if (!artist?.id) return [];
    return (await jget('tracks/', { artist_id: artist.id, order: 'popularity_total', limit: count, include: 'musicinfo' })).map(toSong);
  },

  async getRecentSongsByArtist(artistName, { count = 20 } = {}) {
    const artist = await jamendoSource.resolveArtist(artistName);
    if (!artist?.id) return [];
    return (await jget('tracks/', { artist_id: artist.id, order: 'releasedate_desc', limit: count, include: 'musicinfo' })).map(toSong);
  },

  // Cover art was cached as the track flowed through; return the stored URL (the
  // proxy in routes/public.ts fetches + caches the bytes). Miss → null → 404 →
  // UI placeholder.
  getCoverArtUrl(id) {
    return coverCache.get(parseId(id).raw) || null;
  },

  getRawStreamUrl(id) {
    return streamCache.get(parseId(id).raw) || '';
  },

  // Stream the public MP3 through the proven subhttp: (curl) protocol — reliable
  // across redirects, same path Navidrome streams use.
  getAnnotatedUri(song) {
    const raw = parseId(song.id).raw;
    const audio = song._streamUrl || streamCache.get(raw) || '';
    if (!audio) return '';
    return buildAnnotateUri(song, `subhttp:${audio}`);
  },
};

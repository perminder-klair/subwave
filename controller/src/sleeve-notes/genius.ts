import {connectionArtistVariantKey} from './library-connections.js';
import type { ProviderContributor, ProviderIdentity, ProviderRelationship, SleeveEntityInput, SleeveProvider, SleeveProviderResult } from './provider.js';
import { recordProviderCall } from './telemetry.js';

const RELATIONSHIP_TYPES = new Set(['samples', 'sampled_in', 'cover_of', 'covered_by']);
const CREDIT_ROLES = new Set(['Producer', 'Writer']);

export class GeniusRequestError extends Error {
  constructor(readonly status: number, message = `Genius request failed (${status})`) {
    super(message);
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type Pause = (ms: number, signal: AbortSignal) => Promise<void>;

export interface GeniusAlbumBiography {
  providerId: string;
  title: string;
  artist: string;
  url: string;
  text: string;
}

export type GeniusAlbumBiographyLookup =
  | { biography: GeniusAlbumBiography; reason: null }
  | { biography: null; reason: string };

const pause: Pause = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normal(value: string | undefined): string {
  return (value ?? '').normalize('NFKD').replace(/(\p{Script=Latin})\p{M}+/gu, '$1')
    .normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim();
}

function normalArtist(value: string | undefined): string {
  return connectionArtistVariantKey(normal(value));
}

function songIdentity(song: unknown): ProviderIdentity | null {
  if (!song || typeof song !== 'object') return null;
  const s = song as Record<string, unknown>;
  const id = s.id;
  const title = text(s.title);
  const url = text(s.url);
  const artist = s.primary_artist as Record<string, unknown> | undefined;
  const artistName = text(artist?.name);
  if ((typeof id !== 'number' && typeof id !== 'string') || !title || !url) return null;
  return { providerId: String(id), canonicalUrl: url, title, artist: artistName };
}

function artistNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((artist) => text((artist as Record<string, unknown>)?.name))
    .filter((name): name is string => !!name);
}

function artistContributors(value: unknown): ProviderContributor[] {
  if (!Array.isArray(value)) return [];
  return value.map((artist): ProviderContributor | null => {
    const row = artist as Record<string, unknown>;
    const id = row?.id;
    const name = text(row?.name);
    if ((typeof id !== 'number' && typeof id !== 'string') || !name) return null;
    const url = text(row?.url);
    return { providerId: String(id), name, ...(url ? { canonicalUrl: url } : {}) };
  }).filter((contributor): contributor is ProviderContributor => contributor !== null);
}

function creditRole(label: string | undefined): 'Producer' | 'Writer' | null {
  const value = normal(label);
  if (value === 'producer' || value === 'produced by') return 'Producer';
  if (value === 'writer' || value === 'written by') return 'Writer';
  return null;
}

export function selectGeniusSearchHit(payload: unknown, entity: SleeveEntityInput): string | null {
  const root = payload as { response?: { hits?: unknown[] } };
  const hits = root?.response?.hits;
  if (!Array.isArray(hits)) return null;
  const wantedTitle = normal(entity.title);
  const wantedArtist = normalArtist(entity.artist);
  if (!wantedTitle || (entity.artist && !wantedArtist)) return null;
  const exact=new Set<string>(),variants=new Set<string>();
  for (const hit of hits) {
    const candidate = songIdentity((hit as { result?: unknown })?.result);
    if (!candidate || normal(candidate.title) !== wantedTitle) continue;
    if (wantedArtist && normalArtist(candidate.artist) !== wantedArtist) continue;
    variants.add(candidate.providerId);
    if(normal(candidate.artist)===normal(entity.artist))exact.add(candidate.providerId);
  }
  if(exact.size)return exact.size===1?[...exact][0]:null;
  return variants.size===1?[...variants][0]:null;
}

/** Projects only the Phase-0 allowlist. Raw Genius payloads are never retained. */
export function projectGeniusSong(payload: unknown): SleeveProviderResult | null {
  const song = (payload as { response?: { song?: unknown } })?.response?.song;
  const identity = songIdentity(song);
  if (!identity || !song || typeof song !== 'object') return null;
  const value = song as Record<string, unknown>;
  const credits: SleeveProviderResult['credits'] = [];
  const addCredit = (role: 'Producer' | 'Writer', artists: unknown) => {
    const names = artistNames(artists);
    if (!names.length || credits.some((credit) => credit.role === role && credit.names.join('\u0000') === names.join('\u0000'))) return;
    const contributors = artistContributors(artists);
    credits.push({ role, names, ...(contributors.length ? { contributors } : {}) });
  };
  // These dedicated song-detail fields are the normal Genius credit source.
  // Custom performances supplement them, not replace them.
  addCredit('Producer', value.producer_artists);
  addCredit('Writer', value.writer_artists);
  for (const item of Array.isArray(value.custom_performances) ? value.custom_performances : []) {
    const row = item as Record<string, unknown>;
    const role = creditRole(text(row.label));
    if (role && CREDIT_ROLES.has(role)) addCredit(role, row.artists);
  }
  const relationships: ProviderRelationship[] = [];
  for (const item of Array.isArray(value.song_relationships) ? value.song_relationships : []) {
    const row = item as Record<string, unknown>;
    const type = text(row.relationship_type);
    if (!type || !RELATIONSHIP_TYPES.has(type) || !Array.isArray(row.songs)) continue;
    for (const linked of row.songs) {
      const target = songIdentity(linked);
      if (target) relationships.push({ type: type as ProviderRelationship['type'], target });
    }
  }
  return { identity, credits, relationships, attribution: 'Metadata and relationships from Genius', retrievedAt: new Date().toISOString() };
}

export class GeniusProvider implements SleeveProvider {
  readonly id = 'genius';
  constructor(private readonly token: string, private readonly fetcher: FetchLike = fetch, private readonly wait: Pause = pause) {}

  async fetch(entity: SleeveEntityInput, signal: AbortSignal): Promise<SleeveProviderResult | null> {
    const headers = { Authorization: `Bearer ${this.token}` };
    const query = new URLSearchParams({ q: [entity.title, entity.artist].filter(Boolean).join(' ') });
    const search = await this.request(`https://api.genius.com/search?${query}`, headers, signal, 'search', entity);
    const id = selectGeniusSearchHit(await search.json(), entity);
    if (!id) return null;
    // Production calls share the worker's paced ledger. Keep a short pause
    // between search/detail even when this adapter is used independently.
    await this.wait(1_000, signal);
    return this.fetchSong(id, entity, signal);
  }

  /** Known identities need only one budgeted request; never search again implicitly. */
  async fetchSong(id: string, entity: SleeveEntityInput, signal: AbortSignal): Promise<SleeveProviderResult | null> {
    if (!/^\d+$/.test(id)) throw new Error('Invalid Genius song ID');
    const response = await this.request(`https://api.genius.com/songs/${encodeURIComponent(id)}`,
      { Authorization: `Bearer ${this.token}` }, signal, 'song', entity);
    const result = projectGeniusSong(await response.json());
    if (!normal(entity.title) || (entity.artist && !normalArtist(entity.artist))
      || !result || result.identity.providerId !== id
      || normal(result.identity.title) !== normal(entity.title)
      || (entity.artist && normalArtist(result.identity.artist) !== normalArtist(entity.artist))) return null;
    return result;
  }

  /** Resolve an encountered recording's album, then read only its plain bio. */
  async fetchAlbumBiography(songIds: readonly string[], expected: { title: string; artist: string }, signal: AbortSignal): Promise<GeniusAlbumBiographyLookup> {
    const headers = { Authorization: `Bearer ${this.token}` };
    const entity: SleeveEntityInput = { kind: 'release', title: expected.title, artist: expected.artist };
    const triedSongIds = [...new Set(songIds)].slice(0, 3);
    let albumId: string | number | null = null;
    const mismatchedTitles: string[] = [];
    let missingAlbumId = false;
    for (const songId of triedSongIds) {
      const songResponse = await this.request(`https://api.genius.com/songs/${encodeURIComponent(songId)}`,
        headers, signal, 'song', entity);
      const song = (await songResponse.json() as { response?: { song?: Record<string, unknown> } })?.response?.song;
      const album = song?.album as Record<string, unknown> | null | undefined;
      const candidateAlbumId = album?.id;
      if (typeof candidateAlbumId !== 'number' && typeof candidateAlbumId !== 'string') {
        missingAlbumId = true;
        continue;
      }
      const candidateTitle = text(album?.name) ?? text(album?.title);
      if (!normal(expected.title) || normal(candidateTitle) !== normal(expected.title)) {
        mismatchedTitles.push(candidateTitle ?? 'untitled');
        continue;
      }
      albumId = candidateAlbumId;
      break;
    }
    if (albumId === null) {
      const distinctTitles = [...new Set(mismatchedTitles)];
      if (distinctTitles.length) {
        const tried = triedSongIds.length;
        if (tried === 1) return { biography: null, reason: `song album title differs (${distinctTitles[0]})` };
        return { biography: null, reason: `none of ${tried} Genius track listings matched; album titles returned: ${distinctTitles.join(', ')}` };
      }
      return { biography: null, reason: missingAlbumId
        ? 'none of the matched Genius tracks has an album ID' : 'no matched Genius track listings are available' };
    }
    await this.wait(1_000, signal);
    const albumResponse = await this.request(`https://api.genius.com/albums/${encodeURIComponent(String(albumId))}?text_format=plain`,
      headers, signal, 'album', entity);
    const payload = await albumResponse.json();
    let biography = projectGeniusAlbumBiography(payload, expected);
    let reason = biography ? null : geniusAlbumBiographyRejection(payload, expected);
    if (!biography && reason && (reason.includes('description') || reason.includes('preview'))) {
      const albumDetail = (payload as { response?: { album?: Record<string, unknown> } })?.response?.album;
      const referent = albumDetail?.description_annotation as Record<string, unknown> | undefined;
      const annotations = Array.isArray(referent?.annotations) ? referent.annotations : [];
      const annotationId = (annotations[0] as Record<string, unknown> | undefined)?.id;
      if (typeof annotationId === 'number' || typeof annotationId === 'string') {
        await this.wait(1_000, signal);
        const annotationResponse = await this.request(
          `https://api.genius.com/annotations/${encodeURIComponent(String(annotationId))}?text_format=plain`,
          headers, signal, 'annotation', entity);
        const annotation = (await annotationResponse.json() as { response?: { annotation?: Record<string, unknown> } })?.response?.annotation;
        const body = annotation?.body as Record<string, unknown> | undefined;
        const annotationText = text(body?.plain) ?? text(body?.markdown);
        if (albumDetail && annotationText) {
          biography = projectGeniusAlbumBiography({ response: { album: {
            ...albumDetail, description: { plain: annotationText },
          } } }, expected);
        }
        if (!biography) reason = 'description annotation did not contain usable plain text';
      } else reason = 'album API omitted both description text and an annotation ID';
    }
    return biography ? { biography, reason: null }
      : { biography: null, reason: reason ?? 'album biography unavailable' };
  }

  private async request(url: string, headers: Record<string, string>, signal: AbortSignal, endpoint: 'search' | 'song' | 'album' | 'annotation', entity: SleeveEntityInput): Promise<Response> {
    const started = Date.now();
    try {
      const response = await this.fetcher(url, { headers: { ...headers, 'User-Agent': 'Subwave (Genius metadata research)' }, signal });
      recordProviderCall({ t: new Date().toISOString(), provider: 'genius', endpoint,
        title: entity.title, artist: entity.artist ?? null, ok: response.ok, status: response.status, ms: Date.now() - started });
      if (!response.ok) throw new GeniusRequestError(response.status);
      return response;
    } catch (error) {
      if (!(error instanceof GeniusRequestError)) {
        recordProviderCall({ t: new Date().toISOString(), provider: 'genius', endpoint,
          title: entity.title, artist: entity.artist ?? null, ok: false, status: null,
          ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
      }
      throw error;
    }
  }
}

export function projectGeniusAlbumBiography(payload: unknown, expected: { title: string; artist: string }): GeniusAlbumBiography | null {
  const album = (payload as { response?: { album?: Record<string, unknown> } })?.response?.album;
  if (!album) return null;
  const id = album.id;
  const title = text(album.name) ?? text(album.title);
  const artists = Array.isArray(album.primary_artists) ? album.primary_artists : [];
  const artist = (album.artist ?? album.primary_artist ?? artists[0]) as Record<string, unknown> | undefined;
  const artistName = text(artist?.name);
  const url = text(album.url);
  const description = album.description;
  const plain = typeof description === 'string' ? description
    : text((description as Record<string, unknown> | null)?.plain);
  const biographyText = [plain, albumAnnotationText(album), text(album.description_preview)]
    .find((value) => typeof value === 'string' && value.trim().length >= 80);
  if (!normal(expected.title) || !normalArtist(expected.artist)
    || (typeof id !== 'number' && typeof id !== 'string') || !title || !artistName || !url || !biographyText
    || normal(title) !== normal(expected.title) || normalArtist(artistName) !== normalArtist(expected.artist)) return null;
  const cleaned = biographyText.replace(/\s+/g, ' ').trim();
  if (cleaned.length < 80) return null;
  const bounded = cleaned.length <= 8_000 ? cleaned : cleaned.slice(0, 8_000).replace(/\s+\S*$/u, '').trim();
  return { providerId: String(id), title, artist: artistName, url, text: bounded };
}

function albumAnnotationText(album: Record<string, unknown>): string | undefined {
  const referent = album.description_annotation as Record<string, unknown> | null | undefined;
  const annotations = Array.isArray(referent?.annotations) ? referent.annotations : [];
  const annotation = annotations[0] as Record<string, unknown> | undefined;
  const body = annotation?.body as Record<string, unknown> | undefined;
  const plain = text(body?.plain);
  if (plain) return plain;
  const markdown = text(body?.markdown);
  if (!markdown) return undefined;
  return markdown.replace(/!\[([^\]]*)\]\([^)]+\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
    .replace(/^[>#*\-]+\s*/gmu, '')
    .replace(/[*_`]/gu, '').trim();
}

function geniusAlbumBiographyRejection(payload: unknown, expected: { title: string; artist: string }): string {
  const album = (payload as { response?: { album?: Record<string, unknown> } })?.response?.album;
  if (!album) return 'album detail response was empty';
  const title = text(album.name) ?? text(album.title);
  const artists = Array.isArray(album.primary_artists) ? album.primary_artists : [];
  const artist = (album.artist ?? album.primary_artist ?? artists[0]) as Record<string, unknown> | undefined;
  const artistName = text(artist?.name);
  if (normal(title) !== normal(expected.title)) return `album title differs (${title ?? 'untitled'})`;
  if (normalArtist(artistName) !== normalArtist(expected.artist)) return `album artist differs (${artistName ?? 'unknown'})`;
  if (!text(album.url)) return 'album URL missing';
  if (!text(album.description_preview) && !text((album.description as Record<string, unknown> | null)?.plain)
    && !albumAnnotationText(album)) {
    return 'album detail has no readable description annotation or preview';
  }
  return 'album description is too short';
}

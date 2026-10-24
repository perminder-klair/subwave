import * as settings from '../settings.js';
import { queue } from '../broadcast/queue.js';
import * as library from '../music/library.js';
import * as subsonic from '../music/subsonic.js';

export interface AlexaListenerTrack {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  artworkUrl?: string | null;
  year?: number | null;
  genre?: string | null;
  genres?: string[];
  language?: string | null;
  languages?: string[];
  similarity?: number | null;
}

export interface AlexaTrackDetails extends AlexaListenerTrack {
  year: number | null;
  genre: string | null;
  language: string | null;
}

export interface AlexaCurrentShow {
  name: string | null;
  dj: string | null;
  guests: string[];
}

export interface AlexaVerifiedCandidate {
  id: string;
  title: string;
  artist: string;
  album?: string | null;
}

export type AlexaFeatureResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'no-current' }
  | { kind: 'no-match' };

export interface AlexaListenerFeatureSources {
  nowPlaying?: () => Promise<AlexaListenerTrack | null> | AlexaListenerTrack | null;
  recentTracks?: () => Promise<AlexaListenerTrack[]> | AlexaListenerTrack[];
  similarCandidates?: (track: AlexaListenerTrack) => Promise<unknown[]> | unknown[];
  artistCandidates?: (track: AlexaListenerTrack) => Promise<unknown[]> | unknown[];
  trackMetadata?: (id: string) => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
  currentShow?: () => Promise<AlexaCurrentShow> | AlexaCurrentShow;
}

const DEFAULT_RECENT_LIMIT = 5;
const MAX_CANDIDATES = 80;
// Alexa's synchronous endpoint has a much shorter response budget than a
// catalogue refresh. Local KNN results are available first; remote similarity
// providers are optional enrichment and must not hold the voice response open.
const REMOTE_SIMILARITY_TIMEOUT_MS = 2_500;

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function normalise(value: unknown): string {
  return text(value).normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ');
}

function trackKey(track: Pick<AlexaListenerTrack, 'title' | 'artist'>): string {
  return `${normalise(track.title)}|${normalise(track.artist)}`;
}

function finiteScore(value: unknown): number {
  const score = Number(value);
  return Number.isFinite(score) ? score : 0;
}

function candidateTrack(value: unknown): AlexaListenerTrack | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = text(raw.id || raw.subsonic_id);
  const title = text(raw.title);
  const artist = text(raw.artist);
  if (!id || !title || !artist) return null;
  const genres = Array.isArray(raw.genres)
    ? raw.genres.map(text).filter(Boolean)
    : [];
  const year = Number(raw.year);
  const similarity = raw.similarity ?? raw._similarity ?? raw.score;
  return {
    id,
    title,
    artist,
    album: text(raw.album) || null,
    artworkUrl: text(raw.artworkUrl) || null,
    year: Number.isInteger(year) && year > 0 ? year : null,
    genre: text(raw.genre) || genres[0] || null,
    genres,
    language: text(raw.language) || null,
    languages: Array.isArray(raw.languages) ? raw.languages.map(text).filter(Boolean) : [],
    similarity: similarity == null ? null : finiteScore(similarity),
  };
}

function mergeCandidate(existing: AlexaListenerTrack, next: AlexaListenerTrack): AlexaListenerTrack {
  return {
    ...existing,
    ...next,
    album: next.album || existing.album || null,
    artworkUrl: next.artworkUrl || existing.artworkUrl || null,
    year: next.year ?? existing.year ?? null,
    genre: next.genre || existing.genre || null,
    genres: next.genres?.length ? next.genres : existing.genres,
    language: next.language || existing.language || null,
    languages: next.languages?.length ? next.languages : existing.languages,
    similarity: Math.max(finiteScore(existing.similarity), finiteScore(next.similarity)),
  };
}

/**
 * Rank a candidate set without depending on Navidrome response order. The
 * final id comparison is deliberate: voice requests must not change their
 * answer when two similarity sources return an equal score in another order.
 */
export function rankAlexaCandidates(
  values: readonly unknown[],
  excluded: ReadonlySet<string> = new Set(),
  excludedKeys: ReadonlySet<string> = new Set(),
): AlexaListenerTrack[] {
  const byId = new Map<string, AlexaListenerTrack>();
  for (const value of values) {
    const candidate = candidateTrack(value);
    if (!candidate || excluded.has(candidate.id) || excludedKeys.has(trackKey(candidate))) continue;
    const prior = byId.get(candidate.id);
    byId.set(candidate.id, prior ? mergeCandidate(prior, candidate) : candidate);
  }
  return [...byId.values()]
    .sort((a, b) => {
      const score = finiteScore(b.similarity) - finiteScore(a.similarity);
      if (score) return score;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, MAX_CANDIDATES);
}

function recentExclusions(current: AlexaListenerTrack, recent: readonly AlexaListenerTrack[]) {
  const ids = new Set<string>([current.id]);
  const keys = new Set<string>([trackKey(current)]);
  for (const track of recent) {
    if (track.id) ids.add(track.id);
    if (track.title && track.artist) keys.add(trackKey(track));
  }
  return { ids, keys };
}

function detailsFromTrack(track: AlexaListenerTrack, metadata: Record<string, unknown> | null): AlexaTrackDetails {
  const source = metadata || {};
  const genres = Array.isArray(source.genres)
    ? source.genres.map(value => text(typeof value === 'object' && value ? (value as { name?: unknown }).name : value)).filter(Boolean)
    : track.genres || [];
  const year = Number(source.year ?? track.year);
  const languages = Array.isArray(source.languages)
    ? source.languages.map(text).filter(Boolean)
    : track.languages || [];
  return {
    ...track,
    album: text(source.album) || track.album || null,
    year: Number.isInteger(year) && year > 0 ? year : null,
    genre: text(source.genre) || genres[0] || track.genre || null,
    genres,
    language: text(source.language) || languages[0] || track.language || null,
    languages,
  };
}

function defaultNowPlaying(): Promise<AlexaListenerTrack | null> {
  return queue.getNowPlaying().then(raw => candidateTrack(raw));
}

function defaultRecentTracks(): AlexaListenerTrack[] {
  return queue.history
    .map(item => candidateTrack(item?.track))
    .filter((track): track is AlexaListenerTrack => track !== null);
}

async function defaultSimilarCandidates(track: AlexaListenerTrack): Promise<unknown[]> {
  const candidates: unknown[] = [];
  if (track.id) {
    candidates.push(...library.tracksLikeThis(track.id, MAX_CANDIDATES));
    candidates.push(...library.tracksLikeThisAudio(track.id, MAX_CANDIDATES));
    // These are independent optional sources. Run them together so a slow or
    // unsupported Navidrome similarity endpoint cannot consume Alexa's whole
    // response window after the local library candidates have been considered.
    const remote = await Promise.allSettled([
      optionalWithin(
        subsonic.getSonicSimilarTracks(track.id, { count: MAX_CANDIDATES }),
        REMOTE_SIMILARITY_TIMEOUT_MS,
      ),
      optionalWithin(
        subsonic.getSimilarSongs(track.id, { count: MAX_CANDIDATES }),
        REMOTE_SIMILARITY_TIMEOUT_MS,
      ),
    ]);
    for (const result of remote) {
      if (result.status === 'fulfilled' && result.value) candidates.push(...result.value);
    }
  }
  return candidates;
}

function optionalWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  return Promise.race([promise.catch(() => null), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function sameArtist(candidate: AlexaListenerTrack, artist: string): boolean {
  const expected = normalise(artist);
  const actual = normalise(candidate.artist);
  return actual === expected || actual.split(/\s*(?:,|&|feat\.?|featuring|with)\s*/iu).includes(expected);
}

async function defaultArtistCandidates(track: AlexaListenerTrack): Promise<unknown[]> {
  let candidates: unknown[] = [];
  try {
    candidates = library.candidateFilterTracks().filter(candidate => {
      const parsed = candidateTrack(candidate);
      return parsed ? sameArtist(parsed, track.artist) : false;
    });
  } catch {
    // The remote catalogue source below can still answer while the local
    // catalogue is loading or being refreshed.
  }
  try {
    candidates.push(...await subsonic.getTopSongs(track.artist, { count: MAX_CANDIDATES }));
  } catch {
    // A local catalogue read remains a valid source when Navidrome is busy.
  }
  return candidates;
}

async function defaultTrackMetadata(id: string): Promise<Record<string, unknown> | null> {
  try {
    return await subsonic.getSong(id) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

function defaultCurrentShow(): AlexaCurrentShow {
  const show = settings.resolveActiveShow();
  const dj = settings.getEffectivePersona();
  return {
    name: text(show?.name) || null,
    dj: text(show?.persona?.name || dj?.name) || null,
    guests: (show?.guests || []).map((guest: { name?: unknown }) => text(guest.name)).filter(Boolean),
  };
}

export class AlexaListenerFeatureService {
  private readonly sources: Required<AlexaListenerFeatureSources>;

  constructor(sources: AlexaListenerFeatureSources = {}) {
    this.sources = {
      nowPlaying: sources.nowPlaying || defaultNowPlaying,
      recentTracks: sources.recentTracks || defaultRecentTracks,
      similarCandidates: sources.similarCandidates || defaultSimilarCandidates,
      artistCandidates: sources.artistCandidates || defaultArtistCandidates,
      trackMetadata: sources.trackMetadata || defaultTrackMetadata,
      currentShow: sources.currentShow || defaultCurrentShow,
    };
  }

  async currentTrack(): Promise<AlexaListenerTrack | null> {
    return this.sources.nowPlaying();
  }

  async moreLikeThis(): Promise<AlexaFeatureResult<AlexaListenerTrack>> {
    const current = await this.currentTrack();
    if (!current) return { kind: 'no-current' };
    const recent = await this.sources.recentTracks();
    const excluded = recentExclusions(current, recent);
    const candidates = await this.sources.similarCandidates(current);
    const [selected] = rankAlexaCandidates(candidates, excluded.ids, excluded.keys);
    return selected ? { kind: 'ok', value: selected } : { kind: 'no-match' };
  }

  async anotherByArtist(): Promise<AlexaFeatureResult<AlexaListenerTrack>> {
    const current = await this.currentTrack();
    if (!current) return { kind: 'no-current' };
    const recent = await this.sources.recentTracks();
    const excluded = recentExclusions(current, recent);
    const candidates = (await this.sources.artistCandidates(current))
      .map(candidateTrack)
      .filter((candidate): candidate is AlexaListenerTrack => candidate !== null)
      .filter(candidate => sameArtist(candidate, current.artist));
    const [selected] = rankAlexaCandidates(candidates, excluded.ids, excluded.keys);
    return selected ? { kind: 'ok', value: selected } : { kind: 'no-match' };
  }

  async recentTracks(limit = DEFAULT_RECENT_LIMIT): Promise<AlexaListenerTrack[]> {
    const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : DEFAULT_RECENT_LIMIT;
    return (await this.sources.recentTracks()).slice(0, safeLimit);
  }

  async trackDetails(): Promise<AlexaFeatureResult<AlexaTrackDetails>> {
    const current = await this.currentTrack();
    if (!current) return { kind: 'no-current' };
    const metadata = current.id ? await this.sources.trackMetadata(current.id) : null;
    return { kind: 'ok', value: detailsFromTrack(current, metadata) };
  }

  async currentShow(): Promise<AlexaCurrentShow> {
    return this.sources.currentShow();
  }
}

export function createAlexaListenerFeatureService(sources: AlexaListenerFeatureSources = {}) {
  return new AlexaListenerFeatureService(sources);
}

export function verifiedCandidateFor(track: AlexaListenerTrack): AlexaVerifiedCandidate {
  return { id: track.id, title: track.title, artist: track.artist, album: track.album };
}

export function verifiedRequestText(track: AlexaListenerTrack): string {
  return `play "${track.title}" by "${track.artist}"`;
}

import * as settings from '../settings.js';
import * as subsonic from './subsonic.js';
import { rankAliasCandidates, type RequestSong } from './request-match.js';
import { searchReady, searchWeb } from '../skills/web-search.js';

export interface RequestAliasResolution {
  track: RequestSong;
  provider: string;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('request resolution aborted');
}

/**
 * Verify an alternate title against web evidence and the requested artist's
 * real Navidrome catalogue. The web may nominate a relationship, but the
 * returned id always comes from the local catalogue.
 */
export async function resolveNamedAlias(
  title: string,
  artistName: string,
  signal?: AbortSignal,
): Promise<RequestAliasResolution | null> {
  if (!searchReady()) return null;
  const provider = settings.get().search?.provider || 'duckduckgo';
  const web = await searchWeb(`"${title}" "${artistName}" alternate title song`, { signal });
  const evidence = [web.answer, ...(web.results || []).map(result => `${result.title}: ${result.content}`)]
    .filter(Boolean).join('\n').slice(0, 8000);
  if (!evidence) return null;
  const artist = await subsonic.resolveArtist(artistName, { signal });
  if (!artist?.id) return null;
  const full = await subsonic.getArtist(artist.id, { signal });
  const albums = (full?.album || []).slice(0, 20);
  const candidates: RequestSong[] = [];
  for (const album of albums) {
    throwIfAborted(signal);
    candidates.push(...await subsonic.getAlbum(album.id, { signal }));
    if (candidates.length >= 300) break;
  }
  const track = rankAliasCandidates(title, artistName, candidates, evidence);
  return track ? { track, provider } : null;
}

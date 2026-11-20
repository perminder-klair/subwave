import * as subsonic from '../music/subsonic.js';
import {
  modelFreeRequest,
  requestArtistMatches,
  requestTitleMatches,
  type RequestSong,
} from '../music/request-match.js';

export interface AlexaRequestCandidate {
  id: string;
  title: string;
  artist: string;
  album?: string | null;
  artworkUrl?: string | null;
}
function candidateFromSong(song: RequestSong): AlexaRequestCandidate | null {
  const id = String(song.id || '').trim();
  const title = String(song.title || '').trim();
  const artist = String(song.artist || '').trim();
  if (!id || !title || !artist) return null;
  return {
    id,
    title,
    artist,
    album: String(song.album || '').trim() || null,
  };
}

/**
 * Return only a small, deterministic set of catalogue candidates for voice
 * confirmation. This is deliberately a preview, not a second request path:
 * the final yes response still enters submitListenerRequest and all of its
 * guards, limits and matching policy.
 */
export async function previewAlexaRequest(text: string): Promise<AlexaRequestCandidate[]> {
  const match = modelFreeRequest(text);
  if (match.kind !== 'track' || !match.title?.trim() || match.mood || match.unverifiedConditions?.length) {
    return [];
  }

  const query = [match.title, match.artist].filter(Boolean).join(' ').trim();
  if (!query) return [];
  const page = await subsonic.searchPage(query, {
    songCount: 10,
    songOffset: 0,
    includeBlocked: false,
  });
  const candidates: AlexaRequestCandidate[] = [];
  const seen = new Set<string>();
  for (const song of page.songs) {
    const candidate = candidateFromSong(song);
    if (!candidate || seen.has(candidate.id)) continue;
    if (!requestTitleMatches(match.title, candidate.title)) continue;
    if (match.artist && !requestArtistMatches(match.artist, { id: candidate.id, artist: candidate.artist })) continue;
    seen.add(candidate.id);
    candidates.push(candidate);
  }
  return candidates.slice(0, 3);
}

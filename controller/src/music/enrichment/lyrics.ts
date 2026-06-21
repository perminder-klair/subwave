// Provider-independent lyrics via LRCLIB (https://lrclib.net) — free, no key.
//
// The embedding tagger includes a lyric excerpt in the embed text when available.
// Navidrome can serve lyrics (getLyricsBySongId), but no other source can, so the
// tagger prefers the provider's lyrics when the capability is present and falls
// back here for everything else. Keyed by artist + title (no provider id needed),
// so it works for Jamendo / Jellyfin / local too.

const LRCLIB_API = 'https://lrclib.net/api';

// Strip LRC timestamp tags ("[00:12.34] line") so synced lyrics reduce to plain
// text for the embedding (the embedder doesn't care about timing).
function stripSynced(s: string): string {
  return s
    .split('\n')
    .map((line) => line.replace(/^\s*\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]\s*/, '').trim())
    .filter(Boolean)
    .join('\n');
}

function plainFrom(rec: any): string {
  if (!rec) return '';
  if (typeof rec.plainLyrics === 'string' && rec.plainLyrics.trim()) return rec.plainLyrics.trim();
  if (typeof rec.syncedLyrics === 'string' && rec.syncedLyrics.trim()) return stripSynced(rec.syncedLyrics);
  return '';
}

async function get(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'sub-wave (https://github.com/perminder-klair/subwave)' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Plain-text lyrics for a track, or '' when none are found. Tries the exact
// /api/get match first (artist + title, plus album/duration when known for a
// tighter match), then falls back to /api/search and takes the best hit.
export async function getLyrics(
  artist: string,
  title: string,
  { album, durationSec }: { album?: string; durationSec?: number } = {},
): Promise<string> {
  if (!artist || !title) return '';
  const q = (k: string, v: any) => (v ? `${k}=${encodeURIComponent(String(v))}` : '');
  const getParams = [
    q('artist_name', artist),
    q('track_name', title),
    q('album_name', album),
    durationSec ? `duration=${Math.round(durationSec)}` : '',
  ].filter(Boolean).join('&');

  const exact = await get(`${LRCLIB_API}/get?${getParams}`);
  const fromExact = plainFrom(exact);
  if (fromExact) return fromExact;

  const search = await get(`${LRCLIB_API}/search?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`);
  if (Array.isArray(search)) {
    for (const rec of search) {
      const plain = plainFrom(rec);
      if (plain) return plain;
    }
  }
  return '';
}

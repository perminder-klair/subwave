'use client';

// Runtime station origin for the player tree — the web counterpart of the
// native app's StationContext → createApi(baseUrl). Every player hook and
// component that talks to a controller or an Icecast mount reads its base
// URLs from this context instead of module-level env constants, so the same
// PlayerApp tree can point at ANY SUB/WAVE station (the landing showcase uses
// this to tab between directory stations). The context default preserves
// today's behaviour exactly: same-origin `/api` + `/stream.mp3` in the prod
// image, NEXT_PUBLIC_* overrides in dev — a PlayerApp rendered without a
// provider is byte-for-byte the old player.
import { createContext, useContext } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api';

// `NEXT_PUBLIC_STREAM_URL` is the build-time host override (dev points the
// player at `http://localhost:7702/stream.mp3` because Icecast isn't on the
// web origin there). It pins the *host* and we swap the path between
// `/stream.mp3` and `/stream.opus` on the same host. Operators who pointed it
// at a non-standard URL that doesn't end in `/stream.mp3` still get it
// verbatim (opus is null → codec detection off).
const STREAM_URL_OVERRIDE = process.env.NEXT_PUBLIC_STREAM_URL || '';
const MP3_PATH = '/stream.mp3';
const OPUS_PATH = '/stream.opus';

export interface StationStreams {
  mp3: string;
  /** null disables the Opus canPlayType upgrade in usePlayer. */
  opus: string | null;
}

export interface StationOrigin {
  /** Controller API base — `/api`, or `https://radio.example.com/api`. */
  apiUrl: string;
  streams: StationStreams;
}

function defaultStreams(): StationStreams {
  if (!STREAM_URL_OVERRIDE) return { mp3: MP3_PATH, opus: OPUS_PATH };
  const idx = STREAM_URL_OVERRIDE.lastIndexOf(MP3_PATH);
  if (idx === -1) return { mp3: STREAM_URL_OVERRIDE, opus: null };
  const before = STREAM_URL_OVERRIDE.slice(0, idx);
  const after = STREAM_URL_OVERRIDE.slice(idx + MP3_PATH.length);
  return { mp3: STREAM_URL_OVERRIDE, opus: `${before}${OPUS_PATH}${after}` };
}

export const DEFAULT_STATION_ORIGIN: StationOrigin = {
  apiUrl: API_URL,
  streams: defaultStreams(),
};

// Build an origin from a station's public site URL (the `url` field in the
// directory JSON). Every SUB/WAVE deployment serves the same route table on
// one hostname — `/api/*` → controller, `/stream.mp3` → Icecast (Caddy in the
// default compose; BYO proxies replicate it) — so the site origin is enough.
// Cross-origin works end to end: the controller's CORS is wide open and
// Icecast sends `Access-Control-Allow-Origin: *`, which the player's
// crossOrigin="anonymous" <audio> (needed for the Waveform's Web Audio tap)
// and the cover-colour canvas both require.
export function originForStation(siteUrl: string): StationOrigin {
  const base = siteUrl.replace(/\/+$/, '');
  return {
    apiUrl: `${base}/api`,
    streams: { mp3: `${base}${MP3_PATH}`, opus: `${base}${OPUS_PATH}` },
  };
}

// Origin for one of this install's sub-station channels. Two shapes of
// API_URL exist: the edge-routed default ('/api', or a full origin ending in
// /api) where the channel API is /ch/<id>/api on the same host (Caddy
// rewrites it to the controller's /channels/:id router), and the
// direct-controller dev override (http://localhost:7701, no /api suffix)
// where the router is reached at /channels/<id> directly. Streams: channels
// serve MP3 only, so the Opus canPlayType upgrade is disabled.
export function originForChannel(id: string): StationOrigin {
  const slug = encodeURIComponent(id);
  const apiUrl = API_URL.endsWith('/api')
    ? `${API_URL.slice(0, -'/api'.length)}/ch/${slug}/api`
    : `${API_URL}/channels/${slug}`;
  const chMp3 = `/ch/${slug}${MP3_PATH}`;
  const mp3 = STREAM_URL_OVERRIDE
    ? STREAM_URL_OVERRIDE.replace(MP3_PATH, chMp3)
    : chMp3;
  return { apiUrl, streams: { mp3, opus: null } };
}

const StationOriginContext = createContext<StationOrigin>(DEFAULT_STATION_ORIGIN);

export const StationOriginProvider = StationOriginContext.Provider;

export function useStationOrigin(): StationOrigin {
  return useContext(StationOriginContext);
}

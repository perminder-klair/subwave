'use client';

// Runtime station origin for the player tree. Everything talking to a controller
// or Icecast mount reads its base URLs from this context rather than module-level
// env constants, so one PlayerApp tree can point at any SUB/WAVE station. Default
// is same-origin `/api` + `/stream.mp3`; NEXT_PUBLIC_* overrides in dev.
import { createContext, useContext } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api';

// `NEXT_PUBLIC_STREAM_URL` is the build-time host override (dev needs it
// because Icecast isn't on the web origin). It pins the HOST; the path swaps
// between `/stream.mp3` and `/stream.opus`. A non-standard URL that doesn't end
// in `/stream.mp3` is used verbatim, with opus null so codec detection is off.
const STREAM_URL_OVERRIDE = process.env.NEXT_PUBLIC_STREAM_URL || '';
const MP3_PATH = '/stream.mp3';
const OPUS_PATH = '/stream.opus';

export interface StationStreams {
  mp3: string;
  /** null disables the Opus canPlayType upgrade in usePlayer. */
  opus: string | null;
}

export interface StationOrigin {
  /** e.g. `/api`, or `https://radio.example.com/api`. */
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

// Every deployment serves the same route table on one hostname (`/api/*` →
// controller, `/stream.mp3` → Icecast), so the site origin is enough.
// Cross-origin works: both send permissive CORS, which the player's
// crossOrigin="anonymous" <audio> and the cover-colour canvas require.
export function originForStation(siteUrl: string): StationOrigin {
  const base = siteUrl.replace(/\/+$/, '');
  return {
    apiUrl: `${base}/api`,
    streams: { mp3: `${base}${MP3_PATH}`, opus: `${base}${OPUS_PATH}` },
  };
}

const StationOriginContext = createContext<StationOrigin>(DEFAULT_STATION_ORIGIN);

export const StationOriginProvider = StationOriginContext.Provider;

export function useStationOrigin(): StationOrigin {
  return useContext(StationOriginContext);
}

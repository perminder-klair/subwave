// Shared Last.fm constants + credential resolution for the read-only tag client
// (music/lastfm.ts) and the scrobble writer (broadcast/scrobble.ts), so the
// endpoint and credential precedence can't drift. Env wins, then
// settings.scrobble.lastfm.<field>, then ''. The `enabled` gate and which
// fields each flow needs stay with the callers.

import * as settings from '../settings.js';

// Read methods hit `?method=…`; write / auth calls POST here.
export const LASTFM_API = 'https://ws.audioscrobbler.com/2.0/';

interface LastfmSettings {
  apiKey?: string;
  apiSecret?: string;
  sessionKey?: string;
}

// settings.get() is loosely typed; narrow the slice so the resolvers stay `any`-free.
function lastfmSettings(): LastfmSettings {
  return (settings.get()?.scrobble?.lastfm ?? {}) as LastfmSettings;
}

export function resolveLastfmApiKey(): string {
  return process.env.LASTFM_API_KEY || lastfmSettings().apiKey || '';
}

export function resolveLastfmApiSecret(): string {
  return process.env.LASTFM_API_SECRET || lastfmSettings().apiSecret || '';
}

export function resolveLastfmSessionKey(): string {
  return process.env.LASTFM_SESSION_KEY || lastfmSettings().sessionKey || '';
}

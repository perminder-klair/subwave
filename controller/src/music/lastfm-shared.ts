// Shared Last.fm constants + credential resolution, imported by both the
// read-only tag client (music/lastfm.ts) and the scrobble writer
// (broadcast/scrobble.ts) so the REST endpoint and the env-wins credential
// precedence can't drift between them. Each credential is env-var-first, then
// the persisted settings.scrobble.lastfm.<field>, then '' — env always wins.
//
// The `enabled` gate and how the fields are assembled into creds objects stay
// with each caller: scrobbling needs all three (+ enabled), the web-auth flow
// needs key+secret with no gate, and tag reads need only the api key.

import * as settings from '../settings.js';

// Last.fm REST base. Read methods hit `?method=…`; write / auth calls POST here.
export const LASTFM_API = 'https://ws.audioscrobbler.com/2.0/';

interface LastfmSettings {
  apiKey?: string;
  apiSecret?: string;
  sessionKey?: string;
}

// settings.get() is loosely typed (migration-window `any`); narrow the slice we
// read so the resolvers below stay `any`-free.
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

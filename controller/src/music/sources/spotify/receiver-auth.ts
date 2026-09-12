// Receiver sign-in — the SECOND Spotify login the station needs, and why.
//
// The Web API app (client.ts) logs the CONTROLLER in: catalog, playlists,
// Connect commands. librespot, the receiver in the broadcast container, cannot
// use that token: its Connect session is compiled against Spotify's own desktop
// client id (KEYMASTER_CLIENT_ID in librespot-core config.rs), and an access
// token minted for a different client authenticates but is refused at the
// Connect handshake — `could not initialize spirc: Login request was denied:
// INVALID_CREDENTIALS`, measured on 0.8.0 with a Developer-app token.
//
// librespot's own `--enable-oauth` mints a token the same way this file does:
// authorization code + PKCE (no secret — a public client) for that desktop
// client id, redirect `http://127.0.0.1:5588/login`. That redirect is Spotify's
// registration, not ours, so the browser lands on 127.0.0.1:5588 — either the
// controller is published there (docker-compose.spotify.yml) and completes the
// exchange itself, or the operator pastes the landing URL into the admin (the
// wiki's "headless OAuth"). Either way the access token goes to
// state/spotify/token for docker/spotify/librespot-run.sh, and the refresh
// token to secrets.env so a wiped credential cache can be re-signed without
// the operator (refreshReceiverToken).
//
// Pure pieces (PKCE, URL, code parsing, exchange body) are exported and pinned
// by scripts/spotify-receiver-auth.test.ts; fetch is injected.

import { createHash, randomBytes } from 'node:crypto';
import { SPOTIFY_ACCOUNTS, SpotifyAuthError, redactSpotify } from './client.js';

// librespot-core config.rs KEYMASTER_CLIENT_ID (the Spotify desktop app).
export const LIBRESPOT_CLIENT_ID = '65b708073fc0480ea92a077233ca87bd';
// librespot main.rs: `http://127.0.0.1{:oauth-port}/login`, default port 5588.
export const LIBRESPOT_REDIRECT_URI = 'http://127.0.0.1:5588/login';
// librespot main.rs OAUTH_SCOPES, verbatim — "Some of these are only available
// when requested with Spotify's client IDs", which is exactly the point.
export const LIBRESPOT_SCOPES: readonly string[] = [
  'app-remote-control', 'playlist-modify', 'playlist-modify-private', 'playlist-modify-public',
  'playlist-read', 'playlist-read-collaborative', 'playlist-read-private', 'streaming',
  'ugc-image-upload', 'user-follow-modify', 'user-follow-read', 'user-library-modify',
  'user-library-read', 'user-modify', 'user-modify-playback-state', 'user-modify-private',
  'user-personalized', 'user-read-birthdate', 'user-read-currently-playing', 'user-read-email',
  'user-read-play-history', 'user-read-playback-position', 'user-read-playback-state',
  'user-read-private', 'user-read-recently-played', 'user-top-read',
];

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(64)); // 86 chars, within RFC 7636's 43–128
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function receiverAuthorizeUrl(opts: { challenge: string; state: string }): string {
  const u = new URL(`${SPOTIFY_ACCOUNTS}/authorize`);
  u.searchParams.set('client_id', LIBRESPOT_CLIENT_ID);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', LIBRESPOT_REDIRECT_URI);
  u.searchParams.set('scope', LIBRESPOT_SCOPES.join(' '));
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('code_challenge', opts.challenge);
  u.searchParams.set('state', opts.state);
  return u.toString();
}

// The landing URL (or a bare code) the operator pastes back.
export function parseReceiverRedirect(input: string): { code: string; state: string | null } | null {
  const s = String(input ?? '').trim();
  if (!s) return null;
  if (/^[A-Za-z0-9_-]{20,}$/.test(s) && !s.includes('://')) return { code: s, state: null };
  try {
    const u = new URL(s);
    const code = u.searchParams.get('code');
    if (!code) return null;
    return { code, state: u.searchParams.get('state') };
  } catch {
    return null;
  }
}

export interface ReceiverToken { accessToken: string; refreshToken: string; expiresAt: number; scope: string }

async function tokenRequest(body: URLSearchParams, fetchImpl: typeof fetch, now: () => number): Promise<ReceiverToken> {
  const res = await fetchImpl(`${SPOTIFY_ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, // public client: NO Authorization header
    body,
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    throw new SpotifyAuthError(res.status, `receiver token request failed (${res.status}): ${redactSpotify(String(j.error_description || j.error || 'no access_token'))}`);
  }
  return {
    accessToken: j.access_token,
    refreshToken: String(j.refresh_token || ''),
    expiresAt: now() + (Number(j.expires_in) || 3600) * 1000,
    scope: String(j.scope || ''),
  };
}

export function exchangeReceiverCode(code: string, verifier: string, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): Promise<ReceiverToken> {
  return tokenRequest(new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: LIBRESPOT_REDIRECT_URI,
    client_id: LIBRESPOT_CLIENT_ID,
    code_verifier: verifier,
  }), fetchImpl, now);
}

export function refreshReceiverToken(refreshToken: string, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): Promise<ReceiverToken> {
  return tokenRequest(new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: LIBRESPOT_CLIENT_ID,
  }), fetchImpl, now);
}

// Pending sign-ins: state → PKCE verifier, ten-minute life like the app flow.
const pending = new Map<string, { verifier: string; at: number }>();
const PENDING_TTL_MS = 10 * 60 * 1000;

export function beginReceiverAuth(now: () => number = Date.now): { url: string; state: string } {
  for (const [k, v] of pending) if (now() - v.at > PENDING_TTL_MS) pending.delete(k);
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(16).toString('hex');
  pending.set(state, { verifier, at: now() });
  return { url: receiverAuthorizeUrl({ challenge, state }), state };
}

// Consume a pending state. A pasted URL without a state (a very old browser
// tab) is accepted only when exactly ONE sign-in is pending — there is no
// other verifier it could belong to.
export function takeReceiverVerifier(state: string | null, now: () => number = Date.now): string | null {
  for (const [k, v] of pending) if (now() - v.at > PENDING_TTL_MS) pending.delete(k);
  if (state) {
    const hit = pending.get(state);
    pending.delete(state);
    return hit?.verifier ?? null;
  }
  if (pending.size === 1) {
    const [k, v] = [...pending.entries()][0];
    pending.delete(k);
    return v.verifier;
  }
  return null;
}

// Station-wide scrobbling — Last.fm + ListenBrainz + Navidrome, driven from
// Queue.onTrackStarted. Each backend is independent (own enable flag,
// credentials, failure mode); every call is fire-and-forget with a 5s timeout and
// no retry queue.
//
// Listener gating fails CLOSED (unknown count → skip): polluting a real profile
// during a monitoring blip is worse than missing entries. Navidrome (#1298) runs
// BEFORE that gate — it is the operator's own library, and its playCount/lastPlayed
// stamps are what rotate `.nsp` smart playlists whether or not anyone heard it.

import { createHash } from 'node:crypto';
import * as settings from '../settings.js';
import { getListenerCount, presentListeners } from './listeners.js';
import {
  LASTFM_API,
  resolveLastfmApiKey,
  resolveLastfmApiSecret,
  resolveLastfmSessionKey,
} from '../music/lastfm-shared.js';
import { fetchWithTimeout } from '../util/fetch-timeout.js';
import { config } from '../config.js';
import * as subsonic from '../music/subsonic.js';
import {
  elapsedSeconds,
  isEligibleScrobble,
  planNavidrome,
  type ScrobbleTrackLike,
} from './scrobble-pure.js';

const TIMEOUT_MS = 5000;

// Env LISTENBRAINZ_API_URL wins, then settings baseUrl, else LB.org. Either input
// may be the API root or the submit endpoint; normalized to a base here.
export function listenbrainzApiBase(): string {
  const raw =
    process.env.LISTENBRAINZ_API_URL?.trim() ||
    settings.get()?.scrobble?.listenbrainz?.baseUrl?.trim() ||
    '';
  const base = raw.replace(/\/submit-listens\/?$/i, '').replace(/\/$/, '');
  return base || 'https://api.listenbrainz.org/1';
}

function listenbrainzSubmitUrl(): string {
  return `${listenbrainzApiBase()}/submit-listens`;
}

export type ScrobbleTrack = ScrobbleTrackLike;

interface TrackEventArgs {
  outgoing: ScrobbleTrack | null;        // the track that just ended (may be null on first start)
  outgoingStartedAt: string | null;      // ISO timestamp the outgoing track started at
  incoming: ScrobbleTrack | null;        // the track that just started
}

interface LastfmCreds {
  apiKey: string;
  apiSecret: string;
  sessionKey: string;
}

function lastfmCreds(): LastfmCreds | null {
  const s: any = settings.get()?.scrobble?.lastfm || {};
  if (!s.enabled) return null;
  const apiKey = resolveLastfmApiKey();
  const apiSecret = resolveLastfmApiSecret();
  const sessionKey = resolveLastfmSessionKey();
  if (!apiKey || !apiSecret || !sessionKey) return null;
  return { apiKey, apiSecret, sessionKey };
}

function listenbrainzToken(): string | null {
  const s: any = settings.get()?.scrobble?.listenbrainz || {};
  if (!s.enabled) return null;
  const token = process.env.LISTENBRAINZ_USER_TOKEN || s.userToken || '';
  return token || null;
}

// md5 over every parameter except `format`/`callback`, sorted alphabetically and
// concatenated key+value, with the shared secret appended.
// See https://www.last.fm/api/authspec.
function signLastfm(params: Record<string, string>, secret: string): string {
  const keys = Object.keys(params).filter(k => k !== 'format' && k !== 'callback').sort();
  const sigStr = keys.map(k => k + params[k]).join('') + secret;
  return createHash('md5').update(sigStr, 'utf8').digest('hex');
}

// Only the admin Test button inspects this; onTrackEvent's calls ignore it.
interface CallResult {
  ok: boolean;
  message?: string;
}

async function callLastfm(method: string, baseParams: Record<string, string>, creds: LastfmCreds): Promise<CallResult> {
  const params: Record<string, string> = {
    ...baseParams,
    method,
    api_key: creds.apiKey,
    sk: creds.sessionKey,
  };
  params.api_sig = signLastfm(params, creds.apiSecret);
  params.format = 'json';
  const body = new URLSearchParams(params).toString();

  try {
    const r = await fetchWithTimeout(LASTFM_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'sub-wave/scrobble',
      },
      body,
      timeoutMs: TIMEOUT_MS,
      bodyDeadline: true,
    });
    if (!r.ok) {
      let detail = '';
      try { detail = (await r.text()).slice(0, 200); } catch {}
      const message = `HTTP ${r.status}${detail ? ` — ${detail}` : ''}`;
      console.warn(`[scrobble] last.fm ${method} → ${message}`);
      return { ok: false, message };
    }
    // 200 doesn't guarantee success — Last.fm embeds a JSON `error` field.
    try {
      const data = (await r.json()) as any;
      if (data?.error) {
        const message = `error ${data.error}: ${data.message || ''}`.trim();
        console.warn(`[scrobble] last.fm ${method} ${message}`);
        return { ok: false, message };
      }
    } catch {
      // Non-JSON body on 200 — treat as success.
    }
    return { ok: true };
  } catch (err: any) {
    const message = err?.name === 'AbortError' ? 'request timed out' : (err?.message || String(err));
    console.warn(`[scrobble] last.fm ${method} failed: ${message}`);
    return { ok: false, message };
  }
}

function lastfmTrackParams(track: ScrobbleTrack): Record<string, string> {
  const p: Record<string, string> = {
    artist: String(track.artist || ''),
    track: String(track.title || ''),
  };
  if (track.album) p.album = String(track.album);
  const d = Number(track.duration);
  if (Number.isFinite(d) && d > 0) p.duration = String(Math.round(d));
  return p;
}

async function lastfmUpdateNowPlaying(track: ScrobbleTrack, creds: LastfmCreds): Promise<CallResult> {
  return callLastfm('track.updateNowPlaying', lastfmTrackParams(track), creds);
}

async function lastfmScrobble(
  track: ScrobbleTrack,
  startedAt: string,
  creds: LastfmCreds,
): Promise<CallResult> {
  const ts = Math.floor(Date.parse(startedAt) / 1000);
  if (!Number.isFinite(ts)) return { ok: false, message: 'invalid start timestamp' };
  return callLastfm(
    'track.scrobble',
    { ...lastfmTrackParams(track), timestamp: String(ts) },
    creds,
  );
}

// Last.fm web-auth flow (admin "Connect to Last.fm"): getAuthToken → operator
// authorizes in the browser → completeAuth trades the token for a session key.
// Uses the same env-wins key/secret resolution as scrobble time, so the minted
// session key is bound to the api key scrobbling will use.

// No session key yet and no `enabled` gate: this flow exists to obtain one.
function lastfmApiCreds(): { apiKey: string; apiSecret: string } | null {
  const apiKey = resolveLastfmApiKey();
  const apiSecret = resolveLastfmApiSecret();
  if (!apiKey || !apiSecret) return null;
  return { apiKey, apiSecret };
}

// Unlike the write calls, this THROWS on failure so the route can surface it.
async function callLastfmAuth(
  method: string,
  extra: Record<string, string>,
  creds: { apiKey: string; apiSecret: string },
): Promise<any> {
  const params: Record<string, string> = { api_key: creds.apiKey, method, ...extra };
  params.api_sig = signLastfm(params, creds.apiSecret);
  params.format = 'json';
  const r = await fetchWithTimeout(`${LASTFM_API}?${new URLSearchParams(params)}`, {
    headers: { 'User-Agent': 'sub-wave/scrobble' },
    timeoutMs: TIMEOUT_MS,
    bodyDeadline: true,
  });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok || data?.error) {
    throw new Error(data?.message || `Last.fm ${method} failed (HTTP ${r.status})`);
  }
  return data;
}

// Step 1: mint a request token + the URL the operator visits to grant access.
export async function lastfmGetAuthToken(): Promise<{ token: string; authUrl: string }> {
  const creds = lastfmApiCreds();
  if (!creds) throw new Error('Save your Last.fm API key and secret first');
  const data = await callLastfmAuth('auth.getToken', {}, creds);
  const token: string = data?.token;
  if (!token) throw new Error('Last.fm did not return an auth token');
  const authUrl = `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(creds.apiKey)}&token=${encodeURIComponent(token)}`;
  return { token, authUrl };
}

// Step 2: trade the authorized token for a long-lived session key.
export async function lastfmCompleteAuth(token: string): Promise<{ sessionKey: string; username: string }> {
  const creds = lastfmApiCreds();
  if (!creds) throw new Error('Save your Last.fm API key and secret first');
  if (!token || !token.trim()) throw new Error('Missing auth token');
  const data = await callLastfmAuth('auth.getSession', { token: token.trim() }, creds);
  const sessionKey: string = data?.session?.key;
  const username: string = data?.session?.name || '';
  if (!sessionKey) throw new Error('Last.fm returned no session key — was access granted?');
  return { sessionKey, username };
}

async function postListenbrainz(payload: Record<string, unknown>, token: string, label: string): Promise<CallResult> {
  try {
    const r = await fetchWithTimeout(listenbrainzSubmitUrl(), {
      method: 'POST',
      headers: {
        'Authorization': `Token ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'sub-wave/scrobble',
      },
      body: JSON.stringify(payload),
      timeoutMs: TIMEOUT_MS,
      bodyDeadline: true,
    });
    if (!r.ok) {
      let detail = '';
      try { detail = (await r.text()).slice(0, 200); } catch {}
      const message = `HTTP ${r.status}${detail ? ` — ${detail}` : ''}`;
      console.warn(`[scrobble] listenbrainz ${label} → ${message}`);
      return { ok: false, message };
    }
    return { ok: true };
  } catch (err: any) {
    const message = err?.name === 'AbortError' ? 'request timed out' : (err?.message || String(err));
    console.warn(`[scrobble] listenbrainz ${label} failed: ${message}`);
    return { ok: false, message };
  }
}

function listenbrainzTrackMetadata(track: ScrobbleTrack): Record<string, unknown> {
  const md: Record<string, unknown> = {
    artist_name: String(track.artist || ''),
    track_name: String(track.title || ''),
  };
  if (track.album) md.release_name = String(track.album);
  const d = Number(track.duration);
  const additional: Record<string, unknown> = {};
  if (Number.isFinite(d) && d > 0) additional.duration = Math.round(d);
  additional.media_player = 'SUB/WAVE';
  additional.submission_client = 'sub-wave/scrobble';
  md.additional_info = additional;
  return md;
}

async function listenbrainzPlayingNow(track: ScrobbleTrack, token: string): Promise<CallResult> {
  return postListenbrainz(
    {
      listen_type: 'playing_now',
      payload: [{ track_metadata: listenbrainzTrackMetadata(track) }],
    },
    token,
    'playing_now',
  );
}

async function listenbrainzSubmit(track: ScrobbleTrack, startedAt: string, token: string): Promise<CallResult> {
  const ts = Math.floor(Date.parse(startedAt) / 1000);
  if (!Number.isFinite(ts)) return { ok: false, message: 'invalid start timestamp' };
  return postListenbrainz(
    {
      listen_type: 'single',
      payload: [
        {
          listened_at: ts,
          track_metadata: listenbrainzTrackMetadata(track),
        },
      ],
    },
    token,
    'submit_listens',
  );
}

// Navidrome goes through music/subsonic.ts, inheriting its salt+token auth,
// bounded fetch and /debug call log. Credentials come from `config.navidrome`,
// never from settings, so there is nothing to paste or redact.

function navidromeConfigured(): boolean {
  const n = config.navidrome;
  return !!(n?.url && n?.user && n?.password);
}

function navidromeEnabled(): boolean {
  return !!settings.get()?.scrobble?.navidrome?.enabled;
}

// Fire-and-forget: a failure only logs, never throws near the broadcast.
function sendNavidrome(
  id: string,
  opts: { submission: boolean; timeMs?: number | null },
  label: string,
): void {
  void subsonic
    .scrobble(id, { submission: opts.submission, timeMs: opts.timeMs ?? null })
    .catch((err: any) => {
      console.warn(`[scrobble] navidrome ${label} failed: ${err?.message || String(err)}`);
    });
}

// Called from Queue.onTrackStarted. Never throws, never blocks the caller.
export function onTrackEvent({ outgoing, outgoingStartedAt, incoming }: TrackEventArgs): void {
  // Navidrome runs ahead of the listener gate below, which returns early on an
  // unknown count. See the header note and planNavidrome.
  const navPlan = planNavidrome({
    enabled: navidromeEnabled(),
    configured: navidromeConfigured(),
    incoming,
    outgoing,
    outgoingStartedAt,
  });
  if (navPlan.nowPlayingId) {
    console.log(`[scrobble] now-playing → navidrome: "${incoming?.title || navPlan.nowPlayingId}"`);
    sendNavidrome(navPlan.nowPlayingId, { submission: false }, 'now-playing');
  }
  if (navPlan.submitId) {
    console.log(`[scrobble] submit → navidrome: "${outgoing?.title || navPlan.submitId}"`);
    sendNavidrome(
      navPlan.submitId,
      { submission: true, timeMs: navPlan.submitAtMs },
      'submit',
    );
  }

  const listeners = presentListeners();
  if (listeners === null) {
    console.log(`[scrobble] skip: ${getListenerCount() ?? 'null'} listener(s)`);
    return;
  }

  const lf = lastfmCreds();
  const lb = listenbrainzToken();
  if (!lf && !lb) {
    console.log('[scrobble] skip: no backend enabled with credentials');
    return;
  }

  const backends = [lf && 'last.fm', lb && 'listenbrainz'].filter(Boolean).join('+');

  if (incoming?.title && incoming?.artist) {
    console.log(`[scrobble] now-playing → ${backends}: "${incoming.title}" — ${incoming.artist}`);
    if (lf) lastfmUpdateNowPlaying(incoming, lf).catch(() => {});
    if (lb) listenbrainzPlayingNow(incoming, lb).catch(() => {});
  }

  if (outgoing && outgoingStartedAt) {
    const elapsed = elapsedSeconds(outgoingStartedAt);
    if (isEligibleScrobble(outgoing, elapsed)) {
      console.log(`[scrobble] submit → ${backends}: "${outgoing.title}" — ${outgoing.artist} (elapsed=${elapsed}s)`);
      if (lf) lastfmScrobble(outgoing, outgoingStartedAt, lf).catch(() => {});
      if (lb) listenbrainzSubmit(outgoing, outgoingStartedAt, lb).catch(() => {});
    } else {
      const dur = Number(outgoing.duration);
      const durDisplay = Number.isFinite(dur) && dur > 0 ? `${dur}s` : 'unknown';
      console.log(`[scrobble] skip submit (ineligible): "${outgoing.title}" elapsed=${elapsed}s duration=${durDisplay}`);
    }
  }
}

// Admin "Test" button. Bypasses the listener gate but still respects the
// per-backend enabled flag, so "disabled but configured" cannot surprise-emit.
export type ScrobbleProvider = 'lastfm' | 'listenbrainz' | 'navidrome';

export interface TestResult {
  ok: boolean;
  message: string;
}

export async function testNowPlaying(
  provider: ScrobbleProvider,
  track: ScrobbleTrack,
): Promise<TestResult> {
  if (!track?.title || !track?.artist) {
    return { ok: false, message: 'no track currently playing — wait for one and try again' };
  }
  if (provider === 'lastfm') {
    const creds = lastfmCreds();
    if (!creds) return { ok: false, message: 'last.fm not enabled or missing credentials' };
    const res = await lastfmUpdateNowPlaying(track, creds);
    return res.ok
      ? { ok: true, message: `sent now-playing to last.fm for "${track.title}"` }
      : { ok: false, message: `last.fm rejected it — ${res.message || 'unknown error'}` };
  }
  if (provider === 'listenbrainz') {
    const token = listenbrainzToken();
    if (!token) return { ok: false, message: 'listenbrainz not enabled or missing user token' };
    const res = await listenbrainzPlayingNow(track, token);
    return res.ok
      ? { ok: true, message: `sent playing_now to listenbrainz for "${track.title}"` }
      : { ok: false, message: `listenbrainz rejected it — ${res.message || 'unknown error'}` };
  }
  if (provider === 'navidrome') {
    if (!navidromeEnabled()) return { ok: false, message: 'navidrome scrobbling is off' };
    if (!navidromeConfigured()) {
      return { ok: false, message: 'navidrome URL / username / password not configured' };
    }
    const id = String(track.id || '').trim();
    if (!id) {
      return { ok: false, message: 'the on-air track carries no Navidrome id — wait for a library track' };
    }
    // Not fire-and-forget: the operator asked, so the error text is the answer.
    try {
      await subsonic.scrobble(id, { submission: false });
      return { ok: true, message: `sent now-playing to navidrome for "${track.title}"` };
    } catch (err: any) {
      return { ok: false, message: `navidrome rejected it — ${err?.message || 'unknown error'}` };
    }
  }
  return { ok: false, message: `unknown provider "${provider}"` };
}

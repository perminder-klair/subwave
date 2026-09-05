// Station-wide scrobbling — Last.fm + ListenBrainz + Navidrome.
//
// Triggered from Queue.onTrackStarted on every real music transition:
//   - the OUTGOING track (the one that just ended) is submitted as a scrobble
//     if it passed Last.fm's standard eligibility rule (>30s long, played >50%
//     OR >240s) AND at least one listener is currently tuned in
//   - the INCOMING track gets a `track.updateNowPlaying` / `playing_now` ping
//     so the operator's profile shows "currently playing X" — same listener
//     gate, no eligibility check
//   - Navidrome takes both halves through the Subsonic `scrobble` endpoint
//     (`submission=false` for the ping, `submission=true` for the play) so
//     playCount and lastPlayed move in the operator's own library
//
// Each backend (Last.fm, ListenBrainz, Navidrome) is independent: own enable
// flag, own credentials, own failure mode. Every network call is
// fire-and-forget with a 5s timeout — matching broadcast/webhooks.ts. Failures
// log to stderr; there is no retry queue. If you want guaranteed delivery,
// point at a relay.
//
// Listener gating fails CLOSED (unknown listener count → skip), unlike
// djCallsAllowed() which fails OPEN. Silencing the DJ during a stats outage
// is worse than over-talking, but polluting a real Last.fm profile with
// scrobbles during a monitoring blip is worse than missing a few entries.
//
// Navidrome (#1298) is the exception and runs BEFORE that gate: it is the
// operator's own library, not a public profile, and the point of stamping
// playCount/lastPlayed is that `.nsp` smart playlists rotate — a play nobody
// heard still has to stop the picker reaching for the same track an hour
// later. `planNavidrome` in scrobble-pure.ts owns that reasoning; the ordering
// here is what makes it reachable. With the setting off (the default) nothing
// about the pre-existing path changes.

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

// Shared base for submit + validate-token. Env LISTENBRAINZ_API_URL wins, then
// settings baseUrl (for self-hosted LB-compatible scrobblers), else LB.org. Both
// inputs may be either the API root (…/1) or the submit endpoint
// (…/1/submit-listens) — normalize to a base.
export function listenbrainzApiBase(): string {
  const raw =
    process.env.LISTENBRAINZ_API_URL?.trim() ||
    settings.get()?.scrobble?.listenbrainz?.baseUrl?.trim() ||
    '';
  const base = raw.replace(/\/submit-listens\/?$/i, '').replace(/\/$/, '');
  return base || 'https://api.listenbrainz.org/1';
}

// The submit endpoint is always the base + /submit-listens.
function listenbrainzSubmitUrl(): string {
  return `${listenbrainzApiBase()}/submit-listens`;
}

// The eligibility rule and the Navidrome plan are pure and live in
// scrobble-pure.ts — one copy, driven from a test table.
export type ScrobbleTrack = ScrobbleTrackLike;

interface TrackEventArgs {
  outgoing: ScrobbleTrack | null;        // the track that just ended (may be null on first start)
  outgoingStartedAt: string | null;      // ISO timestamp the outgoing track started at
  incoming: ScrobbleTrack | null;        // the track that just started
}

// ── credential helpers ──────────────────────────────────────────────────────

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

// ── Last.fm client ──────────────────────────────────────────────────────────

// Last.fm signs write calls with md5 of every parameter (except `format` and
// `callback`) sorted alphabetically and concatenated as key+value, then the
// shared secret appended. See https://www.last.fm/api/authspec.
function signLastfm(params: Record<string, string>, secret: string): string {
  const keys = Object.keys(params).filter(k => k !== 'format' && k !== 'callback').sort();
  const sigStr = keys.map(k => k + params[k]).join('') + secret;
  return createHash('md5').update(sigStr, 'utf8').digest('hex');
}

// Outcome of a single Last.fm/ListenBrainz call. `ok:false` carries a one-line
// reason. The fire-and-forget callers (onTrackEvent) ignore this; only the
// admin Test button inspects it — for years it couldn't, because this swallowed
// every failure and always read as success.
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

// ── Last.fm web-auth flow (admin "Connect to Last.fm") ───────────────────────
//
// Replaces the CLI `npm run lastfm-session` dance with a two-step handshake the
// admin UI drives: getAuthToken → operator authorizes in the browser →
// completeAuth trades the token for a long-lived session key. Uses the SAME
// env-wins api-key/secret resolution as scrobble time, so the session key it
// mints is bound to the exact api key scrobbling will use (no mismatch).

// Just the api key + secret — no session key yet, no `enabled` gate (the whole
// point of the flow is to obtain the missing session key).
function lastfmApiCreds(): { apiKey: string; apiSecret: string } | null {
  const apiKey = resolveLastfmApiKey();
  const apiSecret = resolveLastfmApiSecret();
  if (!apiKey || !apiSecret) return null;
  return { apiKey, apiSecret };
}

// Signed GET to a Last.fm auth method. Unlike the write calls these are reads
// whose body we need, so this THROWS on any failure for the route to surface.
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

// Step 2: after the operator authorizes, trade the token for a session key
// (long-lived, never expires) and the username it belongs to.
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

// ── ListenBrainz client ─────────────────────────────────────────────────────

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

// ── Navidrome client ────────────────────────────────────────────────────────
//
// Reuses the Subsonic client every other library call goes through
// (music/subsonic.ts), so it inherits the salt+token auth, the bounded fetch
// and the /debug call log. Credentials come from `config.navidrome` — the same
// ones the picker streams with — never from settings, so there is nothing to
// paste and nothing to redact.

function navidromeConfigured(): boolean {
  const n = config.navidrome;
  return !!(n?.url && n?.user && n?.password);
}

function navidromeEnabled(): boolean {
  return !!settings.get()?.scrobble?.navidrome?.enabled;
}

// Fire-and-forget, like every other backend here. A Navidrome outage costs one
// missing play stamp and must never surface anywhere near the broadcast, so the
// only thing a failure does is log — no retry, no queue, no throw.
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

// ── public surface ──────────────────────────────────────────────────────────

// Called from Queue.onTrackStarted on every real music transition. Pure
// side-effects — never throws, never blocks the caller. Fires every enabled
// backend in parallel (fire-and-forget).
export function onTrackEvent({ outgoing, outgoingStartedAt, incoming }: TrackEventArgs): void {
  // Navidrome first — deliberately AHEAD of the listener gate below, which
  // returns early on an unknown count. See the header note and planNavidrome.
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

  // Incoming → now-playing ping.
  if (incoming?.title && incoming?.artist) {
    console.log(`[scrobble] now-playing → ${backends}: "${incoming.title}" — ${incoming.artist}`);
    if (lf) lastfmUpdateNowPlaying(incoming, lf).catch(() => {});
    if (lb) listenbrainzPlayingNow(incoming, lb).catch(() => {});
  }

  // Outgoing → scrobble if eligible.
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

// Admin "Test" button — fires a now-playing ping for the supplied track on
// the named backend. Returns { ok, status, message } so the UI can surface
// the actual API response. Bypasses the listener gate (operator wants to
// verify their credentials regardless of who's tuned in) but still respects
// the per-backend enabled flag, since "disabled but configured" should not
// surprise-emit.
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
    // The one call here that is NOT fire-and-forget: the operator asked, so the
    // error text is the answer.
    try {
      await subsonic.scrobble(id, { submission: false });
      return { ok: true, message: `sent now-playing to navidrome for "${track.title}"` };
    } catch (err: any) {
      return { ok: false, message: `navidrome rejected it — ${err?.message || 'unknown error'}` };
    }
  }
  return { ok: false, message: `unknown provider "${provider}"` };
}

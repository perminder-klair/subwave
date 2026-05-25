// Station-wide scrobbling — Last.fm + ListenBrainz.
//
// Triggered from Queue.onTrackStarted on every real music transition:
//   - the OUTGOING track (the one that just ended) is submitted as a scrobble
//     if it passed Last.fm's standard eligibility rule (>30s long, played >50%
//     OR >240s) AND at least one listener is currently tuned in
//   - the INCOMING track gets a `track.updateNowPlaying` / `playing_now` ping
//     so the operator's profile shows "currently playing X" — same listener
//     gate, no eligibility check
//
// Each backend (Last.fm, ListenBrainz) is independent: own enable flag, own
// credentials, own failure mode. Every network call is fire-and-forget with a
// 5s timeout — matching broadcast/webhooks.ts. Failures log to stderr; there
// is no retry queue. If you want guaranteed delivery, point at a relay.
//
// Listener gating fails CLOSED (unknown listener count → skip), unlike
// djCallsAllowed() which fails OPEN. Silencing the DJ during a stats outage
// is worse than over-talking, but polluting a real Last.fm profile with
// scrobbles during a monitoring blip is worse than missing a few entries.

import { createHash } from 'node:crypto';
import * as settings from '../settings.js';
import { getListenerCount } from './listeners.js';

const TIMEOUT_MS = 5000;
const LASTFM_API = 'https://ws.audioscrobbler.com/2.0/';
const LISTENBRAINZ_API = 'https://api.listenbrainz.org/1/submit-listens';

// Last.fm's documented rule for a "valid scrobble":
//   - the track must be longer than 30 seconds
//   - and either >50% of the track has been played, or >4 minutes (whichever
//     comes first)
// When duration is unknown we can only enforce the 4-minute floor.
const MIN_DURATION_SEC = 30;
const MIN_ELAPSED_FLOOR_SEC = 240;

export interface ScrobbleTrack {
  id?: string | null;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  duration?: number | null; // seconds, optional
}

interface TrackEventArgs {
  outgoing: ScrobbleTrack | null;        // the track that just ended (may be null on first start)
  outgoingStartedAt: string | null;      // ISO timestamp the outgoing track started at
  incoming: ScrobbleTrack | null;        // the track that just started
}

// ── eligibility ─────────────────────────────────────────────────────────────

function elapsedSeconds(startedAt: string | null | undefined): number {
  if (!startedAt) return 0;
  const t = Date.parse(startedAt);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 1000));
}

function isEligibleScrobble(track: ScrobbleTrack | null, elapsed: number): boolean {
  if (!track?.title || !track?.artist) return false;
  const d = Number(track.duration);
  if (Number.isFinite(d) && d > 0) {
    if (d <= MIN_DURATION_SEC) return false;
    return elapsed >= d / 2 || elapsed >= MIN_ELAPSED_FLOOR_SEC;
  }
  // Duration unknown — fall back to the 4-minute floor only.
  return elapsed >= MIN_ELAPSED_FLOOR_SEC;
}

function listenersPresent(): boolean {
  const c = getListenerCount();
  return typeof c === 'number' && c > 0;
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
  const apiKey = process.env.LASTFM_API_KEY || s.apiKey || '';
  const apiSecret = process.env.LASTFM_API_SECRET || s.apiSecret || '';
  const sessionKey = process.env.LASTFM_SESSION_KEY || s.sessionKey || '';
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

async function callLastfm(method: string, baseParams: Record<string, string>, creds: LastfmCreds): Promise<void> {
  const params: Record<string, string> = {
    ...baseParams,
    method,
    api_key: creds.apiKey,
    sk: creds.sessionKey,
  };
  params.api_sig = signLastfm(params, creds.apiSecret);
  params.format = 'json';
  const body = new URLSearchParams(params).toString();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(LASTFM_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'sub-wave/scrobble',
      },
      body,
      signal: ctrl.signal,
    });
    if (!r.ok) {
      let detail = '';
      try { detail = (await r.text()).slice(0, 200); } catch {}
      console.warn(`[scrobble] last.fm ${method} → ${r.status}${detail ? ` — ${detail}` : ''}`);
      return;
    }
    // 200 doesn't guarantee success — Last.fm embeds a JSON `error` field.
    try {
      const data = (await r.json()) as any;
      if (data?.error) {
        console.warn(`[scrobble] last.fm ${method} error ${data.error}: ${data.message || ''}`);
      }
    } catch {
      // Non-JSON body on 200 — treat as success.
    }
  } catch (err: any) {
    console.warn(`[scrobble] last.fm ${method} failed: ${err?.message || err}`);
  } finally {
    clearTimeout(timer);
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

async function lastfmUpdateNowPlaying(track: ScrobbleTrack, creds: LastfmCreds): Promise<void> {
  await callLastfm('track.updateNowPlaying', lastfmTrackParams(track), creds);
}

async function lastfmScrobble(
  track: ScrobbleTrack,
  startedAt: string,
  creds: LastfmCreds,
): Promise<void> {
  const ts = Math.floor(Date.parse(startedAt) / 1000);
  if (!Number.isFinite(ts)) return;
  await callLastfm(
    'track.scrobble',
    { ...lastfmTrackParams(track), timestamp: String(ts) },
    creds,
  );
}

// ── ListenBrainz client ─────────────────────────────────────────────────────

async function postListenbrainz(payload: Record<string, unknown>, token: string, label: string): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(LISTENBRAINZ_API, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'sub-wave/scrobble',
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      let detail = '';
      try { detail = (await r.text()).slice(0, 200); } catch {}
      console.warn(`[scrobble] listenbrainz ${label} → ${r.status}${detail ? ` — ${detail}` : ''}`);
    }
  } catch (err: any) {
    console.warn(`[scrobble] listenbrainz ${label} failed: ${err?.message || err}`);
  } finally {
    clearTimeout(timer);
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

async function listenbrainzPlayingNow(track: ScrobbleTrack, token: string): Promise<void> {
  await postListenbrainz(
    {
      listen_type: 'playing_now',
      payload: [{ track_metadata: listenbrainzTrackMetadata(track) }],
    },
    token,
    'playing_now',
  );
}

async function listenbrainzSubmit(track: ScrobbleTrack, startedAt: string, token: string): Promise<void> {
  const ts = Math.floor(Date.parse(startedAt) / 1000);
  if (!Number.isFinite(ts)) return;
  await postListenbrainz(
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

// ── public surface ──────────────────────────────────────────────────────────

// Called from Queue.onTrackStarted on every real music transition. Pure
// side-effects — never throws, never blocks the caller. Fires both backends
// in parallel (fire-and-forget).
export function onTrackEvent({ outgoing, outgoingStartedAt, incoming }: TrackEventArgs): void {
  if (!listenersPresent()) return;

  const lf = lastfmCreds();
  const lb = listenbrainzToken();
  if (!lf && !lb) return;

  // Incoming → now-playing ping.
  if (incoming?.title && incoming?.artist) {
    if (lf) lastfmUpdateNowPlaying(incoming, lf).catch(() => {});
    if (lb) listenbrainzPlayingNow(incoming, lb).catch(() => {});
  }

  // Outgoing → scrobble if eligible.
  if (outgoing && outgoingStartedAt) {
    const elapsed = elapsedSeconds(outgoingStartedAt);
    if (isEligibleScrobble(outgoing, elapsed)) {
      if (lf) lastfmScrobble(outgoing, outgoingStartedAt, lf).catch(() => {});
      if (lb) listenbrainzSubmit(outgoing, outgoingStartedAt, lb).catch(() => {});
    }
  }
}

// Admin "Test" button — fires a now-playing ping for the supplied track on
// the named backend. Returns { ok, status, message } so the UI can surface
// the actual API response. Bypasses the listener gate (operator wants to
// verify their credentials regardless of who's tuned in) but still respects
// the per-backend enabled flag, since "disabled but configured" should not
// surprise-emit.
export type ScrobbleProvider = 'lastfm' | 'listenbrainz';

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
    try {
      await lastfmUpdateNowPlaying(track, creds);
      return { ok: true, message: `sent now-playing to last.fm for "${track.title}"` };
    } catch (err: any) {
      return { ok: false, message: err?.message || 'last.fm test failed' };
    }
  }
  if (provider === 'listenbrainz') {
    const token = listenbrainzToken();
    if (!token) return { ok: false, message: 'listenbrainz not enabled or missing user token' };
    try {
      await listenbrainzPlayingNow(track, token);
      return { ok: true, message: `sent playing_now to listenbrainz for "${track.title}"` };
    } catch (err: any) {
      return { ok: false, message: err?.message || 'listenbrainz test failed' };
    }
  }
  return { ok: false, message: `unknown provider "${provider}"` };
}

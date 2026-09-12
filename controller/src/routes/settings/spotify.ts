// Spotify music-source settings: credentials, the one-time OAuth connect, a
// non-mutating probe, and disconnect. Admin-gated except the OAuth callback,
// which Spotify's redirect reaches without the admin's Basic-auth header — it is
// protected by a one-time `state` nonce instead (standard OAuth posture).
//
// Storage follows the house rules: the client id/secret and refresh token are
// SECRETS → state/secrets.env via saveSecrets (env always wins; env-managed
// fields are refused rather than shadowed), never settings.json. The catalog
// knobs (pool, device name…) are ordinary settings under `settings.spotify` and
// ride the normal /settings patch path — nothing here touches them.

import express from 'express';
import { randomBytes } from 'node:crypto';
import { requireAdmin } from '../../middleware/auth.js';
import { saveSecrets } from '../../setup/secrets.js';
import { SpotifyClient, SPOTIFY_SCOPES } from '../../music/sources/spotify/client.js';
import { spotifyClient, spotifyCredentials, spotifyPool } from '../../music/sources/spotify/source.js';
import { spotifyReadStats } from '../../music/sources/spotify/reads.js';
import { unplayableCount, unplayableList, clearUnplayable, UNPLAYABLE_TTL_MS } from '../../music/sources/spotify/unplayable-file.js';
import { writeLibrespotToken, readLibrespotToken, LIBRESPOT_CACHE_DIR } from '../../music/sources/spotify/token-file.js';
import { beginReceiverAuth, takeReceiverVerifier, exchangeReceiverCode, parseReceiverRedirect, LIBRESPOT_REDIRECT_URI } from '../../music/sources/spotify/receiver-auth.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { queue } from '../../broadcast/queue.js';

export const router = express.Router();

// Pending OAuth states: nonce → issued-at. Ten minutes is generous for a
// consent screen; anything older is refused so a stale link cannot be replayed.
const pendingStates = new Map<string, number>();
const STATE_TTL_MS = 10 * 60 * 1000;

function sweepStates(now = Date.now()) {
  for (const [k, at] of pendingStates) if (now - at > STATE_TTL_MS) pendingStates.delete(k);
}

// The redirect URI must match the Developer app EXACTLY. SITE_URL is the
// operator's public origin (the same one tune-in links use); the request host is
// the fallback for a LAN install without one.
export function spotifyRedirectUri(req: express.Request): string {
  const explicit = (process.env.SPOTIFY_REDIRECT_URI || '').trim();
  if (explicit) return explicit;
  const site = (process.env.SITE_URL || '').trim().replace(/\/+$/, '');
  const origin = site || `${req.protocol}://${req.get('host')}`;
  return `${origin}/api/settings/spotify/callback`;
}

// The pool's own health, including WHY a build came back partial. `partial`
// on its own only told the operator to go read container logs — which is how a
// wave of 403s sat unnoticed while the station ran on the dead-air guard.
export function poolStatus() {
  const p = spotifyPool().peek();
  // No pool, nothing to report — and the client is only reached AFTER that
  // check, so a station that does not use Spotify never constructs one just
  // because the admin page is open. /settings is polled every 3 seconds.
  if (!p) return null;
  const c = spotifyClient();
  const hold = c.rateLimitHold();
  const pacer = c.pacerState();
  return {
    tracks: p.tracks.size,
    albums: p.albums.size,
    playlists: p.playlists.length,
    builtAt: p.builtAt,
    // When a FULL catalogue walk last ran, as opposed to a cheap revalidate.
    walkedAt: p.walkedAt,
    // This pool came off the saved snapshot and has not been re-checked against
    // Spotify since the controller started. Not a fault — it is why the station
    // was playing seconds after boot — but it does mean the orphan reconcile
    // stands down, so the operator should be able to see it.
    fromDisk: p.fromDisk,
    partial: p.partial,
    notes: p.notes,
    // Genre enrichment converges over several builds (one request per artist
    // since Spotify removed the batch read), so the operator needs to see it
    // moving — a quiet background job with no progress line reads as broken.
    artists: p.artistGenres.size,
    genresPending: p.genresPending,
    // Why the drip did nothing last tick — null when it is working. Without
    // this the admin card could only show a number that was not moving, which
    // is what let a paused drip look identical to a finished one for a day.
    dripSkip: p.dripSkip,
    dripAt: p.dripAt,
    // Non-zero while Spotify is holding us off. Surfaced so a paused fill looks
    // like a pause rather than a failure. `hold.kind` separates the rolling
    // 30-second window from an exhausted developer-account quota, which since
    // July 2026 is shared with every other app on the account and clears on
    // Spotify's schedule rather than in seconds.
    rateLimitedMs: hold.msLeft,
    hold: { kind: hold.kind, msLeft: hold.msLeft, endpoint: hold.endpoint },
    // What the client is currently willing to spend. A slow catalogue walk
    // should read as pacing, not as a fault.
    pacer,
    // What the shared read memos are holding. A cache nobody can see is a cache
    // nobody trusts, and these are the ones that turned the per-pick album and
    // search fan-outs from a few hundred requests an hour into a handful.
    reads: spotifyReadStats(),
    // The walk stopped at maxTracks, so it is a prefix of the library. Worth
    // saying out loud: it also permanently disables the tagger's orphan
    // reconcile, which must never delete against an incomplete walk.
    truncated: p.truncated,
  };
}

export function spotifyStatus(req: express.Request) {
  const c = spotifyCredentials();
  return {
    clientIdSet: !!c.clientId,
    clientSecretSet: !!c.clientSecret,
    connected: !!c.refreshToken,
    env: {
      clientId: !!process.env.SPOTIFY_CLIENT_ID && envManaged('SPOTIFY_CLIENT_ID'),
      clientSecret: !!process.env.SPOTIFY_CLIENT_SECRET && envManaged('SPOTIFY_CLIENT_SECRET'),
      refreshToken: !!process.env.SPOTIFY_REFRESH_TOKEN && envManaged('SPOTIFY_REFRESH_TOKEN'),
    },
    redirectUri: spotifyRedirectUri(req),
    scopes: SPOTIFY_SCOPES,
    pool: poolStatus(),
    // Tracks Spotify refused to play, which the station now remembers so the
    // picker cannot keep choosing them. Surfaced because a silently shrinking
    // library is exactly the kind of thing an operator should be able to see
    // and undo — and because a high `hits` says something is still re-picking.
    unplayable: {
      count: unplayableCount(),
      ttlDays: Math.round(UNPLAYABLE_TTL_MS / 86_400_000),
      recent: unplayableList(20),
    },
  };
}

// A key is "env-managed" when it came from the root .env rather than from
// state/secrets.env. secrets.ts loads the file into process.env at boot without
// overwriting keys already set, and records which ones it loaded.
import { loadedSecretKeys } from '../../setup/secrets.js';
function envManaged(key: string): boolean {
  return !loadedSecretKeys().has(key);
}

router.get('/settings/spotify', requireAdmin, (req, res) => {
  res.json(spotifyStatus(req));
});

// Client id/secret from the Developer app. Blank secret = keep the one on file.
router.post('/settings/spotify/credentials', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const patch: Record<string, string> = {};
    if (typeof b.clientId === 'string') patch.SPOTIFY_CLIENT_ID = b.clientId.trim();
    if (typeof b.clientSecret === 'string' && b.clientSecret !== '') patch.SPOTIFY_CLIENT_SECRET = b.clientSecret.trim();
    for (const key of Object.keys(patch)) {
      if (process.env[key] && envManaged(key)) {
        return res.status(400).json({ ok: false, error: `${key} is managed by the root .env — env always wins on boot; remove it there to manage it here` });
      }
    }
    if (patch.SPOTIFY_CLIENT_ID !== undefined && !/^[0-9a-f]{32}$/i.test(patch.SPOTIFY_CLIENT_ID)) {
      return res.status(400).json({ ok: false, error: 'clientId should be the 32-hex Client ID from the Spotify Developer dashboard' });
    }
    if (!Object.keys(patch).length) return res.status(400).json({ ok: false, error: 'nothing to save' });
    await saveSecrets(patch);
    res.json({ ok: true, ...spotifyStatus(req) });
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err?.message || 'save failed' });
  }
});

// Step 1 of Connect: hand the browser the authorize URL. The state nonce is
// remembered server-side so the callback can tell a real return from a forged
// or replayed one.
router.get('/settings/spotify/auth', requireAdmin, (req, res) => {
  const c = spotifyCredentials();
  if (!c.clientId) return res.status(400).json({ ok: false, error: 'save the Spotify client id first' });
  sweepStates();
  const state = randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now());
  res.json({ ok: true, url: SpotifyClient.authorizeUrl({ clientId: c.clientId, redirectUri: spotifyRedirectUri(req), state }) });
});

// Step 2: Spotify redirects the operator's browser here. NOT admin-gated (the
// redirect carries no Authorization header); the nonce is the gate. Exchanges
// the code, persists the refresh token, writes librespot's first-login token,
// and sends the operator back to the settings section.
router.get('/settings/spotify/callback', async (req, res) => {
  const { code, state, error } = req.query as Record<string, string | undefined>;
  const back = (q: string) => res.redirect(`/admin/settings?section=music&spotify=${encodeURIComponent(q)}`);
  sweepStates();
  if (!state || !pendingStates.has(state)) return back('error:invalid-state');
  pendingStates.delete(state);
  if (error || !code) return back(`error:${error || 'no-code'}`);
  const c = spotifyCredentials();
  if (!c.clientId || !c.clientSecret) return back('error:no-credentials');
  try {
    const tok = await SpotifyClient.exchangeCode({ clientId: c.clientId, clientSecret: c.clientSecret, code, redirectUri: spotifyRedirectUri(req) });
    await saveSecrets({ SPOTIFY_REFRESH_TOKEN: tok.refreshToken });
    spotifyClient().resetToken();
    spotifyPool().invalidate();
    queue.log('scheduler', 'Spotify connected — refresh token stored');
    return back('connected');
  } catch (err: any) {
    queue.log('error', `Spotify connect failed: ${err?.message || err}`);
    return back('error:exchange-failed');
  }
});

// The paste-a-token alternative for operators who ran the OAuth flow elsewhere.
router.post('/settings/spotify/token', requireAdmin, async (req, res) => {
  const token = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken.trim() : '';
  if (!token) return res.status(400).json({ ok: false, error: 'refreshToken is required' });
  if (process.env.SPOTIFY_REFRESH_TOKEN && envManaged('SPOTIFY_REFRESH_TOKEN')) {
    return res.status(400).json({ ok: false, error: 'SPOTIFY_REFRESH_TOKEN is managed by the root .env' });
  }
  await saveSecrets({ SPOTIFY_REFRESH_TOKEN: token });
  spotifyClient().resetToken();
  spotifyPool().invalidate();
  res.json({ ok: true, ...spotifyStatus(req) });
});

// Non-mutating probe: refreshes a token and asks who we are. It can no longer
// report the account tier — February 2026 removed `product` and `country` from
// /me — so it says so rather than reporting a misleading "unknown". Connect
// playback still needs Premium; that is now a requirement, not a check.
router.post('/settings/spotify/test', requireAdmin, async (_req, res) => {
  const c = spotifyClient();
  if (!c.hasCredentials()) return res.json({ ok: false, error: 'not connected' });
  try {
    // `operator: true` — an explicit button press bypasses the rate-limit gate,
    // per CLAUDE.md's rule that manual operator triggers are exempt from every
    // automatic gate. It is one request. Refusing it meant that during a hold
    // the only diagnostic on this page answered "skipped — Spotify rate limit"
    // and told the operator nothing about whether their credentials worked.
    const me: any = await c.getMe({ operator: true });
    res.json({
      ok: true,
      displayName: me?.display_name ?? me?.id,
      product: me?.product ?? null,
      country: me?.country ?? null,
      note: me?.product ? undefined : 'Spotify no longer reports the account tier over the Web API. Connect playback needs Premium.',
    });
  } catch (err: any) {
    res.json({ ok: false, error: err?.message || 'probe failed' });
  }
});

// Forget a rate-limit / quota hold. The escape hatch: before this existed the
// only way out of a stuck hold was to exec into the container and delete
// state/spotify/rate-limit.json, and disconnecting Spotify did not help either
// (the client is a process singleton and resetToken() clears only the access
// token). Clearing does not make Spotify any more willing — it just lets the
// station ask once and find out where it really stands.
router.post('/settings/spotify/hold/clear', requireAdmin, (_req, res) => {
  spotifyClient().clearHold();
  res.json({ ok: true, pool: poolStatus() });
});

// Forget every refused track. Costs NO catalogue requests: the pool snapshot
// keeps the rows a refusal only withheld, so republish() restores them from what
// is already in memory. Deliberately does not invalidate() the pool — that would
// buy a full re-walk to recover rows that were never actually lost.
router.post('/settings/spotify/unplayable/clear', requireAdmin, (_req, res) => {
  const forgotten = clearUnplayable();
  const restored = spotifyPool().republish();
  queue.log('scheduler', `Spotify: forgot ${forgotten} refused track(s); ${restored} returned to the library. They will be re-tagged when the tagger next runs.`);
  res.json({ ok: true, forgotten, restored, pool: poolStatus() });
});

router.post('/settings/spotify/disconnect', requireAdmin, async (req, res) => {
  if (process.env.SPOTIFY_REFRESH_TOKEN && envManaged('SPOTIFY_REFRESH_TOKEN')) {
    return res.status(400).json({ ok: false, error: 'SPOTIFY_REFRESH_TOKEN is managed by the root .env' });
  }
  await saveSecrets({ SPOTIFY_REFRESH_TOKEN: '' });
  spotifyClient().resetToken();
  spotifyPool().invalidate();
  res.json({ ok: true, ...spotifyStatus(req) });
});

// ── Receiver sign-in (librespot) — see music/sources/spotify/receiver-auth.ts ──

export async function receiverStatus() {
  const tok = await readLibrespotToken();
  return {
    tokenPresent: !!tok,
    tokenExpiresAt: tok?.expiresAt ?? null,
    tokenValid: !!tok && tok.expiresAt > Date.now(),
    refreshTokenPresent: !!process.env.SPOTIFY_RECEIVER_REFRESH_TOKEN,
    credentialsCached: existsSync(path.join(LIBRESPOT_CACHE_DIR, 'credentials.json')),
    redirectUri: LIBRESPOT_REDIRECT_URI,
  };
}

router.get('/settings/spotify/receiver', requireAdmin, async (_req, res) => {
  res.json(await receiverStatus());
});

// Step 1: the authorize URL for Spotify's own client id (PKCE).
router.get('/settings/spotify/receiver/auth', requireAdmin, (_req, res) => {
  res.json({ ok: true, ...beginReceiverAuth() });
});

async function completeReceiverSignIn(code: string, state: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  const verifier = takeReceiverVerifier(state);
  if (!verifier) return { ok: false, error: 'no matching sign-in is pending — press "Sign the receiver in" again and use the fresh link' };
  try {
    const tok = await exchangeReceiverCode(code, verifier);
    await writeLibrespotToken(tok.accessToken, tok.expiresAt);
    if (tok.refreshToken) await saveSecrets({ SPOTIFY_RECEIVER_REFRESH_TOKEN: tok.refreshToken });
    queue.log('scheduler', 'Spotify receiver signed in — librespot logs in on its next start (restart the mixer if it is looping)');
    return { ok: true };
  } catch (err: any) {
    queue.log('error', `Spotify receiver sign-in failed: ${err?.message || err}`);
    return { ok: false, error: err?.message || 'exchange failed' };
  }
}

// Step 2a (automatic): Spotify redirects to http://127.0.0.1:5588/login — this
// route, when docker-compose.spotify.yml publishes the controller there. Not
// admin-gated (the redirect carries no header); the PKCE state is the gate.
router.get('/login', async (req, res) => {
  const { code, state, error } = req.query as Record<string, string | undefined>;
  const site = (process.env.SITE_URL || '').trim().replace(/\/+$/, '');
  const back = (q: string) => res.redirect(`${site}/admin/settings?section=music&receiver=${encodeURIComponent(q)}`);
  if (error || !code) return back(`error:${error || 'no-code'}`);
  const r = await completeReceiverSignIn(code, state ?? null);
  return back(r.ok ? 'connected' : `error:${r.error}`);
});

// Step 2b (paste): the landing URL from the browser's address bar, or the code.
router.post('/settings/spotify/receiver/code', requireAdmin, async (req, res) => {
  const parsed = parseReceiverRedirect(String(req.body?.redirectUrl ?? req.body?.code ?? ''));
  if (!parsed) return res.status(400).json({ ok: false, error: 'paste the full http://127.0.0.1:5588/login?code=… URL from the address bar' });
  const r = await completeReceiverSignIn(parsed.code, parsed.state);
  res.status(r.ok ? 200 : 400).json({ ...r, ...(await receiverStatus()) });
});

// Rebuild the pool now (after editing playlists) rather than waiting out the TTL.
// rebuild() rather than invalidate()+get(): an operator pressing this is saying
// they do not trust what is cached, so it forces a FULL walk instead of the
// cheap snapshot_id revalidate a normal refresh does.
router.post('/settings/spotify/pool/refresh', requireAdmin, async (_req, res) => {
  try {
    const p = await spotifyPool().rebuild();
    res.json({ ok: true, tracks: p.tracks.size, albums: p.albums.size, playlists: p.playlists, genres: p.genres.size, partial: p.partial, notes: p.notes });
  } catch (err: any) {
    res.status(502).json({ ok: false, error: err?.message || 'pool build failed' });
  }
});

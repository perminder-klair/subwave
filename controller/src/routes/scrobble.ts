// Admin surface for scrobbling: the "Test" button and the Last.fm connect flow
// (auth.getToken → operator authorizes → auth.getSession), which persists the
// minted session key into settings. The fan-out itself is broadcast/scrobble.ts.
import express from 'express';
import { ADMIN_AUTH_REQUIRED, requireAdmin, requireAdminUi } from '../middleware/auth.js';
import { queue } from '../broadcast/queue.js';
import * as settings from '../settings.js';
import {
  testNowPlaying,
  lastfmGetAuthToken,
  lastfmCompleteAuth,
  personalScrobbleProviders,
  reportPersonalPlayback,
  type ScrobbleProvider,
} from '../broadcast/scrobble.js';
import { personalAiringAt } from '../broadcast/personal-scrobble.js';

export const router = express.Router();

// Unlike ordinary admin routes, personal scrobbling cannot fall through the
// development-mode open gate: without configured credentials there is no
// authenticated listener identity to attribute a play to.
function requirePersonalAdmin(req, res, next) {
  if (!ADMIN_AUTH_REQUIRED) {
    return res.status(503).json({ error: 'admin authentication must be configured' });
  }
  return requireAdminUi(req, res, next);
}

router.get('/scrobble/personal', requirePersonalAdmin, (_req, res) => {
  const providers = personalScrobbleProviders();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ available: providers.length > 0, providers });
});

router.post('/scrobble/personal', requirePersonalAdmin, (req, res) => {
  const playbackId = typeof req.body?.playbackId === 'string' ? req.body.playbackId : '';
  const state = req.body?.state;
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(playbackId)) {
    return res.status(400).json({ error: 'invalid playbackId' });
  }
  if (state !== 'playing' && state !== 'stopped') {
    return res.status(400).json({ error: 'state must be "playing" or "stopped"' });
  }
  const providers = personalScrobbleProviders();
  if (!providers.length) {
    return res.status(409).json({
      error: 'configure Last.fm or ListenBrainz with station-wide scrobbling off before enabling personal scrobbling',
    });
  }
  const nowMs = Date.now();
  const bufferSeconds = Number(settings.get()?.stream?.bufferSeconds) || 0;
  const airing = state === 'playing'
    ? personalAiringAt(queue.current, queue.history, bufferSeconds, nowMs)
    : null;
  const result = reportPersonalPlayback({
    playbackId,
    playing: state === 'playing',
    airing,
    nowMs,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, providers, ...result });
});

router.post('/scrobble/test', requireAdmin, async (req, res) => {
  const provider = req.body?.provider as ScrobbleProvider | undefined;
  if (provider !== 'lastfm' && provider !== 'listenbrainz' && provider !== 'navidrome') {
    return res
      .status(400)
      .json({ error: 'provider must be "lastfm", "listenbrainz" or "navidrome"' });
  }
  // Operators click this before anything is on-air, so say so rather than
  // reporting a silent success.
  const current: any = queue.current?.track || null;
  if (!current) {
    return res.status(409).json({
      ok: false,
      message: 'no track is currently playing — wait for the stream to start one and try again',
    });
  }
  try {
    const result = await testNowPlaying(provider, {
      id: current.id || null,
      title: current.title || null,
      artist: current.artist || null,
      album: current.album || null,
      duration: current.duration ?? null,
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err?.message || 'test failed' });
  }
});

// Step 1: mint a request token. Needs the API key + secret already set.
router.post('/scrobble/lastfm/connect', requireAdmin, async (_req, res) => {
  try {
    const { token, authUrl } = await lastfmGetAuthToken();
    res.json({ ok: true, token, authUrl });
  } catch (err: any) {
    res.status(400).json({ ok: false, message: err?.message || 'could not start Last.fm authorization' });
  }
});

// Step 2: trade the authorized token for a session key and switch scrobbling on.
router.post('/scrobble/lastfm/complete', requireAdmin, async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  try {
    const { sessionKey, username } = await lastfmCompleteAuth(token);
    await settings.update({ scrobble: { lastfm: { sessionKey, username, enabled: true } } });
    res.json({ ok: true, username });
  } catch (err: any) {
    res.status(400).json({ ok: false, message: err?.message || 'could not complete Last.fm authorization' });
  }
});

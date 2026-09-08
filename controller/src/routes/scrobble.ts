// Admin surface for scrobbling: the "Test" button and the Last.fm connect flow
// (auth.getToken → operator authorizes → auth.getSession), which persists the
// minted session key into settings. The fan-out itself is broadcast/scrobble.ts.
import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { queue } from '../broadcast/queue.js';
import * as settings from '../settings.js';
import {
  testNowPlaying,
  lastfmGetAuthToken,
  lastfmCompleteAuth,
  type ScrobbleProvider,
} from '../broadcast/scrobble.js';

export const router = express.Router();

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

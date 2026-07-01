// Admin-gated scrobble endpoints.
//
// The scrobble fan-out itself lives in broadcast/scrobble.ts and consumes
// track events from broadcast/queue.ts. This route exposes the admin surface:
//   - the "Test" button (now-playing ping at a backend, reports the result)
//   - the "Connect to Last.fm" flow (auth.getToken → operator authorizes →
//     auth.getSession), which replaces the CLI `npm run lastfm-session` dance
//     and persists the minted session key straight into settings.
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
  if (provider !== 'lastfm' && provider !== 'listenbrainz') {
    return res.status(400).json({ error: 'provider must be "lastfm" or "listenbrainz"' });
  }
  // Use the live track if there is one. Otherwise the test reports back
  // cleanly — operators tend to click this before anything is on-air, and
  // a 400 with "no current track" reads better than a silent success.
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

// Step 1 of "Connect to Last.fm": mint a request token and return the URL the
// operator opens to grant access. Needs the API key + secret already set.
router.post('/scrobble/lastfm/connect', requireAdmin, async (_req, res) => {
  try {
    const { token, authUrl } = await lastfmGetAuthToken();
    res.json({ ok: true, token, authUrl });
  } catch (err: any) {
    res.status(400).json({ ok: false, message: err?.message || 'could not start Last.fm authorization' });
  }
});

// Step 2: after the operator authorizes in the browser, trade the token for a
// session key, persist it, and switch scrobbling on — no CLI, no copy-paste.
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

// Admin-gated scrobble test endpoint.
//
// The scrobble fan-out itself lives in broadcast/scrobble.ts and consumes
// track events from broadcast/queue.ts. This route only exposes the "Test"
// button in /admin/settings → Scrobbling: fires a now-playing ping at the
// requested backend using the currently-playing track, reports the result.
import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { queue } from '../broadcast/queue.js';
import { testNowPlaying, type ScrobbleProvider } from '../broadcast/scrobble.js';

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

// GET /now-playing/file: the playing file's own format, for the Dash.
//
// Admin-only by choice, not by sensitivity: it is an operator detail, and the
// public /now-playing shape every listener polls stays exactly as it was.
// Answers for the track ON AIR only (no arbitrary-id lookup), so it can never
// become a generic Navidrome proxy. `?id=` names the track the Dash is
// showing, and is only compared: when a different track is on air the answer
// carries that track's id and a null format, with no lookup, so an answer the
// Dash caches under one track is always about that track.
//
//   200 { id: string, format: FileFormat | null }   a library track (format
//                                                    null = Navidrome did not
//                                                    answer, or ?id= named a
//                                                    track no longer on air)
//   200 { id: null, format: null }                   no library song on record:
//                                                    boot before the first one,
//                                                    the stream idled down, or
//                                                    a song with no library id
//
// The track on air is the song now-playing.json names, which is also the
// Dash's title. A jingle, bed or pause-talk break never writes that file, so
// while one airs the answer is still the song before it, as the title is.

import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { queue } from '../broadcast/queue.js';
import * as subsonic from '../music/subsonic.js';
import { createFileFormatLookup, type FileFormat } from '../music/file-format.js';

type NowPlaying = { subsonic_id?: string | null; [k: string]: unknown } | null | undefined;

export function createNowPlayingFileRouter(deps: {
  nowPlaying: () => Promise<NowPlaying>;
  lookup: (id: string) => Promise<FileFormat | null>;
}): Router {
  const router = Router();
  router.get('/now-playing/file', requireAdmin, async (req, res) => {
    let id: string | null = null;
    try {
      const np = await deps.nowPlaying();
      id = typeof np?.subsonic_id === 'string' && np.subsonic_id ? np.subsonic_id : null;
    } catch { /* treated as nothing on air */ }
    const asked = typeof req.query.id === 'string' && req.query.id ? req.query.id : null;
    if (!id || (asked && asked !== id)) {
      res.json({ id, format: null });
      return;
    }
    let format: FileFormat | null = null;
    try { format = await deps.lookup(id); } catch { /* null: the lookup fails open */ }
    res.json({ id, format });
  });
  return router;
}

export const router = createNowPlayingFileRouter({
  nowPlaying: () => queue.getNowPlaying(),
  lookup: createFileFormatLookup({ getSong: subsonic.getSong }),
});

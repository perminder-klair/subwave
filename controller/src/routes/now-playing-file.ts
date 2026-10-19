// GET /now-playing/file: the playing file's own format, for the Dash.
//
// Admin-only by choice, not by sensitivity: it is an operator detail, and the
// public /now-playing shape every listener polls stays exactly as it was.
// Answers for the track ON AIR only (no arbitrary-id lookup), so it can never
// become a generic Navidrome proxy. `id` comes back with the format, so the
// Dash can tell an answer about the previous track from one about this one.
//
//   200 { id: string, format: FileFormat | null }   a library track (format
//                                                    null = Navidrome did not
//                                                    answer; retried later)
//   200 { id: null, format: null }                   nothing from the library
//                                                    on air (jingle, bed, boot)

import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { createFileFormatLookup, type FileFormat } from '../music/file-format.js';

type NowPlaying = { subsonic_id?: string | null; [k: string]: unknown } | null | undefined;

export function createNowPlayingFileRouter(deps: {
  nowPlaying: () => Promise<NowPlaying>;
  lookup: (id: string) => Promise<FileFormat | null>;
}): Router {
  const router = Router();
  router.get('/now-playing/file', requireAdmin, async (_req, res) => {
    let id: string | null = null;
    try {
      const np = await deps.nowPlaying();
      id = typeof np?.subsonic_id === 'string' && np.subsonic_id ? np.subsonic_id : null;
    } catch { /* treated as nothing on air */ }
    if (!id) {
      res.json({ id: null, format: null });
      return;
    }
    let format: FileFormat | null = null;
    try { format = await deps.lookup(id); } catch { /* null: the lookup fails open */ }
    res.json({ id, format });
  });
  return router;
}

// The live wiring, imported lazily so the factory above (and its test) never
// loads the queue.
export const router = Router();
let live: Router | null = null;
router.use(async (req, res, next) => {
  if (!live) {
    const [{ queue }, subsonic] = await Promise.all([
      import('../broadcast/queue.js'),
      import('../music/subsonic.js'),
    ]);
    live = createNowPlayingFileRouter({
      nowPlaying: () => queue.getNowPlaying(),
      lookup: createFileFormatLookup({ getSong: subsonic.getSong }),
    });
  }
  live(req, res, next);
});

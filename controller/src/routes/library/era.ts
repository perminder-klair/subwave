// Era review: the operator surface for era-suspect albums. The walk
// stores each track's era reason and album artist; this exposes the grouped
// listing the Library → Era tab reads, the per-album override that takes
// effect immediately (and again on every walk), and the CSV export.
// The judgement itself is music/era-suspect.ts; the storage is
// music/era-review.ts and library-db/schema.ts ensureNamedColumns (the era columns and era_override).
import express from 'express';
import { requireAdmin } from '../../middleware/auth.js';
import * as db from '../../music/library-db.js';
import {
  albumEraKey, albumScanned, countEraSummary, exportEraCsv, listEraAlbums, listEraAlbumTracks,
  setEraKind, setEraOverride, type EraVerdict,
} from '../../music/era-review.js';
import { ALBUM_KINDS, isAlbumKind, type AlbumKind } from '../../music/album-kind.js';
import type { z } from 'zod';
import { eraOverrideSchema } from '../../schemas/library.js';
import { validateBodyAsync } from '../../middleware/validate.js';

type EraOverrideBody = z.output<ReturnType<typeof eraOverrideSchema>>;

export const router = express.Router();

// A live handle or a 503: every era route reads the mirror, and a controller
// booting without a library answers the same way the other library reads do.
function handle(res: express.Response) {
  const d = db.getDb();
  if (!d) {
    res.status(503).json({ error: 'library database not open' });
    return null;
  }
  return d;
}

router.get('/library/era', requireAdmin, (_req, res) => {
  const d = handle(res);
  if (!d) return;
  try {
    res.json({ summary: countEraSummary(d), albums: listEraAlbums(d) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Every per-album route names the album as { album, albumArtist? } and the key
// is computed here, never taken from the client: one fold, one implementation
// (era-review.albumEraKey). An album the walk has not judged since the update
// has no stored album artist yet, so a record keyed now would be orphaned by
// the next scan: 409 until a scan has run.
function albumKeyOf(res: express.Response, d: NonNullable<ReturnType<typeof db.getDb>>, src: Record<string, unknown>): string | null {
  const { album, albumArtist } = src;
  if (typeof album !== 'string' || album.trim() === '') {
    res.status(400).json({ error: 'album is required' });
    return null;
  }
  if (albumArtist != null && typeof albumArtist !== 'string') {
    res.status(400).json({ error: 'albumArtist must be a string when present' });
    return null;
  }
  const key = albumEraKey(albumArtist as string | null | undefined, album);
  if (!albumScanned(d, key)) {
    res.status(409).json({ error: 'This album has not been scanned since the update. Run a library scan (Reconcile) first.' });
    return null;
  }
  return key;
}

// Body: { album, albumArtist?, verdict: 'trusted' | 'year' | 'suspect' | null,
// year? }. 'year' needs `year` (applied to every track as its manual original
// year); `verdict: null` removes the decision and restores the walk's own.
router.post(
  '/library/era/override',
  requireAdmin,
  // The decision and its year (schemas/library.ts eraOverrideSchema): the one
  // year window, per request so it moves with the calendar.
  validateBodyAsync(() => eraOverrideSchema(), { messages: 'verbatim' }),
  (req, res) => {
  const d = handle(res);
  if (!d) return;
  const body = req.body as EraOverrideBody;
  const { verdict, year } = body;
  const key = albumKeyOf(res, d, body);
  if (!key) return;
  try {
    const affected = setEraOverride(d, key, verdict as EraVerdict | null, { year });
    res.json({ ok: true, affected });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
  },
);

// Body: { album, albumArtist?, kind: <ALBUM_KINDS id> | null }. null goes back
// to the title's suggestion.
router.post('/library/era/kind', requireAdmin, (req, res) => {
  const d = handle(res);
  if (!d) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { kind } = body;
  if (kind !== null && !isAlbumKind(kind)) {
    return res.status(400).json({ error: `kind must be one of: ${ALBUM_KINDS.join(', ')}, or null` });
  }
  const key = albumKeyOf(res, d, body);
  if (!key) return;
  try {
    const affected = setEraKind(d, key, kind as AlbumKind | null);
    res.json({ ok: true, affected });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ?album=&albumArtist= — one album's tracks, for the per-track year editor.
router.get('/library/era/album', requireAdmin, (req, res) => {
  const d = handle(res);
  if (!d) return;
  const q = req.query as Record<string, unknown>;
  const key = albumKeyOf(res, d, { album: q.album, albumArtist: typeof q.albumArtist === 'string' && q.albumArtist !== '' ? q.albumArtist : null });
  if (!key) return;
  try {
    res.json({ tracks: listEraAlbumTracks(d, key) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// RFC4180 CSV of every track on an era-suspect album (same selection as the
// listing), as an attachment.
router.get('/library/era/csv', requireAdmin, (_req, res) => {
  const d = handle(res);
  if (!d) return;
  try {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="era-suspects.csv"');
    res.send(exportEraCsv(d));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

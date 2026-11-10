// Admin-gated index + download of the hourly broadcast archives that
// Liquidsoap writes under state/archive/. See broadcast/archives.ts for the
// on-disk layout.
import express from 'express';
import { statSync } from 'node:fs';
import { pipeline } from 'node:stream';
import { requireAdmin } from '../middleware/auth.js';
import { list, resolveEntry, openStream, clearAll } from '../broadcast/archives.js';
import { queue } from '../broadcast/queue.js';

export const router = express.Router();

router.get('/archives', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? ''), 10) || 500, 5000);
    res.json({ archives: await list({ limit }) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Collection-level DELETE only (no per-file delete). Safe on air — see clearAll().
router.delete('/archives', requireAdmin, async (_req, res) => {
  try {
    const result = await clearAll();
    queue.log('scheduler', `archive cleared — ${result.removed} hour(s), ${result.bytes} bytes freed`);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Forces a download rather than inline playback: an hour-long MP3 played inline
// reads as if it were the live stream. pipeline(), not pipe(): a read error
// must answer the request rather than escape as an uncaught stream error, and a
// client that disconnects mid-download must release the file handle.
router.get('/archives/file/:date/:hour', requireAdmin, (req, res) => {
  const rel = `${req.params.date}/${req.params.hour}`;
  const abs = resolveEntry(rel);
  if (!abs) return res.status(404).json({ error: 'archive not found' });
  let size: number;
  try {
    const st = statSync(abs);
    if (!st.isFile()) return res.status(404).json({ error: 'archive not found' });
    size = st.size;
  } catch {
    // Removed between resolveEntry and here (retention sweep, Clear archive).
    return res.status(404).json({ error: 'archive not found' });
  }
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Length', String(size));
  res.setHeader('Content-Disposition', `attachment; filename="${rel.replace('/', '_')}"`);
  if (size === 0) return res.end();
  // An open failure can still be answered with a status. From 'ready' on,
  // pipeline() owns both ends: a later read error or a client disconnect
  // destroys them, so the download is cut short and the handle released.
  const src = openStream(abs, { end: size - 1 });
  const onOpenError = () => {
    if (res.headersSent) return res.destroy();
    res.removeHeader('Content-Length');
    res.removeHeader('Content-Disposition');
    res.status(500).json({ error: 'archive read failed' });
  };
  src.once('error', onOpenError);
  src.once('ready', () => {
    src.off('error', onOpenError);
    pipeline(src, res, () => {});
  });
});

// Admin-gated index + download of the hourly broadcast archives that
// Liquidsoap writes under state/archive/. See broadcast/archives.ts for the
// on-disk layout.
import express from 'express';
import { statSync } from 'node:fs';
import { requireAdmin } from '../middleware/auth.js';
import { list, resolveEntry, openStream } from '../broadcast/archives.js';

export const router = express.Router();

router.get('/archives', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? ''), 10) || 500, 5000);
    res.json({ archives: await list({ limit }) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Stream the MP3 to the browser. Forces a download — listeners shouldn't be
// confused into thinking these are live, and inline playback for hour-long
// MP3s is awkward in browsers anyway.
router.get('/archives/file/:date/:hour', requireAdmin, (req, res) => {
  const rel = `${req.params.date}/${req.params.hour}`;
  const abs = resolveEntry(rel);
  if (!abs) return res.status(404).json({ error: 'archive not found' });
  const st = statSync(abs);
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Length', String(st.size));
  res.setHeader('Content-Disposition', `attachment; filename="${rel.replace('/', '_')}"`);
  openStream(abs).pipe(res);
});

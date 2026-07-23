// Admin-gated bed library management — the instrumental beds the DJ talks over
// between songs (see broadcast/beds.ts + broadcast/bed-policy.ts).
//
// No generate route, unlike /sfx: a stinger can be rendered from a text prompt,
// a bed can't. Upload is the only way in beyond the bundled default.
import express from 'express';
import * as beds from '../broadcast/beds.js';
import { queue } from '../broadcast/queue.js';
import { requireAdmin } from '../middleware/auth.js';
import { audioUpload } from '../middleware/upload.js';
import { audioContentType } from '../audio/audio-import.js';

export const router = express.Router();

router.get('/beds', requireAdmin, async (req, res) => {
  try {
    res.json({ beds: await beds.list(), minDurationSec: beds.MIN_DURATION_SEC });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import an operator-supplied audio file as a bed (multipart `file`, `name`,
// optional `description`). The length gate lives in beds.importAudio — a bed
// that can't outlast a script is rejected there with a real reason.
router.post('/beds/upload', requireAdmin, audioUpload('file'), async (req, res) => {
  const file = req.file;
  const name = (req.body?.name || '').trim();
  const description = (req.body?.description || '').trim();
  if (!file) return res.status(400).json({ error: 'file is required' });
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const created = await beds.importAudio(file.buffer, {
      name,
      description,
      originalName: file.originalname,
    });
    queue.log('scheduler', `Bed imported: "${created.name}" (${Math.round(created.durationSec)}s)`);
    res.json(created);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/beds/:name', requireAdmin, async (req, res) => {
  try {
    res.json(await beds.remove(req.params.name));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin preview — streams the bed so the operator can audition what the DJ
// would be talking over. The whole risk of this feature is taste, so hearing it
// before enabling it matters more than usual.
router.get('/beds/:name/audio', requireAdmin, async (req, res) => {
  try {
    const filePath = await beds.getPath(req.params.name);
    if (!filePath) return res.status(404).json({ error: 'unknown bed' });
    res.type(audioContentType(filePath)).sendFile(filePath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

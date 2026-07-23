// Admin-gated bed library management — the instrumental beds the DJ talks over
// between songs (see broadcast/beds.ts + broadcast/bed-policy.ts).
//
// Three ways a bed gets in: the bundled default (a protected built-in), an
// upload, or generation via the ElevenLabs Music API (POST /beds). Generation
// uses /v1/music rather than the sfx sound-generation endpoint because a bed
// needs ≥30s of instrumental music (see beds.create / audio/bed-gen.ts).
import express from 'express';
import * as beds from '../broadcast/beds.js';
import { BED_GEN_MAX_SEC } from '../audio/bed-gen.js';
import { isConfigured } from '../audio/elevenlabs.js';
import { queue } from '../broadcast/queue.js';
import { requireAdmin } from '../middleware/auth.js';
import { audioUpload } from '../middleware/upload.js';
import { audioContentType } from '../audio/audio-import.js';

export const router = express.Router();

router.get('/beds', requireAdmin, async (req, res) => {
  try {
    res.json({
      beds: await beds.list(),
      minDurationSec: beds.MIN_DURATION_SEC,
      maxGenDurationSec: BED_GEN_MAX_SEC,
      generatorReady: isConfigured(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generate a bed from a text prompt via the ElevenLabs Music API. Mirrors
// POST /sfx; validation → 400, generation failure → 500.
router.post('/beds', requireAdmin, async (req, res) => {
  const name = (req.body?.name || '').trim();
  const description = (req.body?.description || '').trim();
  const prompt = (req.body?.prompt || '').trim();
  const durationSec = req.body?.durationSec;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });
  if (prompt.length > 500) return res.status(400).json({ error: 'prompt too long (max 500)' });
  if (durationSec != null && durationSec !== '') {
    const d = Number(durationSec);
    if (!Number.isFinite(d) || d <= 0) return res.status(400).json({ error: 'durationSec must be a positive number' });
    if (d < beds.MIN_DURATION_SEC) return res.status(400).json({ error: `durationSec must be at least ${beds.MIN_DURATION_SEC}s` });
    if (d > BED_GEN_MAX_SEC) return res.status(400).json({ error: `durationSec is capped at ${BED_GEN_MAX_SEC}s` });
  }
  try {
    const created = await beds.create({ name, description, prompt, durationSec });
    queue.log('scheduler', `New bed generated: "${created.name}" (${Math.round(created.durationSec)}s)`);
    res.json(created);
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

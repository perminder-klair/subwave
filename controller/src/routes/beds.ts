// Admin-gated bed library — the instrumental beds the DJ talks over between
// songs. A bed arrives as the bundled default, an upload, or a generation via
// the ElevenLabs Music API (/v1/music, not the sfx endpoint — a bed needs ≥30s).
import express from 'express';
import * as beds from '../broadcast/beds.js';
import { BED_GEN_MAX_SEC } from '../audio/bed-gen.js';
import { isConfigured } from '../audio/elevenlabs.js';
import { queue } from '../broadcast/queue.js';
import { requireAdmin } from '../middleware/auth.js';
import { audioUpload } from '../middleware/upload.js';
import { validateBody } from '../middleware/validate.js';
import { bedCreateSchema, imagingImportSchema } from '../schemas/imaging.js';
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

// Validation → 400, generation failure → 500.
router.post('/beds', requireAdmin, validateBody(bedCreateSchema), async (req, res) => {
  const { name, description, prompt, durationSec } = req.body as {
    name: string; description: string; prompt: string; durationSec?: number;
  };
  try {
    const created = await beds.create({ name, description, prompt, durationSec });
    queue.log('scheduler', `New bed generated: "${created.name}" (${Math.round(created.durationSec)}s)`);
    res.json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The length gate lives in beds.importAudio. validateBody must run AFTER
// audioUpload — multer parses the multipart body and the middleware replaces
// req.body only.
router.post('/beds/upload', requireAdmin, audioUpload('file'), validateBody(imagingImportSchema), async (req, res) => {
  const file = req.file;
  const { name, description } = req.body as { name: string; description: string };
  if (!file) return res.status(400).json({ error: 'file is required' });
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

router.get('/beds/:name/audio', requireAdmin, async (req, res) => {
  try {
    const filePath = await beds.getPath(req.params.name);
    if (!filePath) return res.status(404).json({ error: 'unknown bed' });
    res.type(audioContentType(filePath)).sendFile(filePath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

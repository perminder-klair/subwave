// Admin-gated sound-effects library management — the curated stingers the
// segment-director agent can play under its voice (see broadcast/sfx.js).
import express from 'express';
import * as sfx from '../broadcast/sfx.js';
import { isConfigured } from '../audio/sfx-gen.js';
import { queue } from '../broadcast/queue.js';
import { requireAdmin } from '../middleware/auth.js';
import { audioUpload } from '../middleware/upload.js';
import { validateBody } from '../middleware/validate.js';
import { imagingImportSchema, sfxCreateSchema } from '../schemas/imaging.js';
import { audioContentType } from '../audio/audio-import.js';

export const router = express.Router();

router.get('/sfx', requireAdmin, async (req, res) => {
  try {
    res.json({ sfx: await sfx.list(), generatorReady: isConfigured() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sfx', requireAdmin, validateBody(sfxCreateSchema), async (req, res) => {
  const { name, description, prompt, durationSec } = req.body as {
    name: string; description: string; prompt: string; durationSec?: number;
  };
  try {
    const created = await sfx.create({ name, description, prompt, durationSec });
    queue.log('scheduler', `New sound effect created: "${created.name}"`);
    res.json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// validateBody must sit AFTER audioUpload, both ways: multer is what parses the
// multipart body into req.body, and the middleware replaces req.body ONLY.
router.post('/sfx/upload', requireAdmin, audioUpload('file'), validateBody(imagingImportSchema), async (req, res) => {
  const file = req.file;
  const { name, description } = req.body as { name: string; description: string };
  if (!file) return res.status(400).json({ error: 'file is required' });
  try {
    const created = await sfx.importAudio(file.buffer, {
      name,
      description,
      originalName: file.originalname,
    });
    queue.log('scheduler', `Sound effect imported: "${created.name}"`);
    res.json(created);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/sfx/:name', requireAdmin, async (req, res) => {
  try {
    res.json(await sfx.remove(req.params.name));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/sfx/:name/audio', requireAdmin, async (req, res) => {
  try {
    const filePath = await sfx.getPath(req.params.name);
    if (!filePath) return res.status(404).json({ error: 'unknown sound effect' });
    res.type(audioContentType(filePath)).sendFile(filePath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual trigger, so it ignores the settings.sfx.enabled autonomy toggle like
// every explicit operator press.
router.post('/sfx/:name/play', requireAdmin, async (req, res) => {
  try {
    if (!(await sfx.getPath(req.params.name))) {
      const names = (await sfx.list()).map(e => e.name).join(', ');
      return res.status(404).json({ error: `unknown sound effect: ${req.params.name}${names ? `. Available: ${names}` : ''}` });
    }
    await queue.playSfx(req.params.name);
    res.json({ ok: true, name: req.params.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

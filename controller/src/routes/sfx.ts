// Admin-gated sound-effects library management — the curated stingers the
// segment-director agent can play under its voice (see broadcast/sfx.js).
import express from 'express';
import * as sfx from '../broadcast/sfx.js';
import { isConfigured } from '../audio/sfx-gen.js';
import { queue } from '../broadcast/queue.js';
import { requireAdmin } from '../middleware/auth.js';
import { audioUpload } from '../middleware/upload.js';
import { audioContentType } from '../audio/audio-import.js';

export const router = express.Router();

router.get('/sfx', requireAdmin, async (req, res) => {
  try {
    res.json({ sfx: await sfx.list(), generatorReady: isConfigured() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sfx', requireAdmin, async (req, res) => {
  const name = (req.body?.name || '').trim();
  const description = (req.body?.description || '').trim();
  const prompt = (req.body?.prompt || '').trim();
  const durationSec = req.body?.durationSec;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });
  if (prompt.length > 500) return res.status(400).json({ error: 'prompt too long (max 500)' });
  try {
    const created = await sfx.create({ name, description, prompt, durationSec });
    queue.log('scheduler', `New sound effect created: "${created.name}"`);
    res.json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import an operator-supplied audio file as a sound effect (multipart `file`,
// `name`, optional `description`). No ElevenLabs key needed — this is the
// upload path that complements prompt-based generation.
router.post('/sfx/upload', requireAdmin, audioUpload('file'), async (req, res) => {
  const file = req.file;
  const name = (req.body?.name || '').trim();
  const description = (req.body?.description || '').trim();
  if (!file) return res.status(400).json({ error: 'file is required' });
  if (!name) return res.status(400).json({ error: 'name is required' });
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

// Admin preview — streams the rendered MP3 so the operator can audition an
// effect before letting the agent reach for it.
router.get('/sfx/:name/audio', requireAdmin, async (req, res) => {
  try {
    const filePath = await sfx.getPath(req.params.name);
    if (!filePath) return res.status(404).json({ error: 'unknown sound effect' });
    res.type(audioContentType(filePath)).sendFile(filePath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

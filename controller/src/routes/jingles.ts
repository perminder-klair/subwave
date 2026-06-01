// Admin-gated jingle management (pre-recorded TTS stingers) and the
// kick-off endpoint for the background library tagger.
import express from 'express';
import * as jingles from '../broadcast/jingles.js';
import { queue } from '../broadcast/queue.js';
import { requireAdmin } from '../middleware/auth.js';
import { tagger, startTagger, stopTagger } from '../broadcast/tagger.js';

export const router = express.Router();

// ---------------------------------------------------------------------------
// JINGLES — list / create / delete pre-recorded TTS stingers
// ---------------------------------------------------------------------------
router.get('/jingles', requireAdmin, async (req, res) => {
  try {
    res.json({ jingles: await jingles.list() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/jingles', requireAdmin, async (req, res) => {
  const text = (req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  if (text.length > 500) return res.status(400).json({ error: 'text too long (max 500)' });
  try {
    const created = await jingles.create(text);
    queue.log('scheduler', `New jingle created: "${text.slice(0, 60)}…"`);
    res.json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/jingles/:filename', requireAdmin, async (req, res) => {
  try {
    res.json(await jingles.remove(req.params.filename));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin preview — streams the rendered WAV so the operator can audition a
// jingle before it goes on air. Resolved through jingles.getPath so the
// filename has to match a sidecar entry (no path traversal).
router.get('/jingles/:filename/audio', requireAdmin, async (req, res) => {
  try {
    const filePath = await jingles.getPath(req.params.filename);
    if (!filePath) return res.status(404).json({ error: 'unknown jingle' });
    res.type('audio/wav').sendFile(filePath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// TAG-LIBRARY — kick off the tagger as a background child process.
// Polls /settings to see progress (library.total grows; tagger.running flips).
// ---------------------------------------------------------------------------
router.post('/tag-library', requireAdmin, (req, res) => {
  if (tagger.running) return res.status(409).json({ error: 'tagger already running', tagger });
  const limit = parseInt(req.body?.limit, 10);
  const reseed = req.body?.reseed === true;
  startTagger({ limit: Number.isFinite(limit) ? limit : undefined, reseed });
  res.json({ ok: true, tagger });
});

// Stop the running tagger child (SIGTERM). Returns 409 if no run is active.
router.post('/tag-library/stop', requireAdmin, (req, res) => {
  if (!tagger.running) return res.status(409).json({ error: 'tagger is not running', tagger });
  const result = stopTagger();
  res.json({ ...result, tagger });
});

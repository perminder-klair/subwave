// Admin-gated voice-clone library — the reference WAVs Chatterbox and PocketTTS
// clone from (a persona's `tts.voice` is one of these filenames). Files dropped
// into state/voices/ by hand are still listed.
import express from 'express';
import * as voices from '../audio/voice-library.js';
import { config } from '../config.js';
import { queue } from '../broadcast/queue.js';
import { requireAdmin } from '../middleware/auth.js';
import { audioUpload } from '../middleware/upload.js';
import { validateBody } from '../middleware/validate.js';
import { voiceImportSchema } from '../schemas/imaging.js';
import { audioContentType, hasFfmpeg } from '../audio/audio-import.js';

export const router = express.Router();

// `ffmpeg: false` (bare-host dev box) means only .wav will be accepted.
router.get('/voices', requireAdmin, async (req, res) => {
  try {
    res.json({
      voices: await voices.list(),
      dir: config.voices.dir,
      legacyDir: config.voices.legacyDir,
      ffmpeg: await hasFfmpeg(),
      advisory: { minSec: voices.ADVISORY_MIN_SEC, maxSec: voices.ADVISORY_MAX_SEC },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Transcoded to the canonical mono 24 kHz WAV; every rejection is an
// operator-fixable 400. validateBody must run AFTER audioUpload — multer parses
// the multipart body and the middleware replaces req.body only.
router.post('/voices/upload', requireAdmin, audioUpload('file'), validateBody(voiceImportSchema), async (req, res) => {
  const file = req.file;
  const { name } = req.body as { name: string };
  if (!file) return res.status(400).json({ error: 'file is required' });
  try {
    const created = await voices.importVoice(file.buffer, {
      name,
      originalName: file.originalname,
    });
    queue.log('scheduler', `Voice imported: "${created.file}"`);
    res.json(created);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// No in-use guard by design: a persona pointing at a deleted file shows a
// `missing` hint and the workers fall back to their built-in voice.
router.delete('/voices/:file', requireAdmin, async (req, res) => {
  try {
    res.json(await voices.removeVoice(req.params.file));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// `:file` is resolved through the library's scan, never interpolated into a
// path, so anything unlisted 404s rather than reaching the filesystem.
router.get('/voices/:file/audio', requireAdmin, async (req, res) => {
  try {
    const entry = await voices.resolve(req.params.file);
    if (!entry) return res.status(404).json({ error: 'unknown voice' });
    res.type(audioContentType(entry.path)).sendFile(entry.path);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

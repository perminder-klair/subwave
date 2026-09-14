// Admin-gated jingle management (pre-recorded TTS stingers) and the
// kick-off endpoint for the background library tagger.
import express from 'express';
import * as jingles from '../broadcast/jingles.js';
import { queue } from '../broadcast/queue.js';
import { requireAdmin } from '../middleware/auth.js';
import { audioUpload } from '../middleware/upload.js';
import { validateBody } from '../middleware/validate.js';
import { jingleCreateSchema, jingleImportSchema } from '../schemas/imaging.js';
import { audioContentType } from '../audio/audio-import.js';
import { tagger, startTagger, stopTagger } from '../broadcast/tagger.js';

export const router = express.Router();

router.get('/jingles', requireAdmin, async (req, res) => {
  try {
    res.json({ jingles: await jingles.list() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/jingles', requireAdmin, validateBody(jingleCreateSchema), async (req, res) => {
  const { text } = req.body as { text: string };
  try {
    const created = await jingles.create(text);
    queue.log('scheduler', `New jingle created: "${text.slice(0, 60)}…"`);
    res.json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// validateBody must run AFTER audioUpload: multer parses the multipart body, and
// the middleware replaces req.body only, leaving req.file untouched.
router.post('/jingles/upload', requireAdmin, audioUpload('file'), validateBody(jingleImportSchema), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'file is required' });
  try {
    const created = await jingles.importAudio(file.buffer, {
      label: (req.body as { label?: string }).label,
      originalName: file.originalname,
    });
    queue.log('scheduler', `Jingle imported: "${created.text.slice(0, 60)}…"`);
    res.json(created);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/jingles/:filename', requireAdmin, async (req, res) => {
  try {
    res.json(await jingles.remove(req.params.filename));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Resolved through jingles.getPath so the filename must match a sidecar entry
// (no path traversal).
router.get('/jingles/:filename/audio', requireAdmin, async (req, res) => {
  try {
    const filePath = await jingles.getPath(req.params.filename);
    if (!filePath) return res.status(404).json({ error: 'unknown jingle' });
    res.type(audioContentType(filePath)).sendFile(filePath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Airs a jingle on the music chain at full level, with no length cap (unlike
// /sfx/:name/play, which ducks under the programme and is capped). Manual
// trigger, so it ignores jingleRatio. Queued, not immediate: it takes the next
// safe track boundary, deferring behind speech or a bed/track pair.
router.post('/jingles/:filename/play', requireAdmin, async (req, res) => {
  try {
    if (!(await jingles.getPath(req.params.filename))) {
      const names = (await jingles.list()).map(j => j.filename).join(', ');
      return res.status(404).json({ error: `unknown jingle: ${req.params.filename}${names ? `. Available: ${names}` : ''}` });
    }
    const result = await queue.playJingle(req.params.filename);
    if (!result.ok) {
      // Not a rate limit: the priority queue has no remove path, so a retried
      // call would air the same announcement twice.
      const msg = result.reason === 'already-queued'
        ? `"${req.params.filename}" is already queued and hasn't aired yet`
        : 'too many jingles are already queued and haven\'t aired yet';
      return res.status(409).json({ error: msg, reason: result.reason });
    }
    res.json({ ok: true, filename: req.params.filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Kicks off the tagger as a background child; callers poll /settings for progress.
router.post('/tag-library', requireAdmin, (req, res) => {
  if (tagger.running) return res.status(409).json({ error: 'tagger already running', tagger });
  const limit = parseInt(req.body?.limit, 10);
  const reseed = req.body?.reseed === true;
  const reEnrich = req.body?.reEnrich === true;
  const reAnalyze = req.body?.reAnalyze === true;
  const upgrade = req.body?.upgrade === true;
  // "Re-embed, then continue tagging". Only acted on when reseed is the sole re-*
  // pass, which startTagger enforces.
  const thenTag = req.body?.thenTag === true;
  // Only an explicit boolean is forwarded; undefined means that phase runs, so
  // callers that send no steps get a full run.
  const stepBool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
  startTagger({
    limit: Number.isFinite(limit) ? limit : undefined,
    reseed,
    reEnrich,
    reAnalyze,
    upgrade,
    thenTag,
    reconcile: stepBool(req.body?.reconcile),
    enrich: stepBool(req.body?.enrich),
    tagMoods: stepBool(req.body?.tagMoods),
    analyze: stepBool(req.body?.analyze),
    vocal: stepBool(req.body?.vocal),
  });
  res.json({ ok: true, tagger });
});

router.post('/tag-library/stop', requireAdmin, (req, res) => {
  if (!tagger.running) return res.status(409).json({ error: 'tagger is not running', tagger });
  const result = stopTagger();
  res.json({ ...result, tagger });
});

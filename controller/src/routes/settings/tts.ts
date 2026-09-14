// Voice preview and the voice catalogue for the on-air engines.
// Part of the settings/ route split - see ../settings.ts.

import express from 'express';
import { readFile, unlink } from 'node:fs/promises';
import { extname } from 'node:path';
import * as settings from '../../settings.js';
import * as tts from '../../audio/tts.js';
import * as speech from '../../llm/speech.js';
import { requireAdmin } from '../../middleware/auth.js';

// Mounted onto the parent settings router in ../settings.ts.
export const router = express.Router();

// Auditions an EXPLICIT engine + voice, not the on-air persona. `corrections`,
// `voiceSettings` and `fishSettings` are UNSAVED overrides for this call only
// (#696); synthesizeSample sanitizes and clamps them like settings.update() does.
// A synth failure returns 422 rather than falling back to Piper, so the operator
// sees why. The temp file is unlinked once sent.
router.post('/settings/tts/preview', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const engine = typeof body.engine === 'string' ? body.engine : '';
  if (!engine || !tts.ENGINES.includes(engine)) {
    return res.status(400).json({ ok: false, message: `Unknown engine: ${engine || '(none)'}` });
  }
  // Carry a client disconnect into the provider call so a discarded preview does
  // not continue as invisible metered synthesis. `close` also fires after a
  // normal send, where writableEnded makes the abort a no-op.
  const previewAbort = new AbortController();
  const abortOnDisconnect = () => {
    if (!res.writableEnded) previewAbort.abort();
  };
  res.once('close', abortOnDisconnect);
  let filePath: string | null = null;
  try {
    filePath = await tts.synthesizeSample({
      engine,
      voice: typeof body.voice === 'string' ? body.voice : '',
      cloudProvider: typeof body.cloudProvider === 'string' ? body.cloudProvider : 'openai',
      cloudModel: typeof body.cloudModel === 'string' ? body.cloudModel : undefined,
      speed: typeof body.speed === 'number' ? body.speed : undefined,
      lang: typeof body.lang === 'string' ? body.lang : undefined,
      language: typeof body.language === 'string' ? body.language : undefined,
      text: typeof body.text === 'string' ? body.text : undefined,
      corrections: Array.isArray(body.corrections) ? body.corrections : undefined,
      voiceSettings: (body.voiceSettings && typeof body.voiceSettings === 'object')
        ? body.voiceSettings
        : undefined,
      fishSettings: (body.fishSettings && typeof body.fishSettings === 'object')
        ? body.fishSettings
        : undefined,
      signal: previewAbort.signal,
    });
    const buf = await readFile(filePath);
    // Local engines render WAV, cloud renders MP3; take the MIME from the file.
    res.type(extname(filePath) || '.wav').send(buf);
  } catch (err: unknown) {
    if (!previewAbort.signal.aborted && !res.destroyed) {
      res.status(422).json({ ok: false, message: (err as { message?: string })?.message || 'Preview synthesis failed' });
    }
  } finally {
    res.off('close', abortOnDisconnect);
    if (filePath) unlink(filePath).catch(() => {});
  }
});

// Discovers the voices a cloud TTS provider offers. `baseUrl` rides in on the
// query (it may be unsaved); the API key deliberately does NOT, so it cannot leak
// into access logs or history — discovery works only once the key is saved.
// Always 200s with { ok, voices, provider, error? }: an unreachable server is a
// normal answer and the UI falls back to free text.
router.get('/settings/tts/voices', requireAdmin, async (req, res) => {
  const provider = String(req.query.provider || '').trim();
  if (!provider) {
    return res.json({ ok: false, voices: [], provider: '', error: 'provider is required' });
  }
  const baseUrl = String(req.query.baseUrl || '').trim();
  await settings.load();
  const cloud = settings.get().tts?.cloud || {};

  // Same precedence as cloud-speech.isConfigured(): a key typed into Settings
  // counts only for the provider it was entered against, else the env var.
  const envKey = provider === 'elevenlabs'
    ? process.env.ELEVENLABS_API_KEY
    : provider === 'fish-audio'
      ? process.env.FISH_API_KEY
      : provider === 'openai-compatible'
        ? ''
        : process.env.OPENAI_API_KEY;
  // Fish never reads the legacy shared inline key slot; env/secrets.env only.
  const settingsKey = provider === 'openai-compatible'
    ? cloud.compatApiKey || (cloud.provider === 'openai-compatible' ? cloud.apiKey : '')
    : provider !== 'fish-audio' && provider === cloud.provider
      ? cloud.apiKey
      : '';
  const apiKey = (settingsKey || envKey || '').trim();

  // Backstop only: listVoices' own 10s/8s budgets should fire first so the caller
  // gets a real reason instead of a bare abort.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const result = await speech.listVoices({
      provider,
      baseUrl: baseUrl || cloud.baseUrl || '',
      apiKey,
      signal: ctrl.signal,
    });
    res.json({ ...result, provider });
  } finally {
    clearTimeout(timer);
  }
});



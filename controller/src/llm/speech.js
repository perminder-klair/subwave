// Cloud TTS engine — generates a voice file via the AI SDK's speech models
// (OpenAI or ElevenLabs). Sits behind tts.js as the `cloud` engine, peer to
// the local `piper` and `kokoro` engines.
//
// The AI SDK has no provider for Piper or Kokoro (they're local CLIs), so
// this only covers cloud voices — tts.js still owns the dispatch + fallback.

import { experimental_generateSpeech as generateSpeech } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createElevenLabs } from '@ai-sdk/elevenlabs';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import * as settings from '../settings.js';

function cloudCfg() {
  return settings.get().tts?.cloud || {};
}

function speechModel(c) {
  if (c.provider === 'elevenlabs') {
    const provider = createElevenLabs(c.apiKey ? { apiKey: c.apiKey } : {});
    return provider.speech(c.model);
  }
  const provider = createOpenAI(c.apiKey ? { apiKey: c.apiKey } : {});
  return provider.speech(c.model);
}

// True when the cloud engine has a usable key (from Settings or the
// provider's env var). tts.js calls this before routing to `cloud` so a
// misconfigured station silently uses the local engine instead.
export function isConfigured() {
  const c = cloudCfg();
  if (!c.provider || !c.model) return false;
  const envKey = c.provider === 'elevenlabs'
    ? process.env.ELEVENLABS_API_KEY
    : process.env.OPENAI_API_KEY;
  return !!(c.apiKey || envKey);
}

// Generate speech and write it to a file. Returns the path — same contract as
// piper.speak / kokoro.speak so tts.js treats all three engines alike.
export async function speak(text, { outPath } = {}) {
  if (!text || !text.trim()) throw new Error('Empty TTS text');
  const c = cloudCfg();

  const result = await generateSpeech({
    model: speechModel(c),
    text,
    voice: c.voice || undefined,
    outputFormat: 'wav',   // providers that can't honour this warn and fall back
  });

  const fmt = result.audio.format || 'mp3';
  const finalPath = outPath
    || path.join(config.piper.outDir, `${crypto.randomBytes(6).toString('hex')}.${fmt}`);
  await mkdir(path.dirname(finalPath), { recursive: true });
  await writeFile(finalPath, Buffer.from(result.audio.uint8Array));
  return finalPath;
}

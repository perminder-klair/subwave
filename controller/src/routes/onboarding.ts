// First-run wizard endpoints. The test endpoints are non-mutating one-off
// probes; /onboarding/save is the only mutation path.

import express from 'express';
import { generateText } from 'ai';
import { createOllama } from 'ai-sdk-ollama';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createAzure } from '@ai-sdk/azure';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

import { requireAdmin } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import {
  fishAudioIssue,
  llmProbeSchema,
  navidromeProbeSchema,
  normalizeNavidromeCredentials,
  type LlmProbeInput,
} from '../schemas/onboarding.js';
import { DEFAULT_LOCCA_BASE_URL, DEFAULT_REQUESTY_BASE_URL, OPENROUTER_APP_HEADERS, noThinkFetch, azureEndpoint } from '../llm/provider.js';
import * as settings from '../settings.js';
import * as jingles from '../broadcast/jingles.js';
import { queue } from '../broadcast/queue.js';
import { refreshAutoPlaylist } from '../broadcast/scheduler.js';
import { applyNavidromeToLiveConfig, saveSetupConfig, clearSetupConfigCache } from '../setup/config.js';
import { saveSecrets, SECRET_ENV_KEYS } from '../setup/secrets.js';
import { getSetupStatus } from '../setup/firstRun.js';
import { pingWith } from '../music/subsonic.js';

export const router = express.Router();

// Mirrors scripts/generate-jingles.sh so both paths render the same idents.
const DEFAULT_JINGLES = [
  "You're listening to Subwave. Personal frequency from the homelab.",
  'Subwave radio. The signal continues.',
  'This is Subwave. Late night sounds for the connected few.',
  "You're tuned to Subwave. Single stream, one frequency.",
  'Subwave — broadcasting on whatever wavelength reaches you.',
];

// Deliberately public (not admin-gated) so the landing page can read it; it only
// exposes whether the station is configured yet.
router.get('/onboarding/status', async (req, res) => {
  try {
    res.json(await getSetupStatus());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/onboarding/test-navidrome', requireAdmin, validateBody(navidromeProbeSchema), async (req, res) => {
  const { url, user, pass } = req.body as { url: string; user: string; pass: string };
  res.json(await pingWith({ url, user, pass, client: 'sub-wave-wizard' }));
});

// Constructs a one-off model and asks for a single token; never touches live
// llm settings.
router.post('/onboarding/test-llm', requireAdmin, validateBody(llmProbeSchema), async (req, res) => {
  // The schema owns "provider and model required" and "openai-compatible needs a
  // baseUrl"; the wizard runs the same rule to hold the button shut.
  const { provider, model, apiKey, baseUrl, ollamaUrl } = req.body as LlmProbeInput;

  try {
    let m: any;
    switch (provider) {
      case 'anthropic':
        m = createAnthropic(apiKey ? { apiKey } : {})(model);
        break;
      case 'openai':
        m = createOpenAI(apiKey ? { apiKey } : {})(model);
        break;
      case 'azure': {
        // Azure OpenAI on the operator's own resource: `baseUrl` is the resource
        // endpoint (the schema requires it) and `model` is the DEPLOYMENT name.
        // `.chat()` for the same reason as the registry — Chat Completions is
        // the surface every deployment serves.
        const ep = azureEndpoint({ baseUrl });
        m = createAzure({
          baseURL: ep.baseURL,
          ...(ep.apiVersion ? { apiVersion: ep.apiVersion } : {}),
          ...(ep.useDeploymentBasedUrls ? { useDeploymentBasedUrls: true } : {}),
          ...(apiKey ? { apiKey } : {}),
        }).chat(model);
        break;
      }
      case 'openai-compatible':
        // noThinkFetch so a thinking model returns visible content, not reasoning.
        m = createOpenAI({ baseURL: baseUrl, apiKey: apiKey || 'unused', fetch: noThinkFetch }).chat(model);
        break;
      case 'locca':
        // openai-compatible llama.cpp; base URL defaults to the host locca server.
        m = createOpenAI({
          baseURL: baseUrl || DEFAULT_LOCCA_BASE_URL,
          apiKey: apiKey || 'unused',
          fetch: noThinkFetch,
        }).chat(model);
        break;
      case 'google':
        m = createGoogleGenerativeAI(apiKey ? { apiKey } : {})(model);
        break;
      case 'deepseek':
        m = createDeepSeek(apiKey ? { apiKey } : {})(model);
        break;
      case 'openrouter':
        m = createOpenRouter({ headers: OPENROUTER_APP_HEADERS, ...(apiKey ? { apiKey } : {}) })(model);
        break;
      case 'requesty':
        // OpenAI-compatible gateway at a fixed base URL; model ids are
        // provider/model (openai/gpt-4o-mini).
        m = createOpenAI({ baseURL: DEFAULT_REQUESTY_BASE_URL, apiKey: apiKey || 'unused' }).chat(model);
        break;
      case 'ollama':
      default: {
        const url = ollamaUrl || 'http://localhost:11434';
        m = createOllama({ baseURL: url })(model);
        break;
      }
    }

    const out = await generateText({
      model: m,
      prompt: 'Reply with the single word OK.',
      // OpenAI's Responses API rejects max_output_tokens below 16.
      maxOutputTokens: 32,
      // A test must always answer: an unbounded call hangs the wizard (#682).
      // maxRetries 0 so the first real error surfaces instead of silent backoff.
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(45_000),
    });
    res.json({ ok: true, sample: (out.text || '').trim().slice(0, 60) });
  } catch (err: any) {
    res.json({ ok: false, error: err.message || 'LLM call failed' });
  }
});

// Every block is optional; the wizard sends only what it collected. navidrome
// goes to state/setup-config.json, apiKeys to state/secrets.env, the rest through
// settings.update(). Only the navidrome block affects needsSetup().
router.post('/onboarding/save', requireAdmin, async (req, res) => {
  const b = req.body || {};
  try {
    // Must run before ANY wizard store is mutated: setup credentials are written
    // before the settings patch, so a late Fish rejection would leave onboarding
    // hidden on the next reload.
    const fishIssue = fishAudioIssue(b.tts?.cloud);
    if (fishIssue) throw new Error(fishIssue);

    // Wizard-managed overlay only; never mutates the live env. Unlike the probe,
    // save does not require the fields (skipping Navidrome is supported).
    if (b.navidrome && typeof b.navidrome === 'object') {
      await saveSetupConfig({
        navidrome: normalizeNavidromeCredentials(b.navidrome),
      });
      applyNavidromeToLiveConfig(b.navidrome);
      clearSetupConfigCache();
    }

    // state/secrets.env (0600), also set on process.env for immediate use.
    if (b.apiKeys && typeof b.apiKeys === 'object') {
      const patch: Record<string, string> = {};
      for (const k of SECRET_ENV_KEYS) {
        if (typeof b.apiKeys[k] === 'string') patch[k] = b.apiKeys[k];
      }
      if (Object.keys(patch).length) await saveSecrets(patch);
    }

    const settingsPatch: any = {};
    if (b.llm && typeof b.llm === 'object') settingsPatch.llm = b.llm;
    if (b.tts && typeof b.tts === 'object') settingsPatch.tts = b.tts;
    if (typeof b.djPrompt === 'string') settingsPatch.djPrompt = b.djPrompt;
    if (Array.isArray(b.personas)) settingsPatch.personas = b.personas;
    if (b.weather && typeof b.weather === 'object') settingsPatch.weather = b.weather;
    if (typeof b.station === 'string') settingsPatch.station = b.station;
    if (typeof b.timezone === 'string') settingsPatch.timezone = b.timezone;
    if (Object.keys(settingsPatch).length) await settings.update(settingsPatch);

    // Mark setup complete so the wizard exits even if Navidrome was skipped.
    await saveSetupConfig({ setupCompletedAt: new Date().toISOString() });
    clearSetupConfigCache();

    // The boot-time refresh ran before creds existed, and the next retry is the
    // 60-minute cron, so kick it here or the stream stays dark. Fire-and-forget.
    refreshAutoPlaylist().catch(err =>
      queue.log('error', `Post-onboarding playlist refresh failed: ${err.message}`),
    );

    res.json({ ok: true, status: await getSetupStatus() });
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err.message || 'save failed' });
  }
});

// Synchronous: returns once every default jingle is rendered, or on the first
// failure. The wizard polls /jingles for progress.
router.post('/onboarding/generate-jingles', requireAdmin, async (req, res) => {
  try {
    const existing = await jingles.list();
    const existingTexts = new Set(existing.map((j: any) => j.text));
    const created: any[] = [];
    for (const text of DEFAULT_JINGLES) {
      if (existingTexts.has(text)) continue;
      const j = await jingles.create(text);
      queue.log('scheduler', `[wizard] jingle rendered: "${text.slice(0, 60)}…"`);
      created.push(j);
    }
    res.json({ ok: true, created: created.length, total: (await jingles.list()).length });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message || 'jingle render failed' });
  }
});

// First-run wizard endpoints. All admin-gated — the operator must have set
// ADMIN_USER + ADMIN_PASS in the root .env before they can reach these.
//
// Endpoints:
//   GET  /onboarding/status           — needsSetup snapshot for the wizard shell.
//   POST /onboarding/test-navidrome   — try the supplied creds, no mutation.
//   POST /onboarding/test-llm         — try the supplied provider, no mutation.
//   POST /onboarding/save             — persist Navidrome + LLM + TTS + DJ choices.
//   POST /onboarding/generate-jingles — kick off the default-jingle render batch.
//
// Both test endpoints are non-mutating: they construct one-off clients with
// the request body's values and report success/failure. They never touch the
// live settings or live config. Save is the only mutation path.

import crypto from 'node:crypto';
import express from 'express';
import { generateText } from 'ai';
import { createOllama } from 'ai-sdk-ollama';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

import { requireAdmin } from '../middleware/auth.js';
import { DEFAULT_LOCCA_BASE_URL, DEFAULT_REQUESTY_BASE_URL, noThinkFetch } from '../llm/provider.js';
import { config } from '../config.js';
import * as settings from '../settings.js';
import * as jingles from '../broadcast/jingles.js';
import { queue } from '../broadcast/queue.js';
import { refreshAutoPlaylist } from '../broadcast/scheduler.js';
import { saveSetupConfig, clearSetupConfigCache } from '../setup/config.js';
import { saveSecrets, SECRET_ENV_KEYS } from '../setup/secrets.js';
import { getSetupStatus } from '../setup/firstRun.js';

export const router = express.Router();

// Default jingle texts — the wizard fires these through the same render path
// the admin Jingles UI uses. Mirrors scripts/generate-jingles.sh so existing
// operators get the same idents either way.
const DEFAULT_JINGLES = [
  "You're listening to Subwave. Personal frequency from the homelab.",
  'Subwave radio. The signal continues.',
  'This is Subwave. Late night sounds for the connected few.',
  "You're tuned to Subwave. Single stream, one frequency.",
  'Subwave — broadcasting on whatever wavelength reaches you.',
];

// ---------------------------------------------------------------------------
// GET /onboarding/status — quick boolean for the wizard shell to decide what to
// render. Public (not admin-gated) so the landing page can read it too — it
// only leaks "is this station configured yet" which is already obvious from
// the stream being silent.
// ---------------------------------------------------------------------------
router.get('/onboarding/status', async (req, res) => {
  try {
    res.json(await getSetupStatus());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /onboarding/test-navidrome — body: { url, user, pass }
// ---------------------------------------------------------------------------
router.post('/onboarding/test-navidrome', requireAdmin, async (req, res) => {
  const url = String(req.body?.url || '').trim().replace(/\/$/, '');
  const user = String(req.body?.user || '').trim();
  const pass = String(req.body?.pass || '');
  if (!url || !user || !pass) {
    return res.status(400).json({ ok: false, error: 'url, user, and pass are required' });
  }

  try {
    const salt = crypto.randomBytes(8).toString('hex');
    const token = crypto.createHash('md5').update(pass + salt).digest('hex');
    const probeUrl = new URL(`${url}/rest/ping`);
    probeUrl.searchParams.set('u', user);
    probeUrl.searchParams.set('t', token);
    probeUrl.searchParams.set('s', salt);
    probeUrl.searchParams.set('v', '1.16.1');
    probeUrl.searchParams.set('c', 'sub-wave-wizard');
    probeUrl.searchParams.set('f', 'json');

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(probeUrl.toString(), { signal: ctrl.signal });
    clearTimeout(timer);

    if (!r.ok) {
      return res.json({ ok: false, error: `Subsonic ping returned HTTP ${r.status}` });
    }
    const body: any = await r.json();
    const sub = body?.['subsonic-response'];
    if (sub?.status !== 'ok') {
      return res.json({
        ok: false,
        error: sub?.error?.message || 'Subsonic responded but auth failed',
      });
    }
    res.json({
      ok: true,
      serverVersion: sub.version,
      serverType: sub.type || 'unknown',
    });
  } catch (err: any) {
    res.json({ ok: false, error: err.message || 'Navidrome unreachable' });
  }
});

// ---------------------------------------------------------------------------
// POST /onboarding/test-llm — body: { provider, model, apiKey?, baseUrl? }
// Constructs a one-off AI SDK model and asks it for a single token. Does NOT
// touch the live llm settings.
// ---------------------------------------------------------------------------
router.post('/onboarding/test-llm', requireAdmin, async (req, res) => {
  const provider = String(req.body?.provider || '').trim();
  const model = String(req.body?.model || '').trim();
  const apiKey = String(req.body?.apiKey || '').trim();
  const baseUrl = String(req.body?.baseUrl || '').trim();
  const ollamaUrl = String(req.body?.ollamaUrl || '').trim();
  if (!provider || !model) {
    return res.status(400).json({ ok: false, error: 'provider and model are required' });
  }

  try {
    let m: any;
    switch (provider) {
      case 'anthropic':
        m = createAnthropic(apiKey ? { apiKey } : {})(model);
        break;
      case 'openai':
        m = createOpenAI(apiKey ? { apiKey } : {})(model);
        break;
      case 'openai-compatible':
        if (!baseUrl) throw new Error('baseUrl is required for openai-compatible');
        // noThinkFetch so a thinking model (Qwen3 etc.) returns visible content
        // in the test rather than spending its budget in the reasoning channel.
        m = createOpenAI({ baseURL: baseUrl, apiKey: apiKey || 'unused', fetch: noThinkFetch }).chat(model);
        break;
      case 'locca':
        // First-class locca: openai-compatible llama.cpp, base URL defaults to
        // the host locca server when not supplied.
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
        m = createOpenRouter(apiKey ? { apiKey } : {})(model);
        break;
      case 'requesty':
        // Requesty is an OpenAI-compatible gateway at a fixed base URL; the test
        // call goes through createOpenAI like openai-compatible, but with the
        // hosted endpoint. Model ids use provider/model naming (openai/gpt-4o-mini).
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
      maxOutputTokens: 8,
      // A test must always answer. Without a bound an unreachable/stalled model
      // hangs this handler forever, the wizard's fetch never resolves, and the
      // button is stuck on "Asking…" with no feedback (issue #682). maxRetries:0
      // so the operator sees the first real error fast instead of silent backoff.
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(45_000),
    });
    res.json({ ok: true, sample: (out.text || '').trim().slice(0, 60) });
  } catch (err: any) {
    res.json({ ok: false, error: err.message || 'LLM call failed' });
  }
});

// ---------------------------------------------------------------------------
// POST /onboarding/save — persist the wizard's collected values.
//
// Body:
//   {
//     navidrome: { url, user, pass },                 // → state/setup-config.json
//     llm:      { provider, model, apiKey, ... },     // → settings.update()
//     tts:      { defaultEngine, ... },               // → settings.update()
//     dj:       { djPrompt, ... },                    // → settings.update()
//     station:  string,                               // → settings.update()
//     apiKeys:  { ANTHROPIC_API_KEY, ... },           // → state/secrets.env
//   }
//
// Everything is optional — the wizard sends only what it collected. The
// navidrome block is the only field that affects needsSetup() going forward.
// ---------------------------------------------------------------------------
router.post('/onboarding/save', requireAdmin, async (req, res) => {
  const b = req.body || {};
  try {
    // Navidrome — only the wizard-managed overlay; never mutate the live env.
    if (b.navidrome && typeof b.navidrome === 'object') {
      await saveSetupConfig({
        navidrome: {
          url: String(b.navidrome.url || '').trim().replace(/\/$/, ''),
          user: String(b.navidrome.user || '').trim(),
          pass: String(b.navidrome.pass || ''),
        },
      });
      // Apply to the live config so subsonic calls work without a restart.
      if (b.navidrome.url) config.navidrome.url = String(b.navidrome.url).trim().replace(/\/$/, '');
      if (b.navidrome.user) config.navidrome.user = String(b.navidrome.user).trim();
      if (b.navidrome.pass !== undefined) config.navidrome.password = String(b.navidrome.pass);
      clearSetupConfigCache();
    }

    // API keys — persisted to state/secrets.env (mode 0600), also set on
    // process.env so subsequent AI SDK calls pick them up immediately.
    if (b.apiKeys && typeof b.apiKeys === 'object') {
      const patch: Record<string, string> = {};
      for (const k of SECRET_ENV_KEYS) {
        if (typeof b.apiKeys[k] === 'string') patch[k] = b.apiKeys[k];
      }
      if (Object.keys(patch).length) await saveSecrets(patch);
    }

    // settings.update accepts a partial patch — pass through whatever the
    // wizard sent for llm / tts / djPrompt / personas.
    const settingsPatch: any = {};
    if (b.llm && typeof b.llm === 'object') settingsPatch.llm = b.llm;
    if (b.tts && typeof b.tts === 'object') settingsPatch.tts = b.tts;
    if (typeof b.djPrompt === 'string') settingsPatch.djPrompt = b.djPrompt;
    if (Array.isArray(b.personas)) settingsPatch.personas = b.personas;
    if (b.weather && typeof b.weather === 'object') settingsPatch.weather = b.weather;
    if (typeof b.station === 'string') settingsPatch.station = b.station;
    // Timezone rides along from the wizard's location picker (Open-Meteo returns
    // the IANA zone for the picked city). settings.update() validates it.
    if (typeof b.timezone === 'string') settingsPatch.timezone = b.timezone;
    if (Object.keys(settingsPatch).length) await settings.update(settingsPatch);

    // Mark setup complete so the wizard exits even if Navidrome was skipped.
    await saveSetupConfig({ setupCompletedAt: new Date().toISOString() });
    clearSetupConfigCache();

    // Kick the auto-playlist refresher. The boot-time call from
    // scheduler.start() runs before onboarding completes, so on a fresh
    // install it fails (no Navidrome creds) and gives up — the next retry
    // would otherwise be the 60-minute cron tick, leaving /stream.mp3 dark
    // in the interim. Fire-and-forget so the wizard's response isn't held
    // up by Navidrome + LLM round-trips; errors land in the controller log
    // where the operator (or `subwave doctor`) can see them.
    refreshAutoPlaylist().catch(err =>
      queue.log('error', `Post-onboarding playlist refresh failed: ${err.message}`),
    );

    res.json({ ok: true, status: await getSetupStatus() });
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err.message || 'save failed' });
  }
});

// ---------------------------------------------------------------------------
// POST /onboarding/generate-jingles — fire off the default jingle batch through
// the same code path the admin UI's "+" button uses. Synchronous — the wizard
// reports per-jingle progress by polling /jingles between calls. We return
// once everything has been rendered (or the first failure).
// ---------------------------------------------------------------------------
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

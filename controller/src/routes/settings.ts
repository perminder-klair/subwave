// Admin-gated settings surface: the single /settings read endpoint the admin
// UI consumes, the matching write endpoint, plus the mixer-restart and
// auto-pick toggles.
import express from 'express';
import { config } from '../config.js';
import * as library from '../music/library.js';
import * as jingles from '../broadcast/jingles.js';
import * as settings from '../settings.js';
import * as tts from '../audio/tts.js';
import * as chatterbox from '../audio/chatterbox.js';
import * as piper from '../audio/piper.js';
import * as llmProvider from '../llm/provider.js';
import { queue } from '../broadcast/queue.js';
import { restartLiquidsoap, startStream, stopStream, streamStatus } from '../broadcast/liquidsoap-control.js';
import { invalidateWeatherCache } from '../context.js';
import { requireAdmin } from '../middleware/auth.js';
import { tagger } from '../broadcast/tagger.js';
import { skillCatalog } from '../skills/_agent.js';
import { clearUserThemeCache, loadUserThemes, listThemes } from '../themes.js';

export const router = express.Router();

// ---------------------------------------------------------------------------
// SETTINGS — single endpoint that returns everything the /settings UI needs
// ---------------------------------------------------------------------------
router.get('/settings', requireAdmin, async (req, res) => {
  try {
    await library.load();
    await settings.load();
    // Redacted view — masks llm.apiKey / tts.cloud.apiKey so secrets never
    // leave the process. The UI shows "set"/"" and round-trips it harmlessly.
    const s = settings.getRedacted();
    // On-air status — a telnet failure must not 500 the whole settings load.
    let streamOnAir: boolean | null = null;
    try { streamOnAir = await streamStatus(); } catch {}
    // Reference-WAV voices are shared by chatterbox + pocket-tts (issue #213);
    // read once and reuse for both dropdowns.
    const customVoices = await chatterbox.listReferenceVoices();
    // Custom Piper .onnx voices the operator dropped into the same shared folder
    // (issue #230) — only those with a matching .onnx.json manifest are listed.
    const piperVoices = await piper.listPiperVoices();
    const voiceDir = chatterbox.voiceDir();
    res.json({
      autoPick: queue.autoPick,
      pickerBusy: queue.pickerBusy,
      streamOnAir,
      jingles: await jingles.list(),
      libraryStats: library.stats(),
      tagger: { ...tagger, lastLog: tagger.lastLog.slice(-30) },
      ollama: { url: config.ollama.url, model: config.ollama.model },
      values: {
        jingleRatio: s.jingleRatio,
        crossfadeDuration: s.crossfadeDuration,
        station: s.station,
        theme: s.theme,
        weather: s.weather,
        djPrompt: s.djPrompt,
        personas: s.personas,
        activePersonaId: s.activePersonaId,
        shows: s.shows,
        schedule: s.schedule,
        tts: s.tts,
        llm: s.llm,
        search: s.search,
        embedding: s.embedding,
        sfx: s.sfx,
        scrobble: s.scrobble,
      },
      defaults: {
        // The built-in prompt template — the UI shows this when djPrompt is "".
        djPrompt: settings.DEFAULT_DJ_PROMPT_TEMPLATE,
        personas: settings.getDefaults().personas,
        tts: settings.getDefaults().tts,
        llm: settings.getDefaults().llm,
        search: settings.getDefaults().search,
      },
      tts: {
        engines: tts.ENGINES,
        available: tts.availableEngines(),
        kokoroVoices: settings.KOKORO_VOICES_BRITISH,
        voiceDir,
        piperVoices,
        chatterboxVoices: customVoices,
        // `chatterboxVoiceDir` kept as an alias of `voiceDir` so older UI
        // builds that haven't picked up the new field don't break.
        chatterboxVoiceDir: voiceDir,
        pocketTtsVoices: settings.POCKET_TTS_VOICES,
        pocketTtsCustomVoices: customVoices,
        cloudProviders: settings.TTS_CLOUD_PROVIDERS,
        frequencies: settings.FREQUENCIES,
        moods: settings.SHOW_MOODS,
      },
      llm: {
        providers: settings.LLM_PROVIDERS,
        active: llmProvider.activeModelLabel(),
      },
      search: {
        providers: settings.SEARCH_PROVIDERS,
      },
      // Which provider API keys are present in the controller's environment.
      // The UI keys its "key missing" alerts off this — keys are configured
      // via controller/.env, never typed into the admin surface.
      env: {
        OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
        ELEVENLABS_API_KEY: !!process.env.ELEVENLABS_API_KEY,
        ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
        GOOGLE_GENERATIVE_AI_API_KEY: !!process.env.GOOGLE_GENERATIVE_AI_API_KEY,
        DEEPSEEK_API_KEY: !!process.env.DEEPSEEK_API_KEY,
        OPENROUTER_API_KEY: !!process.env.OPENROUTER_API_KEY,
        AI_GATEWAY_API_KEY: !!process.env.AI_GATEWAY_API_KEY,
        SEARCH_API_KEY: !!process.env.SEARCH_API_KEY,
        LASTFM_API_KEY: !!process.env.LASTFM_API_KEY,
        LASTFM_API_SECRET: !!process.env.LASTFM_API_SECRET,
        LASTFM_SESSION_KEY: !!process.env.LASTFM_SESSION_KEY,
        LISTENBRAINZ_USER_TOKEN: !!process.env.LISTENBRAINZ_USER_TOKEN,
      },
      // Skill catalogue — consumed by the Skills page and by Personas for the
      // per-persona skill-assignment checklist.
      skills: { catalog: skillCatalog() },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /settings — update values. Returns { requiresRestart } so the UI can
// prompt the user to restart the mixer for jingle freq / crossfade changes.
// ---------------------------------------------------------------------------
router.post('/settings', requireAdmin, async (req, res) => {
  try {
    const result = await settings.update(req.body || {});
    // Apply live: weather location flows through config.weather to context.js
    if ('weather' in (req.body || {})) {
      config.weather.lat = result.saved.weather.lat;
      config.weather.lng = result.saved.weather.lng;
      config.weather.locationName = result.saved.weather.locationName;
      config.weather.units = result.saved.weather.units;
      invalidateWeatherCache();
      queue.log(
        'scheduler',
        `weather location → ${result.saved.weather.locationName} (${result.saved.weather.units})`,
      );
    }
    if (result.requiresRestart) {
      queue.log('scheduler', `mixer settings changed — Liquidsoap restart required`);
    }
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /restart-mixer — telnet → Liquidsoap → shutdown → container restart
// Brief gap of dead air covered by Icecast burst buffer + emergency.mp3.
// ---------------------------------------------------------------------------
router.post('/restart-mixer', requireAdmin, async (req, res) => {
  try {
    await restartLiquidsoap();
    queue.log('scheduler', 'mixer restart requested');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /stream-stop — take the station off air by stopping the Icecast output.
// The mixer process keeps running; the /stream.mp3 mount disconnects.
// ---------------------------------------------------------------------------
router.post('/stream-stop', requireAdmin, async (req, res) => {
  try {
    await stopStream();
    queue.log('scheduler', 'stream stopped — off air');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /stream-start — bring the station back on air (reconnect Icecast output)
// ---------------------------------------------------------------------------
router.post('/stream-start', requireAdmin, async (req, res) => {
  try {
    await startStream();
    queue.log('scheduler', 'stream started — on air');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /auto-pick — toggle whether the LLM picks the next track
// Body: { "on": true | false }
// ---------------------------------------------------------------------------
router.post('/auto-pick', requireAdmin, express.json(), (req, res) => {
  if (typeof req.body?.on === 'boolean') queue.autoPick = req.body.on;
  queue.log('scheduler', `auto-pick ${queue.autoPick ? 'enabled' : 'disabled'}`);
  res.json({ autoPick: queue.autoPick });
});

// ---------------------------------------------------------------------------
// POST /themes/refresh — re-scan ${STATE_DIR}/themes/. Use after dropping a
// new JSON in there to pick it up without bouncing the controller. Returns
// the freshly-listed registry so the admin UI can render it immediately.
// ---------------------------------------------------------------------------
router.post('/themes/refresh', requireAdmin, async (req, res) => {
  try {
    clearUserThemeCache();
    await loadUserThemes(true);
    const themes = await listThemes();
    res.json({ ok: true, themes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

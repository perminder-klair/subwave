// Admin-gated settings surface: the single /settings read endpoint the admin
// UI consumes, the matching write endpoint, plus the mixer-restart and
// auto-pick toggles.
import express from 'express';
import { config } from '../config.js';
import * as library from '../music/library.js';
import * as jingles from '../broadcast/jingles.js';
import * as settings from '../settings.js';
import * as tts from '../audio/tts.js';
import * as llmProvider from '../llm/provider.js';
import { queue } from '../broadcast/queue.js';
import { restartLiquidsoap } from '../broadcast/liquidsoap-control.js';
import { invalidateWeatherCache } from '../context.js';
import { requireAdmin } from '../middleware/auth.js';
import { tagger } from '../broadcast/tagger.js';

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
    res.json({
      autoPick: queue.autoPick,
      pickerBusy: queue.pickerBusy,
      jingles: await jingles.list(),
      libraryStats: library.stats(),
      tagger: { ...tagger, lastLog: tagger.lastLog.slice(-30) },
      ollama: { url: config.ollama.url, model: config.ollama.model },
      values: {
        jingleRatio: s.jingleRatio,
        crossfadeDuration: s.crossfadeDuration,
        weather: s.weather,
        djPrompt: s.djPrompt,
        personas: s.personas,
        activePersonaId: s.activePersonaId,
        shows: s.shows,
        schedule: s.schedule,
        tts: s.tts,
        llm: s.llm,
      },
      defaults: {
        // The built-in prompt template — the UI shows this when djPrompt is "".
        djPrompt: settings.DEFAULT_DJ_PROMPT_TEMPLATE,
        personas: settings.getDefaults().personas,
        tts: settings.getDefaults().tts,
        llm: settings.getDefaults().llm,
      },
      tts: {
        engines: tts.ENGINES,
        kinds: tts.VOICE_KINDS.filter(k => k !== 'default'),
        available: tts.availableEngines(),
        kokoroVoices: settings.KOKORO_VOICES_BRITISH,
        cloudProviders: settings.TTS_CLOUD_PROVIDERS,
        frequencies: settings.FREQUENCIES,
        moods: settings.SHOW_MOODS,
      },
      llm: {
        providers: settings.LLM_PROVIDERS,
        active: llmProvider.activeModelLabel(),
      },
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
      invalidateWeatherCache();
      queue.log('scheduler', `weather location → ${result.saved.weather.locationName}`);
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
// POST /auto-pick — toggle whether the LLM picks the next track
// Body: { "on": true | false }
// ---------------------------------------------------------------------------
router.post('/auto-pick', requireAdmin, express.json(), (req, res) => {
  if (typeof req.body?.on === 'boolean') queue.autoPick = req.body.on;
  queue.log('scheduler', `auto-pick ${queue.autoPick ? 'enabled' : 'disabled'}`);
  res.json({ autoPick: queue.autoPick });
});

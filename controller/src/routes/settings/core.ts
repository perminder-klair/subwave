// The settings GET/POST plus the two credential writes (cloud secrets,
// Navidrome) that land outside settings.json.

import express from 'express';
import { config } from '../../config.js';
import * as subsonic from '../../music/subsonic.js';
import { clearPoolCache } from '../../music/picker.js';
import { clearNavidromeCache } from '../../doctor.js';
import { refreshAutoPlaylist } from '../../broadcast/scheduler.js';
import { applyNavidromeToLiveConfig, saveSetupConfig } from '../../setup/config.js';
import * as library from '../../music/library.js';
import * as jingles from '../../broadcast/jingles.js';
import * as settings from '../../settings.js';
import { BOUNDARY_MIN_PLAY_SEC, BOUNDARY_TOLERANCE_SEC } from '../../broadcast/show-boundary.js';
import * as tts from '../../audio/tts.js';
import * as remoteTts from '../../audio/remoteTts.js';
import * as chatterbox from '../../audio/chatterbox.js';
import * as piper from '../../audio/piper.js';
import * as llmProvider from '../../llm/provider.js';
import { queue } from '../../broadcast/queue.js';
import { handoverOffsetMinutes } from '../../broadcast/handover-policy.js';
import { streamStatus } from '../../broadcast/liquidsoap-control.js';
import { requireAdmin } from '../../middleware/auth.js';
import { validateSettingsBody } from '../../middleware/validate.js';
import { saveSecrets, SECRET_ENV_KEYS } from '../../setup/secrets.js';
import { taggerView } from '../../broadcast/tagger.js';
import { currentMode as budgetCurrentMode } from '../../broadcast/dj-budget.js';
import { skillCatalog } from '../../skills/_agent.js';

// Mounted onto the parent settings router in ../settings.ts.
export const router = express.Router();

// Everything the /settings UI needs, in one response.
router.get('/settings', requireAdmin, async (req, res) => {
  try {
    await library.load();
    await settings.load();
    // Redacted: secrets come back as "set"/"" and round-trip harmlessly.
    const s = settings.getRedacted();
    // A telnet failure must not 500 the whole settings load.
    let streamOnAir: boolean | null = null;
    try { streamOnAir = await streamStatus(); } catch {}
    // On air is resolved through getEffectivePersona (a live show's owner, else
    // the default), never activePersonaId, so a show override surfaces.
    const onAirPersona = settings.getEffectivePersona();
    const activeShow = settings.resolveActiveShow();
    const onAir = {
      personaId: onAirPersona?.id || '',
      // null means the default persona is on air.
      show: activeShow?.persona?.id ? { id: activeShow.id, name: activeShow.name } : null,
    };
    // Reference-WAV voices are shared by chatterbox + pocket-tts (#213).
    const customVoices = await chatterbox.listReferenceVoices();
    // Custom Piper voices in the same folder (#230), .onnx + .onnx.json pairs.
    const piperVoices = await piper.listPiperVoices();
    const voiceDir = chatterbox.voiceDir();
    res.json({
      autoPick: queue.autoPick,
      pickerBusy: queue.pickerBusy,
      streamOnAir,
      onAir,
      jingles: await jingles.list(),
      libraryStats: library.stats(),
      tagger: taggerView(),
      // Daily-token-budget tier (normal|soft|hard); 'normal' when the cap is off.
      budget: { mode: budgetCurrentMode() },
      ollama: { url: config.ollama.url, model: config.ollama.model },
      // Password never leaves the process (passSet only). Env flags are
      // per-field because server.ts applies setup-config per-field.
      navidrome: {
        url: config.navidrome.url,
        user: config.navidrome.user,
        passSet: !!config.navidrome.password,
        env: {
          url: !!process.env.NAVIDROME_URL,
          user: !!process.env.NAVIDROME_USER,
          pass: !!process.env.NAVIDROME_PASS,
        },
      },
      // What timezone '' (Auto) resolves to, for the UI's Auto label.
      serverTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      values: {
        jingleRatio: s.jingleRatio,
        crossfadeDuration: s.crossfadeDuration,
        ducking: s.ducking,
        // Repaired on the way out via the same function the air path uses: a
        // profile switch or backup restore can seed an off-step value (#1576).
        handover: { offsetMinutes: handoverOffsetMinutes() },
        maxTrackSeconds: s.maxTrackSeconds,
        // Crossfade-relative floor, shared with the admin/show UI so client
        // hints match server validation.
        minTrackSeconds: settings.minTrackSeconds(s),
        archive: s.archive,
        // Edited from the Backup panel, but saved through POST /settings.
        backups: s.backups,
        stream: s.stream,
        loudness: s.loudness,
        silenceTrim: s.silenceTrim,
        fadeAtShowEnd: s.fadeAtShowEnd,
        // Shortest playable track a boundary cut can arm on; a maxTrackSeconds
        // cap at or below this disables the feature. Served, never restated in
        // the UI, so the hint uses the number the drain uses.
        boundaryFadeMinTrackSeconds: BOUNDARY_MIN_PLAY_SEC + BOUNDARY_TOLERANCE_SEC,
        station: s.station,
        stationDescription: s.stationDescription,
        timezone: s.timezone,
        locale: s.locale,
        theme: s.theme,
        festivals: s.festivals,
        moods: s.moods,
        moodSchedule: s.moodSchedule,
        weatherMoods: s.weatherMoods,
        weather: s.weather,
        djPrompt: s.djPrompt,
        djPrompts: s.djPrompts,
        activeDjPromptId: s.activeDjPromptId,
        djHouseRules: s.djHouseRules,
        personas: s.personas,
        activePersonaId: s.activePersonaId,
        shows: s.shows,
        schedule: s.schedule,
        tts: s.tts,
        llm: s.llm,
        search: s.search,
        embedding: s.embedding,
        likes: s.likes,
        // The admin form hydrates the album-cooldown/min-length inputs from
        // this; omit it and the next save on that card zeroes them.
        picker: s.picker,
        audio: s.audio,
        transitions: s.transitions,
        sfx: s.sfx,
        beds: s.beds,
        ui: s.ui,
        scrobble: s.scrobble,
        // privacy.password arrives redacted ('set'/'').
        privacy: s.privacy,
        requests: s.requests,
      },
      defaults: {
        // Shown by the UI when djPrompt is "".
        djPrompt: settings.DEFAULT_DJ_PROMPT_TEMPLATE,
        personas: settings.getDefaults().personas,
        tts: settings.getDefaults().tts,
        llm: settings.getDefaults().llm,
        search: settings.getDefaults().search,
        locale: settings.getDefaults().locale,
      },
      tts: {
        engines: tts.ENGINES,
        available: tts.availableEngines(),
        kokoroVoices: settings.KOKORO_VOICES,
        kokoroVoiceLanguages: settings.KOKORO_VOICE_LANGUAGES,
        kokoroLangs: settings.KOKORO_LANGS,
        voiceDir,
        piperVoices,
        chatterboxVoices: customVoices,
        // Alias of voiceDir, kept for older UI builds.
        chatterboxVoiceDir: voiceDir,
        pocketTtsVoices: settings.POCKET_TTS_VOICES,
        pocketTtsCustomVoices: customVoices,
        cloudProviders: settings.TTS_CLOUD_PROVIDERS,
        frequencies: settings.FREQUENCIES,
        // Live mood names from the operator-editable vocabulary.
        moods: settings.moodVocab(),
      },
      llm: {
        providers: settings.LLM_PROVIDERS,
        active: llmProvider.activeModelLabel(),
      },
      embedding: {
        // Embedding-capable providers only, a strict subset of llm.providers,
        // so a chat-only provider can't be chosen here (#493).
        providers: settings.EMBEDDING_PROVIDERS,
      },
      search: {
        providers: settings.SEARCH_PROVIDERS,
      },
      // Which provider API keys are present in the environment; the UI keys
      // its "key missing" alerts off this.
      env: {
        OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
        ELEVENLABS_API_KEY: !!process.env.ELEVENLABS_API_KEY,
        FISH_API_KEY: !!process.env.FISH_API_KEY,
        ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
        GOOGLE_GENERATIVE_AI_API_KEY: !!process.env.GOOGLE_GENERATIVE_AI_API_KEY,
        DEEPSEEK_API_KEY: !!process.env.DEEPSEEK_API_KEY,
        OPENROUTER_API_KEY: !!process.env.OPENROUTER_API_KEY,
        REQUESTY_API_KEY: !!process.env.REQUESTY_API_KEY,
        AI_GATEWAY_API_KEY: !!process.env.AI_GATEWAY_API_KEY,
        SEARCH_API_KEY: !!process.env.SEARCH_API_KEY,
        EMBEDDING_API_KEY: !!process.env.EMBEDDING_API_KEY,
        LASTFM_API_KEY: !!process.env.LASTFM_API_KEY,
        LASTFM_API_SECRET: !!process.env.LASTFM_API_SECRET,
        LASTFM_SESSION_KEY: !!process.env.LASTFM_SESSION_KEY,
        LISTENBRAINZ_USER_TOKEN: !!process.env.LISTENBRAINZ_USER_TOKEN,
        LISTENBRAINZ_API_URL: !!process.env.LISTENBRAINZ_API_URL,
      },
      skills: { catalog: skillCatalog() },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update values; returns { requiresRestart } for mixer-affecting keys.
// validateSettingsBody() rejects unknown top-level keys HERE and not in
// settings.update(): backup restore hands update() a whole settings.json, and
// a key from a newer version must cost one setting, not the whole restore.
router.post('/settings', requireAdmin, validateSettingsBody(), async (req, res) => {
  try {
    const result = await settings.update(req.body || {});
    // context.ts reads the live settings cache, so the update already applies;
    // the route only owns the operator-facing log.
    if ('weather' in (req.body || {})) {
      queue.log(
        'scheduler',
        `weather location → ${result.saved.weather.locationName} (${result.saved.weather.units}) · on air → ${settings.resolveOnAirLocation(result.saved)}`,
      );
    }
    if (result.requiresRestart) {
      queue.log('scheduler', `mixer settings changed — Liquidsoap restart required`);
    }
    // Re-probe now so the admin badge doesn't wait out the 30s probe tick.
    if (req.body?.tts?.remote?.url !== undefined) {
      await remoteTts.refresh();
    }
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Writes API keys to state/secrets.env. Only SECRET_ENV_KEYS are accepted and
// a blank value means "keep the existing key". Applies in-process immediately.
router.post('/settings/secrets', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    if (typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Body must be a key-value object' });
    }
    const patch: Record<string, string> = {};
    for (const [key, value] of Object.entries(body)) {
      if (!(SECRET_ENV_KEYS as readonly string[]).includes(key)) continue;
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (!trimmed) continue;
      if (trimmed.length > 4096) continue;
      patch[key] = trimmed;
    }
    if (Object.keys(patch).length === 0) {
      return res.json({ saved: [] });
    }
    await saveSecrets(patch);
    res.json({ saved: Object.keys(patch) });
  } catch (err: unknown) {
    console.error('[settings/secrets]', err);
    res.status(400).json({ error: 'Failed to save secrets' });
  }
});

// Persists to state/setup-config.json (not settings.json) and applies live.
// Body { url?, user?, pass? } is validated MERGED over the effective values
// (blank pass = keep), but only submitted fields are persisted, so an
// env-shadowed value is never copied in; env-managed fields are refused.
router.post('/settings/navidrome', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const submitted: { url?: string; user?: string; pass?: string } = {};
    if (typeof b.url === 'string') submitted.url = b.url.trim().replace(/\/$/, '');
    if (typeof b.user === 'string') submitted.user = b.user.trim();
    if (typeof b.pass === 'string' && b.pass !== '') submitted.pass = b.pass;

    const ENV_LOCKS = [
      ['url', 'NAVIDROME_URL'],
      ['user', 'NAVIDROME_USER'],
      ['pass', 'NAVIDROME_PASS'],
    ] as const;
    for (const [field, envVar] of ENV_LOCKS) {
      if (submitted[field] !== undefined && process.env[envVar]) {
        return res.status(400).json({
          ok: false,
          error: `${field} is managed by ${envVar} in the root .env — env always wins on boot; remove it there to manage it here`,
        });
      }
    }

    // The merged connection must stay complete; a blank url/user is a cleared
    // field, not "keep".
    const merged = {
      url: submitted.url ?? config.navidrome.url,
      user: submitted.user ?? config.navidrome.user,
      pass: submitted.pass ?? config.navidrome.password,
    };
    if (!merged.url || !merged.user || !merged.pass) {
      return res.status(400).json({ ok: false, error: 'url, user, and pass are all required' });
    }

    await saveSetupConfig({ navidrome: submitted });
    applyNavidromeToLiveConfig(submitted);
    // Both caches describe the OLD server; drop them so the picker can't draw
    // song ids that no longer resolve.
    clearNavidromeCache();
    clearPoolCache();
    queue.log('scheduler', `Navidrome connection updated → ${merged.url} (user ${merged.user})`);
    // auto.m3u URIs carry auth tokens derived from the old password; rebuild.
    // Fire-and-forget so the save isn't held up by Navidrome round-trips.
    refreshAutoPlaylist().catch(err =>
      queue.log('error', `Post-save playlist refresh failed: ${err.message}`),
    );
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err.message || 'save failed' });
  }
});

// Non-mutating test. Merges over the effective values like save does, so Test
// works with the stored password. The wizard's /onboarding/test-navidrome has
// no stored-cred fallback on purpose.
router.post('/settings/navidrome/test', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const url =
    typeof b.url === 'string' && b.url.trim()
      ? b.url.trim().replace(/\/$/, '')
      : config.navidrome.url;
  const user = typeof b.user === 'string' && b.user.trim() ? b.user.trim() : config.navidrome.user;
  const pass = typeof b.pass === 'string' && b.pass ? b.pass : config.navidrome.password;
  if (!url || !user || !pass) {
    return res.json({ ok: false, error: 'url, user, and pass are required' });
  }
  res.json(await subsonic.pingWith({ url, user, pass, client: 'sub-wave-admin' }));
});


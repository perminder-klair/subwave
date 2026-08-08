// The settings surface proper: the single GET the admin UI hydrates from, the
// POST that validates and persists a patch, and the two credential writes
// (cloud secrets, Navidrome) that land outside settings.json.
//
// Part of the settings/ route split - see ../settings.ts.

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
import * as tts from '../../audio/tts.js';
import * as remoteTts from '../../audio/remoteTts.js';
import * as chatterbox from '../../audio/chatterbox.js';
import * as piper from '../../audio/piper.js';
import { PREVIEW_LANGUAGES } from '../../audio/preview-text.js';
import * as llmProvider from '../../llm/provider.js';
import { queue } from '../../broadcast/queue.js';
import { streamStatus } from '../../broadcast/liquidsoap-control.js';
import { invalidateWeatherCache } from '../../context.js';
import { requireAdmin } from '../../middleware/auth.js';
import { validateSettingsBody } from '../../middleware/validate.js';
import { saveSecrets, SECRET_ENV_KEYS } from '../../setup/secrets.js';
import { taggerView } from '../../broadcast/tagger.js';
import { currentMode as budgetCurrentMode } from '../../broadcast/dj-budget.js';
import { skillCatalog } from '../../skills/_agent.js';

// Mounted onto the parent settings router in ../settings.ts.
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
    // The persona actually on air right now — the same resolution the listener
    // side uses (getEffectivePersona): a scheduled show's owner when a show is
    // live this hour, otherwise the admin-selected default. The roster marks
    // "on air" by THIS, not by activePersonaId, so a show override surfaces the
    // real voice instead of the static default.
    const onAirPersona = settings.getEffectivePersona();
    const activeShow = settings.resolveActiveShow();
    const onAir = {
      personaId: onAirPersona?.id || '',
      // The show reassigning the hour, present only when a show actually owns a
      // persona this hour — null means the default persona is on air.
      show: activeShow?.persona?.id ? { id: activeShow.id, name: activeShow.name } : null,
    };
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
      onAir,
      jingles: await jingles.list(),
      libraryStats: library.stats(),
      tagger: taggerView(),
      // Current daily-token-budget tier (normal|soft|hard) — reads 'normal' on the
      // default cap-off install. The library Tagging modal warns before a run when
      // this is soft/hard (LLM steps will spend more, or fail until UTC midnight).
      budget: { mode: budgetCurrentMode() },
      ollama: { url: config.ollama.url, model: config.ollama.model },
      // Navidrome connection — read state for the Settings "Music source"
      // section. The password never leaves the process (passSet only). Env
      // flags are per-field because server.ts applies setup-config per-field:
      // url can be env-managed while user/pass come from the wizard/admin.
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
      // What the configured zone resolves to when timezone is '' (Auto) —
      // lets the UI label the Auto option with the actual server zone.
      serverTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      values: {
        jingleRatio: s.jingleRatio,
        crossfadeDuration: s.crossfadeDuration,
        maxTrackSeconds: s.maxTrackSeconds,
        // Crossfade-relative floor for a non-zero cap — one rule, shared with the
        // admin/show UI so client hints match server validation.
        minTrackSeconds: settings.minTrackSeconds(s),
        archive: s.archive,
        stream: s.stream,
        loudness: s.loudness,
        station: s.station,
        stationDescription: s.stationDescription,
        timezone: s.timezone,
        locale: s.locale,
        theme: s.theme,
        festivals: s.festivals,
        // Editable mood system (/admin/moods): the vocabulary + CLAP prompts,
        // and the time/weather → mood maps.
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
        audio: s.audio,
        transitions: s.transitions,
        sfx: s.sfx,
        beds: s.beds,
        ui: s.ui,
        scrobble: s.scrobble,
        // privacy.password arrives redacted ('set'/'') from getRedacted().
        privacy: s.privacy,
        requests: s.requests,
      },
      defaults: {
        // The built-in prompt template — the UI shows this when djPrompt is "".
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
        // `chatterboxVoiceDir` kept as an alias of `voiceDir` so older UI
        // builds that haven't picked up the new field don't break.
        chatterboxVoiceDir: voiceDir,
        pocketTtsVoices: settings.POCKET_TTS_VOICES,
        pocketTtsCustomVoices: customVoices,
        cloudProviders: settings.TTS_CLOUD_PROVIDERS,
        // English display names for the admin "Test corrections" sample-
        // language dropdown (Moods → Speech tab). See audio/preview-text.ts
        // for the canonical table.
        speechLanguages: PREVIEW_LANGUAGES,
        frequencies: settings.FREQUENCIES,
        // The live mood NAMES, for the show/festival mood dropdowns. Now driven
        // by the operator-editable vocabulary rather than the static default.
        moods: settings.moodVocab(),
      },
      llm: {
        providers: settings.LLM_PROVIDERS,
        active: llmProvider.activeModelLabel(),
      },
      embedding: {
        // Embedding-capable providers only — a strict subset of llm.providers.
        // The picker maps over this so chat-only providers (deepseek, gateway)
        // can't be chosen as an embedding source (#493).
        providers: settings.EMBEDDING_PROVIDERS,
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
//
// validateSettingsBody() runs the per-key registry first, so a failure on a
// converted key comes back with `fieldErrors` the admin panel can map onto the
// input that caused it — the channel every form here has been missing (#1348).
// It also rejects unknown top-level keys, which used to save nothing and still
// answer 200. That check is deliberately HERE and not in settings.update():
// backup restore hands update() a whole settings.json, and a key from a newer
// version must cost one setting, not the entire restore.
// ---------------------------------------------------------------------------
router.post('/settings', requireAdmin, validateSettingsBody(), async (req, res) => {
  try {
    const result = await settings.update(req.body || {});
    // Apply live: weather location flows through config.weather to context.js
    if ('weather' in (req.body || {})) {
      config.weather.lat = result.saved.weather.lat;
      config.weather.lng = result.saved.weather.lng;
      config.weather.locationName = result.saved.weather.locationName;
      config.weather.onAirLocation = result.saved.weather.onAirLocation;
      config.weather.units = result.saved.weather.units;
      // Not optional for onAirLocation: getWeather() bakes the attributed
      // location into its cached result, so without this the DJ keeps naming
      // the old place — and /now-playing keeps publishing it — for a full
      // cache TTL after the operator changes it.
      invalidateWeatherCache();
      queue.log(
        'scheduler',
        `weather location → ${result.saved.weather.locationName} (${result.saved.weather.units}) · on air → ${settings.resolveOnAirLocation(result.saved)}`,
      );
    }
    if (result.requiresRestart) {
      queue.log('scheduler', `mixer settings changed — Liquidsoap restart required`);
    }
    // A changed remote-TTS URL re-probes immediately so availability (and the
    // admin "ready/unreachable" badge) reflects the new endpoint on the next
    // /settings fetch instead of waiting for the 30s probe tick.
    if (req.body?.tts?.remote?.url !== undefined) {
      await remoteTts.refresh();
    }
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /settings/secrets — write one or more API keys to state/secrets.env.
// Only keys listed in SECRET_ENV_KEYS are accepted; blank values are skipped
// (blank = "leave existing key in place"). Takes effect in-process immediately
// via saveSecrets(); no controller restart needed.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// POST /settings/navidrome — change the Navidrome connection from the admin
// Settings "Music source" section. Persists to state/setup-config.json (the
// same overlay the wizard and `subwave setup` write — settings.json is NOT
// the store for these; see setup/config.ts) and applies live, so Subsonic
// calls use the new creds with no restart.
//
// Body { url?, user?, pass? } — submitted fields are validated merged over the
// currently-effective values (blank pass = keep the one on file), but only the
// submitted fields are persisted, so an env-shadowed value never gets copied
// into setup-config.json. Env-managed fields are rejected outright rather than
// silently persisting a value env would shadow again on next boot.
// ---------------------------------------------------------------------------
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

    // Validate the MERGED result — the connection must stay complete. A blank
    // submitted url/user is a cleared field, not "keep", and is rejected here.
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
    // The doctor's cached ping and the picker's memoised Subsonic pools both
    // describe the OLD server — drop them so the banner clears promptly and
    // the picker can't draw song ids that no longer resolve.
    clearNavidromeCache();
    clearPoolCache();
    queue.log('scheduler', `Navidrome connection updated → ${merged.url} (user ${merged.user})`);
    // auto.m3u entries carry annotated URIs whose auth tokens derive from the
    // old password — rebuild it with the new connection. Fire-and-forget so
    // the save response isn't held up by Navidrome round-trips.
    refreshAutoPlaylist().catch(err =>
      queue.log('error', `Post-save playlist refresh failed: ${err.message}`),
    );
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err.message || 'save failed' });
  }
});

// ---------------------------------------------------------------------------
// POST /settings/navidrome/test — non-mutating connection test. Merges the
// body over the effective values exactly like save, so "Test" works with the
// stored password without the browser ever seeing it. (The wizard keeps its
// own /onboarding/test-navidrome, which deliberately has NO stored-cred
// fallback — it tests creds that aren't saved anywhere yet.)
// ---------------------------------------------------------------------------
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



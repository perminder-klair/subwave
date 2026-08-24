// Durable settings — overrides for values that have static defaults in code.
// Stored at <stateDir>/settings.json. Some apply live (weather location,
// DJ personas, shows); others require a Liquidsoap restart (jingle frequency,
// crossfade duration).
//
// This module is the public barrel for the settings layer. It owns the two
// operations that touch the settings file — load() (lenient, never throws, so a
// hand-edited settings.json can't wedge boot) and update() (strict, throws so
// the admin UI can show a real error) — and re-exports everything else from
// ./settings/:
//
//   vocab.ts       fixed value sets, bounds, seed data, pure coercers
//   defaults.ts    DEFAULTS + BOUNDS
//   store.ts       the loaded-settings cache and its accessors
//   normalize.ts   lenient load-path normalizers
//   validate.ts    strict update() validators
//   persona.ts     persona / show resolution and the prompt fragments
//   liquidsoap.ts  the liquidsoap_*.txt writers
//
// Import from './settings.js' — never from './settings/*' directly outside
// this directory, so the public surface stays one file.

import { readFile, unlink, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { STATE_DIR } from './config.js';
import { writeFileAtomic } from './util/atomic-file.js';
import { DEFAULT_THEME_ID, isValidThemeId, listThemes } from './themes.js';
import { isValidTimezone, setStationTimezone } from './time.js';
// The bitrate vocabularies are no longer read here — the archive/stream
// schemas own them (#1348). They stay in the re-export block below, which
// forwards straight from vocab.js, so the public surface is unchanged.
import {
  CHATTERBOX_VOICE_RE,
  DEFAULT_DJ_PROMPT_TEMPLATE,
  DJ_HOUSE_RULES_MAX,
  DJ_PROMPT_LIMIT,
  DjPromptEntry,
  FESTIVAL_DEFAULTS,
  KOKORO_LANGS,
  KOKORO_LANG_RE,
  KOKORO_VOICE_RE,
  LLM_PROVIDERS,
  LOUDNESS_SOURCES,
  LoudnessSource,
  MOOD_PERIODS,
  PERIOD_MOOD_DEFAULTS,
  POCKET_TTS_VOICE_RE,
  SEARCH_PROVIDERS,
  TTS_CLOUD_PROVIDERS,
  TTS_ENGINES,
  WEATHER_CONDITIONS,
  WEATHER_MOOD_DEFAULTS,
  applyInlineKey,
  applyLlmLegPatch,
  canonicalKokoroLang,
  clamp01,
  clampAgentTimeout,
  clampBudgetSoftPct,
  clampDailyTokenCap,
  clampMaxOutputTokens,
  clampDiscoverySteps,
  clampNoRepeatWindow,
  clampArtistVarietyWindow,
  clampNumCtx,
  clampRepeatPenalty,
  clampTtsGain,
  clampTtsSpeed,
  coerceGuestPersonaIds,
  mintId,
  normalizeLlmKeys,
  normalizeLlmProviderBaseUrls,
  normalizeMoodMap,
  normalizeMoods,
  normalizeTtsCorrections,
  normalizeTtsGainMap,
  normalizeTtsSpeedMap,
  validateTtsCorrectionsStrict,
} from './settings/vocab.js';
import {
  AAC_BITRATE_SET,
  BOUNDS,
  DEFAULTS,
  MP3_BITRATE_SET,
  OPUS_BITRATE_SET,
  coerceMaxTrackSeconds,
  rawMaxTrackSec,
} from './settings/defaults.js';
import { validateCompatParams } from './settings/compat-params.js';
import { parseSettingsPatchKey } from './settings/patch-registry.js';
import { STREAM_BUFFER_SECONDS_BOUNDS, maxTrackSecondsValueSchema } from './schemas/settings.js';
import { minTrackSeconds, peek, setCache } from './settings/store.js';
import {
  SKILL_RENAMES,
  normalizeArchiveRetentionDays,
  normalizeDjPrompts,
  normalizePersonaArray,
  normalizeTtsFallback,
  normalizeSchedule,
  normalizeScheduleOverride,
  normalizeShows,
  normalizeWebhooks,
} from './settings/normalize.js';
import {
  assertNoOrphanMoods,
  validateDjPromptsStrict,
  validatePersonasStrict,
  validateScheduleOverrideStrict,
  validateScheduleStrict,
  validateShowsStrict,
  validateTtsBlock,
  validateWebhooksStrict,
} from './settings/validate.js';
import {
  ICECAST_LISTENER_AUTH_PATH,
  LIQ_ARCHIVE_BITRATE_PATH,
  LIQ_ARCHIVE_ENABLED_PATH,
  LIQ_CROSSFADE_PATH,
  LIQ_JINGLE_RATIO_PATH,
  LIQ_OPUS_ENABLED_PATH,
  LIQ_STREAM_BITRATE_PATH,
  LIQ_STREAM_BUFFER_SECONDS_PATH,
  writeLiquidsoapSettings,
} from './settings/liquidsoap.js';

// ── public surface ─────────────────────────────────────────────────────────
// Re-exported so every existing `from './settings.js'` import keeps working.
export {
  AAC_BITRATES,
  AVATAR_FILENAME_RE,
  DEFAULT_DJ_PROMPT_TEMPLATE,
  DIAL_NEUTRAL,
  DJ_SOULS,
  EMBEDDING_PROVIDERS,
  FESTIVAL_DEFAULTS,
  FREQUENCIES,
  KOKORO_LANGS,
  KOKORO_VOICES,
  KOKORO_VOICE_LANGUAGES,
  LLM_PROVIDERS,
  LOUDNESS_SOURCES,
  MAX_OUTPUT_TOKENS_MAX,
  MAX_OUTPUT_TOKENS_MIN,
  MOODS_LIMIT,
  MOOD_DEFAULTS,
  MOOD_PERIODS,
  MP3_BITRATES,
  OPUS_BITRATES,
  OVERRIDE_MAX_MINUTES,
  OVERRIDE_MIN_MINUTES,
  PERIOD_MOOD_DEFAULTS,
  PERSONA_LIMIT,
  POCKET_TTS_VOICES,
  SCRIPT_LENGTHS,
  SEARCH_PROVIDERS,
  SEED_PERSONAS,
  SHOWS_LIMIT,
  SHOW_ENERGY,
  SHOW_FILTER_VALUES_MAX,
  SHOW_MOODS,
  SHOW_TOPIC_MAX,
  SOUL_MAX,
  TONE_DIALS,
  TTS_CLOUD_PROVIDERS,
  TTS_CORRECTIONS_LIMIT,
  TTS_ENGINES,
  TTS_GAIN_CLAMP_DB,
  TTS_SPEED_DEFAULT,
  TTS_SPEED_MAX,
  TTS_SPEED_MIN,
  WEATHER_CONDITIONS,
  WEATHER_MOOD_DEFAULTS,
  clampMaxOutputTokens,
  clampDiscoverySteps,
  clampTtsGain,
  clampTtsSpeed,
  coerceShowVocals,
  normalizeDial,
  normalizeTtsCorrections,
  personaToneDirectives,
} from './settings/vocab.js';
export { cloudVoiceSettingsAreDefault } from './settings/defaults.js';
export {
  get,
  getDefaults,
  getRedacted,
  llmKeyFor,
  minTrackSeconds,
  moodEntries,
  moodPromptFor,
  moodScheduleFor,
  moodVocab,
  resolveMaxOutputTokens,
  weatherMoodFor,
} from './settings/store.js';
export {
  assertNoOrphanMoods,
  validateDjPromptsStrict,
  // The mood family delegates to schemas/settings.ts now (#1348); update() calls
  // the registry directly, so these are re-exported straight from the source
  // module for the callers that still take the validator API — backup import,
  // onboarding, and scripts/moods.test.ts.
  validateFestivalsStrict,
  validateMoodScheduleStrict,
  validateMoodsStrict,
  validatePersonasStrict,
  validateShowsStrict,
  validateWeatherMoodsStrict,
} from './settings/validate.js';
export {
  agentLanguageReminder,
  agentPersonaPreamble,
  castHouseRulesBlock,
  effectiveFrequency,
  effectiveMaxTrackSec,
  effectsActive,
  getActivePersona,
  getEffectivePersona,
  getOnAirRoster,
  getScheduleOverride,
  languageDirective,
  onAirRosterClause,
  pickOnAirSpeaker,
  renderDjPrompt,
  resolveActiveShow,
  resolveOnAirLocation,
  resolvePersonaById,
  spokenProperNounDirective,
} from './settings/persona.js';
export { writeLiquidsoapSettings } from './settings/liquidsoap.js';
export type {
  DjPromptEntry,
  EraWindow,
  LoudnessSource,
  NormalizedShow,
  ScheduleOverride,
  Webhook,
} from './settings/vocab.js';

// Where uploaded persona avatars live. One file per persona, basename =
// `<personaId>.<ext>`. The dedicated upload route is the only writer; the
// post-update orphan sweep below is the only place that deletes by id.
export const PERSONA_AVATAR_DIR = `${STATE_DIR}/persona-avatars`;

const SETTINGS_PATH = `${STATE_DIR}/settings.json`;
// `shows` (reusable show definitions) and `schedule` (the 7×24 grid) live in
// their own file so settings.json stays readable — a fresh schedule is 168
// null cells. They're conceptually one feature (the show planner) and are
// always loaded/saved together, so they share one file. On first load after
// upgrade, load() migrates them out of settings.json into here.
const SCHEDULE_PATH = `${STATE_DIR}/schedule.json`;

// Integer clamp shared by the settings.requests load()/update() coercions
// below — round, then clamp into [min, max]; a non-finite input (missing,
// non-numeric, hand-edited junk) falls back to `def` rather than NaN.
const intIn = (v: unknown, def: number, min: number, max: number) => {
  // A CLEARED field is absent, not zero. `Number(null)`, `Number('')`,
  // `Number('  ')`, `Number(false)` and `Number([])` are ALL 0 — finite — so
  // without this guard an emptied admin input (parseInt('') → NaN → JSON null
  // on the wire) clamped to `min` and silently committed that field's FLOOR:
  // clearing the station hourly cap set it to 5/hour and closed the request
  // line for everyone, with the form redisplaying 5 as though the operator had
  // typed it. Only a string that actually contains a number, or a real number,
  // is a value — anything else (including the CLI/API patch surface's own
  // spellings of "unset") falls back to `def`.
  if (typeof v === 'string') {
    if (!v.trim()) return def;
  } else if (typeof v !== 'number' && typeof v !== 'bigint') {
    return def;
  }
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
};

export async function load() {
  const cached = peek();
  if (cached) return cached;
  let stored: any = {};
  if (existsSync(SETTINGS_PATH)) {
    try {
      stored = JSON.parse(await readFile(SETTINGS_PATH, 'utf8'));
    } catch {}
  }

  // shows + schedule live in schedule.json. Migration: if schedule.json
  // exists, its contents win (and any leftover keys on settings.json are
  // ignored, to be stripped on the next write). If it doesn't exist, fall
  // back to whatever's on `stored` (legacy in-line copy from a pre-split
  // install) so normalizers below can promote it forward. update() always
  // writes settings.json without these keys, so the next save completes the
  // migration on disk.
  if (existsSync(SCHEDULE_PATH)) {
    try {
      const sched = JSON.parse(await readFile(SCHEDULE_PATH, 'utf8'));
      if (sched && typeof sched === 'object') {
        stored.shows = sched.shows;
        stored.schedule = sched.schedule;
        stored.scheduleOverride = sched.override;
      }
    } catch {}
  }

  // ── personas ──────────────────────────────────────────────────────────────
  // No valid persona roster in settings.json (fresh install) → ship the seed
  // roster of three distinct DJs.
  const personas =
    normalizePersonaArray(stored.personas) ||
    DEFAULTS.personas.map(p => ({ ...p, tts: { ...p.tts } }));
  const personaIds = personas.map(p => p.id);

  const activePersonaId = personaIds.includes(stored.activePersonaId)
    ? stored.activePersonaId
    : personaIds[0];

  // djPrompt — prefer the new field, else migrate the legacy dj.systemPrompt.
  let djPrompt =
    typeof stored.djPrompt === 'string'
      ? stored.djPrompt
      : typeof stored.dj?.systemPrompt === 'string'
        ? stored.dj.systemPrompt
        : '';
  if (djPrompt.trim() === DEFAULT_DJ_PROMPT_TEMPLATE.trim()) djPrompt = '';

  // Prompt-template library. A pre-library settings.json (single custom
  // djPrompt, no djPrompts array) migrates that custom text into a lone
  // library entry so the operator finds their prompt where the UI now lives.
  let djPrompts = normalizeDjPrompts(stored.djPrompts);
  let activeDjPromptId =
    typeof stored.activeDjPromptId === 'string' ? stored.activeDjPromptId : '';
  if (!djPrompts.length && djPrompt.trim()) {
    djPrompts = [{ id: mintId('dp_'), name: 'Custom prompt', text: djPrompt.trim() }];
    activeDjPromptId = djPrompts[0].id;
  }
  // Dangling active id (hand-edited file) falls back to the built-in default.
  if (activeDjPromptId && !djPrompts.some(p => p.id === activeDjPromptId)) {
    activeDjPromptId = '';
  }
  // djPrompt is always the resolved active text — see DEFAULTS.
  djPrompt = djPrompts.find(p => p.id === activeDjPromptId)?.text ?? '';

  const shows = normalizeShows(stored.shows, personaIds);
  const schedule = normalizeSchedule(
    stored.schedule,
    shows.map(s => s.id),
  );
  const scheduleOverride = normalizeScheduleOverride(
    stored.scheduleOverride,
    shows.map(s => s.id),
  );

  const archiveBitrate =
    typeof stored.archive?.bitrate === 'number' && MP3_BITRATE_SET.has(stored.archive.bitrate)
      ? stored.archive.bitrate
      : DEFAULTS.archive.bitrate;

  // Per-provider base-URL maps (issue #1082) — computed once per leg. The flat
  // legacy `baseUrl` on each leg is derived from its map; the stored flat value
  // only survives as a fallback for blobs that predate the map.
  const llmProvider = LLM_PROVIDERS.includes(stored.llm?.provider)
    ? stored.llm.provider
    : DEFAULTS.llm.provider;
  const llmBaseUrls = normalizeLlmProviderBaseUrls(stored.llm, LLM_PROVIDERS);
  const fbStored = stored.llm?.fallback || {};
  const fbProvider = LLM_PROVIDERS.includes(fbStored.provider)
    ? fbStored.provider
    : DEFAULTS.llm.fallback.provider;
  const fbBaseUrls = normalizeLlmProviderBaseUrls(
    { ...fbStored, provider: fbProvider },
    LLM_PROVIDERS,
  );
  // The embedding leg inherits the chat provider when its own is empty, so the
  // legacy dedicated embedding URL (issue #405) must migrate under the
  // EFFECTIVE provider — that's the key the admin UI reads and writes.
  const embedProvider =
    (typeof stored.embedding?.provider === 'string' && stored.embedding.provider.trim()) ||
    llmProvider;
  const embedBaseUrls = normalizeLlmProviderBaseUrls(
    { ...stored.embedding, provider: embedProvider },
    LLM_PROVIDERS,
  );

  const loaded: any = {
    jingleRatio: stored.jingleRatio ?? DEFAULTS.jingleRatio,
    crossfadeDuration: stored.crossfadeDuration ?? DEFAULTS.crossfadeDuration,
    maxTrackSeconds: coerceMaxTrackSeconds(rawMaxTrackSec(stored), false) ?? DEFAULTS.maxTrackSeconds,
    archive: {
      enabled:
        typeof stored.archive?.enabled === 'boolean'
          ? stored.archive.enabled
          : DEFAULTS.archive.enabled,
      bitrate: archiveBitrate,
      // Bounded default with the keep-forever upgrade guard — a pre-existing
      // enabled archive without a stored value stays at 0, never pruned.
      retentionDays: normalizeArchiveRetentionDays(stored.archive),
    },
    stream: {
      opusEnabled:
        typeof stored.stream?.opusEnabled === 'boolean'
          ? stored.stream.opusEnabled
          : DEFAULTS.stream.opusEnabled,
      opusBitrate:
        typeof stored.stream?.opusBitrate === 'number' &&
        OPUS_BITRATE_SET.has(stored.stream.opusBitrate)
          ? stored.stream.opusBitrate
          : DEFAULTS.stream.opusBitrate,
      flacEnabled:
        typeof stored.stream?.flacEnabled === 'boolean'
          ? stored.stream.flacEnabled
          : DEFAULTS.stream.flacEnabled,
      aacEnabled:
        typeof stored.stream?.aacEnabled === 'boolean'
          ? stored.stream.aacEnabled
          : DEFAULTS.stream.aacEnabled,
      aacBitrate:
        typeof stored.stream?.aacBitrate === 'number' &&
        AAC_BITRATE_SET.has(stored.stream.aacBitrate)
          ? stored.stream.aacBitrate
          : DEFAULTS.stream.aacBitrate,
      bitrate:
        typeof stored.stream?.bitrate === 'number' && MP3_BITRATE_SET.has(stored.stream.bitrate)
          ? stored.stream.bitrate
          : DEFAULTS.stream.bitrate,
      oggIcyMetadata:
        typeof stored.stream?.oggIcyMetadata === 'boolean'
          ? stored.stream.oggIcyMetadata
          : DEFAULTS.stream.oggIcyMetadata,
      // Bounded against the SAME constant the save path checks
      // (schemas/settings.ts streamSchema), so a value update() accepted always
      // survives a restart. Omitting this line is what made the setting revert
      // to 22 on every cold load — the mixer handoff file got the string
      // "undefined" and the entrypoint fell back, while /now-playing advertised
      // the default to every player.
      bufferSeconds:
        typeof stored.stream?.bufferSeconds === 'number' &&
        Number.isFinite(stored.stream.bufferSeconds) &&
        stored.stream.bufferSeconds >= STREAM_BUFFER_SECONDS_BOUNDS.min &&
        stored.stream.bufferSeconds <= STREAM_BUFFER_SECONDS_BOUNDS.max
          ? Math.round(stored.stream.bufferSeconds)
          : DEFAULTS.stream.bufferSeconds,
      idleWhenEmpty:
        typeof stored.stream?.idleWhenEmpty === 'boolean'
          ? stored.stream.idleWhenEmpty
          : DEFAULTS.stream.idleWhenEmpty,
      idleAfterMinutes:
        Number.isInteger(stored.stream?.idleAfterMinutes) &&
        stored.stream.idleAfterMinutes >= 1 &&
        stored.stream.idleAfterMinutes <= 1440
          ? stored.stream.idleAfterMinutes
          : DEFAULTS.stream.idleAfterMinutes,
    },
    loudness: {
      targetLufs:
        typeof stored.loudness?.targetLufs === 'number' &&
        stored.loudness.targetLufs >= BOUNDS.loudnessTargetLufs.min &&
        stored.loudness.targetLufs <= BOUNDS.loudnessTargetLufs.max
          ? stored.loudness.targetLufs
          : DEFAULTS.loudness.targetLufs,
      maxBoostDb:
        typeof stored.loudness?.maxBoostDb === 'number' &&
        stored.loudness.maxBoostDb >= BOUNDS.loudnessMaxBoostDb.min &&
        stored.loudness.maxBoostDb <= BOUNDS.loudnessMaxBoostDb.max
          ? stored.loudness.maxBoostDb
          : DEFAULTS.loudness.maxBoostDb,
      source: LOUDNESS_SOURCES.includes(stored.loudness?.source)
        ? (stored.loudness.source as LoudnessSource)
        : DEFAULTS.loudness.source,
    },
    weather: {
      lat: stored.weather?.lat ?? DEFAULTS.weather.lat,
      lng: stored.weather?.lng ?? DEFAULTS.weather.lng,
      locationName: stored.weather?.locationName ?? DEFAULTS.weather.locationName,
      // Absent key → '' → falls back to locationName at read time, so an
      // install predating this field behaves exactly as it did before.
      onAirLocation: stored.weather?.onAirLocation ?? DEFAULTS.weather.onAirLocation,
      units:
        stored.weather?.units === 'imperial' || stored.weather?.units === 'metric'
          ? stored.weather.units
          : DEFAULTS.weather.units,
    },
    djPrompt,
    djPrompts,
    activeDjPromptId,
    // House rules — trimmed + capped on load so a hand-edited settings.json
    // can't bloat every prompt. '' (or a pre-#1182 file with no key) = off.
    djHouseRules:
      typeof stored.djHouseRules === 'string'
        ? stored.djHouseRules.trim().slice(0, DJ_HOUSE_RULES_MAX)
        : '',
    // Station clock switch. Coerce missing/non-boolean (every settings.json
    // written before this key existed) to the default `true`, so an upgrade is
    // byte-identical. See DEFAULTS.djSpeakClock.
    djSpeakClock:
      typeof stored.djSpeakClock === 'boolean'
        ? stored.djSpeakClock
        : DEFAULTS.djSpeakClock,
    station:
      typeof stored.station === 'string' && stored.station.trim()
        ? stored.station.trim().slice(0, 80)
        : DEFAULTS.station,
    stationDescription:
      typeof stored.stationDescription === 'string'
        ? stored.stationDescription.trim().slice(0, 200)
        : DEFAULTS.stationDescription,
    // Invalid stored zone (hand-edited file) falls back to Auto — the
    // station must never crash on a bad zone.
    timezone:
      typeof stored.timezone === 'string' && isValidTimezone(stored.timezone.trim())
        ? stored.timezone.trim()
        : DEFAULTS.timezone,
    locale:
      stored.locale === 'en-US' || stored.locale === 'en-GB'
        ? stored.locale
        : DEFAULTS.locale,
    theme: {
      // We only validate the *shape* here. The active id might reference a
      // theme file that's since been removed; the public /themes endpoint
      // falls back to the default id when that happens, so a stale id doesn't
      // break the UI.
      active:
        typeof stored.theme?.active === 'string' && stored.theme.active.trim()
          ? stored.theme.active.trim()
          : DEFAULTS.theme.active,
    },
    // Festivals loaded from settings.json. Seeded from FESTIVAL_DEFAULTS only
    // when the key is absent/invalid — a persisted empty array means the
    // operator deleted every entry and must stay empty (calendar off).
    festivals: Array.isArray(stored.festivals) ? stored.festivals : FESTIVAL_DEFAULTS,
    // Mood system loaded from settings.json (lenient normalise — never wedges
    // boot). An empty/absent vocabulary reseeds MOOD_DEFAULTS (unusable when
    // empty); the two maps fill missing keys from their seed defaults.
    moods: normalizeMoods(stored.moods),
    moodSchedule: normalizeMoodMap(stored.moodSchedule, MOOD_PERIODS, PERIOD_MOOD_DEFAULTS),
    weatherMoods: normalizeMoodMap(stored.weatherMoods, WEATHER_CONDITIONS, WEATHER_MOOD_DEFAULTS),
    ui: {
      boothBuddy:
        typeof stored.ui?.boothBuddy === 'boolean'
          ? stored.ui.boothBuddy
          : DEFAULTS.ui.boothBuddy,
      skin:
        typeof stored.ui?.skin === 'string' && stored.ui.skin.trim()
          ? stored.ui.skin.trim()
          : DEFAULTS.ui.skin,
      tuneInOverlay:
        typeof stored.ui?.tuneInOverlay === 'boolean'
          ? stored.ui.tuneInOverlay
          : DEFAULTS.ui.tuneInOverlay,
    },
    privacy: {
      privatePlayer:
        typeof stored.privacy?.privatePlayer === 'boolean'
          ? stored.privacy.privatePlayer
          : DEFAULTS.privacy.privatePlayer,
      listenerAuth:
        typeof stored.privacy?.listenerAuth === 'boolean'
          ? stored.privacy.listenerAuth
          : DEFAULTS.privacy.listenerAuth,
      password:
        typeof stored.privacy?.password === 'string'
          ? stored.privacy.password
          : DEFAULTS.privacy.password,
      // Absent/non-boolean coerces to the default (false), so every settings.json
      // written before this key existed keeps its public reads byte-identical.
      publishPersonaSouls:
        typeof stored.privacy?.publishPersonaSouls === 'boolean'
          ? stored.privacy.publishPersonaSouls
          : DEFAULTS.privacy.publishPersonaSouls,
    },
    // Listener-request pipeline gates. Absent/malformed settings.json (every
    // install predating this key) coerces field-by-field to DEFAULTS.requests,
    // never undefined/NaN — later tasks gate on settings.get()?.requests.
    requests: {
      enabled:
        typeof stored.requests?.enabled === 'boolean'
          ? stored.requests.enabled
          : DEFAULTS.requests.enabled,
      maxPending: intIn(stored.requests?.maxPending, DEFAULTS.requests.maxPending, 1, 50),
      globalHourlyCap: intIn(
        stored.requests?.globalHourlyCap,
        DEFAULTS.requests.globalHourlyCap,
        5,
        500,
      ),
      repeatCooldownMin: intIn(
        stored.requests?.repeatCooldownMin,
        DEFAULTS.requests.repeatCooldownMin,
        0,
        1440,
      ),
      cooldownSec: intIn(stored.requests?.cooldownSec, DEFAULTS.requests.cooldownSec, 5, 600),
      perIpHourlyCap: intIn(
        stored.requests?.perIpHourlyCap,
        DEFAULTS.requests.perIpHourlyCap,
        1,
        100,
      ),
      onePendingPerIp:
        typeof stored.requests?.onePendingPerIp === 'boolean'
          ? stored.requests.onePendingPerIp
          : DEFAULTS.requests.onePendingPerIp,
    },
    personas,
    activePersonaId,
    shows,
    schedule,
    scheduleOverride,
    tts: {
      // Station-wide voice switch. Coerce missing/non-boolean (every settings.json
      // written before this key existed) to the default `true`, so an upgrade is
      // byte-identical. See DEFAULTS.tts.enabled.
      enabled:
        typeof stored.tts?.enabled === 'boolean'
          ? stored.tts.enabled
          : DEFAULTS.tts.enabled,
      defaultEngine: TTS_ENGINES.includes(stored.tts?.defaultEngine)
        ? stored.tts.defaultEngine
        : DEFAULTS.tts.defaultEngine,
      // Operator-chosen rescue slot. Reuses the persona voice-slot normaliser
      // so the per-engine voice rules can't drift between the two; only the
      // `enabled` flag is extra. Absent/non-boolean coerces to the default
      // (off), so an upgrade from a settings.json written before this key
      // existed keeps today's chain byte-for-byte.
      fallback: normalizeTtsFallback(stored.tts?.fallback),
      // Stored as a plain boolean; coerce missing/non-boolean (older saves) to
      // the default. See DEFAULTS.tts.heavyEnabled for the semantics.
      heavyEnabled:
        typeof stored.tts?.heavyEnabled === 'boolean'
          ? stored.tts.heavyEnabled
          : DEFAULTS.tts.heavyEnabled,
      kokoro: {
        voice:
          typeof stored.tts?.kokoro?.voice === 'string' &&
          KOKORO_VOICE_RE.test(stored.tts.kokoro.voice)
            ? stored.tts.kokoro.voice
            : DEFAULTS.tts.kokoro.voice,
        // Legacy codes are canonicalised first (`fr` → `fr-fr`, #1213), so an
        // operator who chose French before the fix keeps French rather than
        // dropping back to the auto-detect default.
        lang:
          typeof stored.tts?.kokoro?.lang === 'string' &&
          KOKORO_LANG_RE.test(canonicalKokoroLang(stored.tts.kokoro.lang))
            ? canonicalKokoroLang(stored.tts.kokoro.lang)
            : DEFAULTS.tts.kokoro.lang,
      },
      chatterbox: {
        referenceVoice:
          typeof stored.tts?.chatterbox?.referenceVoice === 'string' &&
          (stored.tts.chatterbox.referenceVoice === '' ||
            CHATTERBOX_VOICE_RE.test(stored.tts.chatterbox.referenceVoice))
            ? stored.tts.chatterbox.referenceVoice
            : DEFAULTS.tts.chatterbox.referenceVoice,
      },
      pocketTts: {
        voice:
          typeof stored.tts?.pocketTts?.voice === 'string'
          && (POCKET_TTS_VOICE_RE.test(stored.tts.pocketTts.voice)
            || CHATTERBOX_VOICE_RE.test(stored.tts.pocketTts.voice))
            ? stored.tts.pocketTts.voice
            : DEFAULTS.tts.pocketTts.voice,
      },
      cloud: {
        // Explicit boolean wins; otherwise an install that already had a saved
        // cloud key keeps cloud on so the upgrade doesn't silently disable it.
        enabled:
          typeof stored.tts?.cloud?.enabled === 'boolean'
            ? stored.tts.cloud.enabled
            : !!(stored.tts?.cloud?.apiKey || stored.tts?.cloud?.compatApiKey),
        provider: TTS_CLOUD_PROVIDERS.includes(stored.tts?.cloud?.provider)
          ? stored.tts.cloud.provider
          : DEFAULTS.tts.cloud.provider,
        model:
          typeof stored.tts?.cloud?.model === 'string' && stored.tts.cloud.model.trim()
            ? stored.tts.cloud.model.trim()
            : DEFAULTS.tts.cloud.model,
        voice:
          typeof stored.tts?.cloud?.voice === 'string' && stored.tts.cloud.voice.trim()
            ? stored.tts.cloud.voice.trim()
            : DEFAULTS.tts.cloud.voice,
        // Migrate the old shared slot into the dedicated compatibility slot
        // only when it was saved under the compatibility provider. Managed
        // provider keys remain legacy-readable but can no longer cross over.
        apiKey:
          stored.tts?.cloud?.provider !== 'openai-compatible'
          && typeof stored.tts?.cloud?.apiKey === 'string'
            ? stored.tts.cloud.apiKey
            : '',
        compatApiKey:
          typeof stored.tts?.cloud?.compatApiKey === 'string'
            ? stored.tts.cloud.compatApiKey
            : stored.tts?.cloud?.provider === 'openai-compatible'
              && typeof stored.tts?.cloud?.apiKey === 'string'
              ? stored.tts.cloud.apiKey
              : '',
        baseUrl:
          typeof stored.tts?.cloud?.baseUrl === 'string'
            ? stored.tts.cloud.baseUrl.trim()
            : DEFAULTS.tts.cloud.baseUrl,
        // ElevenLabs voice_settings — clamped to [0,1] on load so a hand-edited
        // settings.json can't ship an out-of-range value to the provider (which
        // would 400 the whole speak call, silently dropping the voice).
        voiceStability:
          typeof stored.tts?.cloud?.voiceStability === 'number'
            ? clamp01(stored.tts.cloud.voiceStability)
            : DEFAULTS.tts.cloud.voiceStability,
        voiceStyle:
          typeof stored.tts?.cloud?.voiceStyle === 'number'
            ? clamp01(stored.tts.cloud.voiceStyle)
            : DEFAULTS.tts.cloud.voiceStyle,
        voiceSimilarityBoost:
          typeof stored.tts?.cloud?.voiceSimilarityBoost === 'number'
            ? clamp01(stored.tts.cloud.voiceSimilarityBoost)
            : DEFAULTS.tts.cloud.voiceSimilarityBoost,
        voiceUseSpeakerBoost:
          typeof stored.tts?.cloud?.voiceUseSpeakerBoost === 'boolean'
            ? stored.tts.cloud.voiceUseSpeakerBoost
            : DEFAULTS.tts.cloud.voiceUseSpeakerBoost,
        // Fish Audio controls — lenient load for hand-edited/older settings.
        // Only the Fish provider sends these fields on the wire.
        temperature:
          typeof stored.tts?.cloud?.temperature === 'number' && Number.isFinite(stored.tts.cloud.temperature)
            ? clamp01(stored.tts.cloud.temperature)
            : DEFAULTS.tts.cloud.temperature,
        topP:
          typeof stored.tts?.cloud?.topP === 'number' && Number.isFinite(stored.tts.cloud.topP)
            ? clamp01(stored.tts.cloud.topP)
            : DEFAULTS.tts.cloud.topP,
        latency:
          ['low', 'normal', 'balanced'].includes(stored.tts?.cloud?.latency)
            ? stored.tts.cloud.latency
            : DEFAULTS.tts.cloud.latency,
        // Extra openai-compatible body fields. This block composes tts.cloud
        // field by field rather than spreading DEFAULTS, so a key missing here
        // is a key that survives a save but vanishes on the next restart —
        // params would quietly stop applying and nothing would say why.
        // Lenient like the Fish knobs above: an invalid hand-edited list drops
        // to none rather than throwing, because settings.load() failing means
        // the controller doesn't boot at all.
        compatParams: (() => {
          try {
            return validateCompatParams(stored.tts?.cloud?.compatParams);
          } catch {
            return [];
          }
        })(),
      },
      remote: {
        url:
          typeof stored.tts?.remote?.url === 'string'
            ? stored.tts.remote.url.trim()
            : DEFAULTS.tts.remote.url,
      },
      // Per-engine gain map — one clean gain per known engine, missing keys → 0,
      // unknown keys dropped. So an older save (no gainDb) loads at unity.
      gainDb: normalizeTtsGainMap(stored.tts?.gainDb),
      // Per-engine speed map — one clean multiplier per known engine, missing
      // keys → 1.0, unknown keys dropped. An older save (no speed) loads at unity.
      speed: normalizeTtsSpeedMap(stored.tts?.speed),
      // Operator speech corrections — malformed entries dropped, list capped.
      // An older save (no corrections) loads as [].
      corrections: normalizeTtsCorrections(stored.tts?.corrections),
    },
    llm: {
      provider: LLM_PROVIDERS.includes(stored.llm?.provider)
        ? stored.llm.provider
        : DEFAULTS.llm.provider,
      model: typeof stored.llm?.model === 'string' ? stored.llm.model.trim() : DEFAULTS.llm.model,
      // Legacy single slot is migrated into `keys` below, then cleared — there
      // is exactly one source of truth for inline keys (issue #657).
      apiKey: '',
      keys: normalizeLlmKeys(stored.llm),
      ollamaUrl:
        typeof stored.llm?.ollamaUrl === 'string'
          ? stored.llm.ollamaUrl.trim()
          : DEFAULTS.llm.ollamaUrl,
      providerBaseUrls: llmBaseUrls,
      baseUrl: llmBaseUrls[llmProvider]
        ?? (typeof stored.llm?.baseUrl === 'string' ? stored.llm.baseUrl.trim() : DEFAULTS.llm.baseUrl),
      reasoning:
        typeof stored.llm?.reasoning === 'boolean' ? stored.llm.reasoning : DEFAULTS.llm.reasoning,
      // Only 'auto' downgrades the forced tool_choice; anything else (incl. a
      // pre-field settings.json) lands on the 'required' default. See issue #570.
      toolChoice: stored.llm?.toolChoice === 'auto' ? 'auto' : DEFAULTS.llm.toolChoice,
      // Clamp to a sane band: 0 disables (Ollama default), else [2048, 131072].
      // Non-numeric/NaN falls back to the default. Floored to an integer.
      numCtx: clampNumCtx(stored.llm?.numCtx, DEFAULTS.llm.numCtx),
      // Clamped to [1.0, 2.0]; 1.0 = off. This block does NOT spread DEFAULTS,
      // so a field missing HERE is written to settings.json by update() and then
      // silently dropped on the next cold load — which is exactly what happened
      // to repeat_penalty between #918 and #1327: the operator's configured
      // value survived in memory for that process, vanished on restart, and
      // llama.cpp fell back to its own 1.0 default with nothing in the logs.
      repeatPenalty: clampRepeatPenalty(stored.llm?.repeatPenalty, DEFAULTS.llm.repeatPenalty),
      pickerAgent:
        typeof stored.llm?.pickerAgent === 'boolean'
          ? stored.llm.pickerAgent
          : DEFAULTS.llm.pickerAgent,
      // Clamped to [0, 1000] (≤ the 2500-entry sidecar cap); pre-field
      // settings.json picks up the config/env-seeded default.
      noRepeatWindow: clampNoRepeatWindow(stored.llm?.noRepeatWindow, DEFAULTS.llm.noRepeatWindow),
      // Clamped to [0, 25]; a settings.json written before the field existed
      // picks up the shipped default, so an upgrade turns spacing on rather
      // than silently keeping the on-air-only guard it was filed against.
      artistVarietyWindow: clampArtistVarietyWindow(
        stored.llm?.artistVarietyWindow,
        DEFAULTS.llm.artistVarietyWindow,
      ),
      requestWebResolve:
        typeof stored.llm?.requestWebResolve === 'boolean'
          ? stored.llm.requestWebResolve
          : DEFAULTS.llm.requestWebResolve,
      // Clamped to [5s, 300s]; settings.json files from before the field
      // existed pick up the default.
      agentTimeoutMs: clampAgentTimeout(stored.llm?.agentTimeoutMs, DEFAULTS.llm.agentTimeoutMs),
      pauseWhenEmpty:
        typeof stored.llm?.pauseWhenEmpty === 'boolean'
          ? stored.llm.pauseWhenEmpty
          : DEFAULTS.llm.pauseWhenEmpty,
      // Budget cap — settings.json files from before these fields existed pick
      // up the defaults (0 = disabled, so they behave exactly as before).
      dailyTokenCap: clampDailyTokenCap(stored.llm?.dailyTokenCap, DEFAULTS.llm.dailyTokenCap),
      budgetSoftPct: clampBudgetSoftPct(stored.llm?.budgetSoftPct, DEFAULTS.llm.budgetSoftPct),
      // Per-call output cap (issue #712) — pre-existing settings.json lacks the
      // field and picks up the 0 default (= built-in per-strategy defaults).
      maxOutputTokens: clampMaxOutputTokens(stored.llm?.maxOutputTokens, DEFAULTS.llm.maxOutputTokens),
      // Discovery-round override — pre-existing settings.json lacks the field
      // and picks up the 0 default (= follow the provider capability table), so
      // an upgraded install behaves exactly as it did before the setting existed.
      discoverySteps: clampDiscoverySteps(stored.llm?.discoverySteps, DEFAULTS.llm.discoverySteps),
      exemptRequests:
        typeof stored.llm?.exemptRequests === 'boolean'
          ? stored.llm.exemptRequests
          : DEFAULTS.llm.exemptRequests,
      debugRawRequests:
        typeof stored.llm?.debugRawRequests === 'boolean'
          ? stored.llm.debugRawRequests
          : DEFAULTS.llm.debugRawRequests,
      // Backup leg — same connection fields as the primary, coerced identically.
      fallback: (() => {
        const fb = stored.llm?.fallback || {};
        return {
          enabled: typeof fb.enabled === 'boolean' ? fb.enabled : DEFAULTS.llm.fallback.enabled,
          provider: LLM_PROVIDERS.includes(fb.provider)
            ? fb.provider
            : DEFAULTS.llm.fallback.provider,
          model: typeof fb.model === 'string' ? fb.model.trim() : DEFAULTS.llm.fallback.model,
          // Legacy fallback slot migrated into settings.llm.keys above, then
          // cleared. The fallback resolves its key from `keys[fb.provider]`.
          apiKey: '',
          ollamaUrl:
            typeof fb.ollamaUrl === 'string' ? fb.ollamaUrl.trim() : DEFAULTS.llm.fallback.ollamaUrl,
          providerBaseUrls: fbBaseUrls,
          baseUrl: fbBaseUrls[fbProvider]
            ?? (typeof fb.baseUrl === 'string' ? fb.baseUrl.trim() : DEFAULTS.llm.fallback.baseUrl),
          reasoning:
            typeof fb.reasoning === 'boolean' ? fb.reasoning : DEFAULTS.llm.fallback.reasoning,
          toolChoice: fb.toolChoice === 'auto' ? 'auto' : DEFAULTS.llm.fallback.toolChoice,
          numCtx: clampNumCtx(fb.numCtx, DEFAULTS.llm.fallback.numCtx),
          repeatPenalty: clampRepeatPenalty(fb.repeatPenalty, DEFAULTS.llm.fallback.repeatPenalty),
          discoverySteps: clampDiscoverySteps(fb.discoverySteps, DEFAULTS.llm.fallback.discoverySteps),
        };
      })(),
    },
    search: {
      provider: SEARCH_PROVIDERS.includes(stored.search?.provider)
        ? stored.search.provider
        : DEFAULTS.search.provider,
      apiKey: typeof stored.search?.apiKey === 'string' ? stored.search.apiKey : '',
      baseUrl: typeof stored.search?.baseUrl === 'string' ? stored.search.baseUrl : DEFAULTS.search.baseUrl,
    },
    embedding: {
      enabled:
        typeof stored.embedding?.enabled === 'boolean'
          ? stored.embedding.enabled
          : DEFAULTS.embedding.enabled,
      provider:
        typeof stored.embedding?.provider === 'string'
          ? stored.embedding.provider.trim()
          : DEFAULTS.embedding.provider,
      model:
        typeof stored.embedding?.model === 'string'
          ? stored.embedding.model.trim()
          : DEFAULTS.embedding.model,
      providerBaseUrls: embedBaseUrls,
      // Derived with the effective provider (own, else the chat provider) so a
      // dedicated embedding URL keeps working when the provider is inherited.
      baseUrl: embedBaseUrls[embedProvider]
        ?? (typeof stored.embedding?.baseUrl === 'string' ? stored.embedding.baseUrl.trim() : DEFAULTS.embedding.baseUrl),
      ollamaUrl:
        typeof stored.embedding?.ollamaUrl === 'string'
          ? stored.embedding.ollamaUrl.trim()
          : DEFAULTS.embedding.ollamaUrl,
      apiKey:
        typeof stored.embedding?.apiKey === 'string'
          ? stored.embedding.apiKey.trim()
          : DEFAULTS.embedding.apiKey,
      seedCount:
        Number.isFinite(stored.embedding?.seedCount) && stored.embedding.seedCount >= 0
          ? Math.floor(stored.embedding.seedCount)
          : DEFAULTS.embedding.seedCount,
      knnNeighbours:
        Number.isFinite(stored.embedding?.knnNeighbours) && stored.embedding.knnNeighbours >= 1
          ? Math.floor(stored.embedding.knnNeighbours)
          : DEFAULTS.embedding.knnNeighbours,
      moodVoteThreshold:
        Number.isFinite(stored.embedding?.moodVoteThreshold)
          ? clamp01(stored.embedding.moodVoteThreshold)
          : DEFAULTS.embedding.moodVoteThreshold,
      confidenceThreshold:
        Number.isFinite(stored.embedding?.confidenceThreshold)
          ? clamp01(stored.embedding.confidenceThreshold)
          : DEFAULTS.embedding.confidenceThreshold,
      maxActiveLearningRounds:
        Number.isFinite(stored.embedding?.maxActiveLearningRounds)
        && stored.embedding.maxActiveLearningRounds >= 0
          ? Math.floor(stored.embedding.maxActiveLearningRounds)
          : DEFAULTS.embedding.maxActiveLearningRounds,
      audioFusionWeight:
        Number.isFinite(stored.embedding?.audioFusionWeight)
          ? clamp01(stored.embedding.audioFusionWeight)
          : DEFAULTS.embedding.audioFusionWeight,
      batchSize:
        Number.isFinite(stored.embedding?.batchSize) && stored.embedding.batchSize >= 1
          ? Math.max(1, Math.min(50, Math.floor(stored.embedding.batchSize)))
          : DEFAULTS.embedding.batchSize,
      enrichment: {
        lastfmTags:
          typeof stored.embedding?.enrichment?.lastfmTags === 'boolean'
            ? stored.embedding.enrichment.lastfmTags
            : DEFAULTS.embedding.enrichment.lastfmTags,
        lyrics:
          typeof stored.embedding?.enrichment?.lyrics === 'boolean'
            ? stored.embedding.enrichment.lyrics
            : DEFAULTS.embedding.enrichment.lyrics,
        originalYear:
          typeof stored.embedding?.enrichment?.originalYear === 'boolean'
            ? stored.embedding.enrichment.originalYear
            : DEFAULTS.embedding.enrichment.originalYear,
      },
    },
    skills: {
      enabled: Object.fromEntries(
        Object.entries(stored.skills?.enabled || {})
          .filter(([, v]) => typeof v === 'boolean')
          // Same rename applied to the operator's enable toggle map so an
          // existing `random-facts: false` carries forward as `curiosity: false`.
          .map(([k, v]) => [SKILL_RENAMES[k] || k, v]),
      ),
    },
    audio: {
      embeddings: typeof stored.audio?.embeddings === 'boolean' ? stored.audio.embeddings : DEFAULTS.audio.embeddings,
      vocalActivity: typeof stored.audio?.vocalActivity === 'boolean' ? stored.audio.vocalActivity : DEFAULTS.audio.vocalActivity,
      stemCache: typeof stored.audio?.stemCache === 'boolean' ? stored.audio.stemCache : DEFAULTS.audio.stemCache,
      stemCacheGb: Number.isFinite(stored.audio?.stemCacheGb) && stored.audio.stemCacheGb > 0
        ? stored.audio.stemCacheGb
        : DEFAULTS.audio.stemCacheGb,
      analyzeQuietOnly:
        typeof stored.audio?.analyzeQuietOnly === 'boolean'
          ? stored.audio.analyzeQuietOnly
          : DEFAULTS.audio.analyzeQuietOnly,
      analyzeQuietMinutes: Number.isFinite(stored.audio?.analyzeQuietMinutes)
        ? Math.max(1, Math.min(120, Math.floor(stored.audio.analyzeQuietMinutes)))
        : DEFAULTS.audio.analyzeQuietMinutes,
    },
    transitions: {
      pairDrain: typeof stored.transitions?.pairDrain === 'boolean' ? stored.transitions.pairDrain : DEFAULTS.transitions.pairDrain,
      stemBlends: typeof stored.transitions?.stemBlends === 'boolean' ? stored.transitions.stemBlends : DEFAULTS.transitions.stemBlends,
    },
    sfx: {
      enabled: typeof stored.sfx?.enabled === 'boolean' ? stored.sfx.enabled : DEFAULTS.sfx.enabled,
    },
    beds: {
      enabled: typeof stored.beds?.enabled === 'boolean' ? stored.beds.enabled : DEFAULTS.beds.enabled,
      thresholdSec: Number.isFinite(stored.beds?.thresholdSec) ? stored.beds.thresholdSec : DEFAULTS.beds.thresholdSec,
      crossSec: Number.isFinite(stored.beds?.crossSec) ? stored.beds.crossSec : DEFAULTS.beds.crossSec,
    },
    webhooks: normalizeWebhooks(stored.webhooks),
    webhooksPolicy: {
      trackPlayListenerGated:
        typeof stored.webhooksPolicy?.trackPlayListenerGated === 'boolean'
          ? stored.webhooksPolicy.trackPlayListenerGated
          : DEFAULTS.webhooksPolicy.trackPlayListenerGated,
    },
    scrobble: {
      lastfm: {
        enabled:
          typeof stored.scrobble?.lastfm?.enabled === 'boolean'
            ? stored.scrobble.lastfm.enabled
            : DEFAULTS.scrobble.lastfm.enabled,
        apiKey:
          typeof stored.scrobble?.lastfm?.apiKey === 'string'
            ? stored.scrobble.lastfm.apiKey
            : '',
        apiSecret:
          typeof stored.scrobble?.lastfm?.apiSecret === 'string'
            ? stored.scrobble.lastfm.apiSecret
            : '',
        sessionKey:
          typeof stored.scrobble?.lastfm?.sessionKey === 'string'
            ? stored.scrobble.lastfm.sessionKey
            : '',
        username:
          typeof stored.scrobble?.lastfm?.username === 'string'
            ? stored.scrobble.lastfm.username.trim().slice(0, 40)
            : '',
      },
      listenbrainz: {
        enabled:
          typeof stored.scrobble?.listenbrainz?.enabled === 'boolean'
            ? stored.scrobble.listenbrainz.enabled
            : DEFAULTS.scrobble.listenbrainz.enabled,
        userToken:
          typeof stored.scrobble?.listenbrainz?.userToken === 'string'
            ? stored.scrobble.listenbrainz.userToken
            : '',
        username:
          typeof stored.scrobble?.listenbrainz?.username === 'string'
            ? stored.scrobble.listenbrainz.username.trim().slice(0, 40)
            : '',
        baseUrl:
          typeof stored.scrobble?.listenbrainz?.baseUrl === 'string'
            ? stored.scrobble.listenbrainz.baseUrl.trim().slice(0, 500)
            : '',
      },
    },
    likes: {
      enabled:
        typeof stored.likes?.enabled === 'boolean'
          ? stored.likes.enabled
          : DEFAULTS.likes.enabled,
      starInNavidrome:
        typeof stored.likes?.starInNavidrome === 'boolean'
          ? stored.likes.starInNavidrome
          : DEFAULTS.likes.starInNavidrome,
      influenceDj:
        typeof stored.likes?.influenceDj === 'boolean'
          ? stored.likes.influenceDj
          : DEFAULTS.likes.influenceDj,
      maxTracks: Number.isFinite(Number(stored.likes?.maxTracks))
        ? Math.min(25, Math.max(1, Math.round(Number(stored.likes.maxTracks))))
        : DEFAULTS.likes.maxTracks,
      windowDays: Number.isFinite(Number(stored.likes?.windowDays))
        ? Math.min(365, Math.max(0, Math.round(Number(stored.likes.windowDays))))
        : DEFAULTS.likes.windowDays,
    },
  };
  setCache(loaded);
  if (typeof stored.timezone === 'string' && stored.timezone.trim() && !loaded.timezone) {
    console.warn(`[settings] ignoring invalid timezone "${stored.timezone.trim()}" — using Auto (container TZ)`);
  }
  setStationTimezone(loaded.timezone);
  return loaded;
}

// Lenient normalizer — used by load(). Drops invalid entries silently rather
// than failing the whole boot.

export async function update(patch) {
  const cur = await load();
  const next = JSON.parse(JSON.stringify(cur));
  let restart = false;

  // On the shared schema (#1348) — see settings/patch-registry.ts. The schema
  // says what the value may BE; whether applying it costs a mixer restart stays
  // here, because that is a property of the transition, not of the value.
  if ('jingleRatio' in patch) {
    const v = parseSettingsPatchKey<number>('jingleRatio', patch.jingleRatio);
    if (v !== cur.jingleRatio) {
      next.jingleRatio = v;
      restart = true;
    }
  }
  if ('crossfadeDuration' in patch) {
    const v = parseSettingsPatchKey<number>('crossfadeDuration', patch.crossfadeDuration);
    if (v !== cur.crossfadeDuration) {
      next.crossfadeDuration = v;
      restart = true;
    }
  }
  if ('maxTrackSeconds' in patch || 'maxTrackMinutes' in patch) {
    // The bound lives once, in the shared schema — this applies it to the
    // RESOLVED value (seconds, or the legacy minutes alias × 60), which is the
    // figure the precedence rule actually selected.
    const parsedCap = maxTrackSecondsValueSchema(BOUNDS.maxTrackSeconds).safeParse(
      rawMaxTrackSec(patch),
    );
    if (!parsedCap.success) throw new Error(parsedCap.error.issues[0].message);
    const v = parsedCap.data;
    // Non-zero caps must clear the crossfade-relative floor (0 = unlimited stays
    // allowed): the track crossfades out starting crossfadeDuration before the
    // cap, so a shorter cap is degenerate / leaves no solo airtime. Uses next's
    // crossfade, already applied above if this same patch changed it.
    const floor = minTrackSeconds(next);
    if (v !== 0 && v < floor) {
      throw new Error(
        `maxTrackSeconds must be 0 (no limit) or at least ${floor}s`,
      );
    }
    // Read live by queue.drainToLiquidsoap + the auto-playlist refresh to stamp
    // liq_cue_out; no Liquidsoap file is written, so no restart.
    next.maxTrackSeconds = v;
  }
  if ('archive' in patch) {
    const a = parseSettingsPatchKey<{
      enabled?: boolean;
      bitrate?: number;
      retentionDays?: number;
    }>('archive', patch.archive);
    if (a.enabled !== undefined && a.enabled !== cur.archive.enabled) {
      next.archive.enabled = a.enabled;
      restart = true;
    }
    if (a.bitrate !== undefined && a.bitrate !== cur.archive.bitrate) {
      next.archive.bitrate = a.bitrate;
      restart = true;
    }
    if (a.retentionDays !== undefined) {
      // Enforced controller-side (scheduler cleanup), no Liquidsoap file or
      // restart involved.
      next.archive.retentionDays = a.retentionDays;
    }
  }
  if ('stream' in patch) {
    const st = parseSettingsPatchKey<Record<string, number | boolean | undefined>>(
      'stream',
      patch.stream,
    );
    // Every encoder field restarts the mixer, and only on a real change against
    // `cur` — the schema validated the value, this decides the transition cost.
    for (const k of [
      'opusEnabled',
      'opusBitrate',
      'flacEnabled',
      'oggIcyMetadata',
      'aacEnabled',
      'aacBitrate',
      'bitrate',
    ] as const) {
      if (st[k] !== undefined && st[k] !== (cur.stream as Record<string, unknown>)[k]) {
        (next.stream as Record<string, unknown>)[k] = st[k];
        restart = true;
      }
    }
    // Listener-side buffer depth (Icecast <burst-size>, seconds). Deep survives
    // a dead zone but sits further behind the live edge; shallow syncs tighter
    // and stalls more. 0 disables burst-on-connect. Capped at 60s: past that a
    // listener is a full minute behind and <queue-size> (which must comfortably
    // exceed the burst) gets unreasonable.
    //
    // restart=true is not just a mixer concern — burst lives in icecast.xml,
    // rendered once by the broadcast entrypoint at container boot. It applies
    // anyway because liquidsoap and icecast share a container the entrypoint
    // `wait -n`s on: the telnet restart shuts liquidsoap down, the container
    // bounces, and the template re-renders on the way back up.
    //
    // Change-gated against `cur` like the encoder fields above, which needs
    // load() to actually compose bufferSeconds — while it didn't, `cur` read
    // `undefined` on every cold-loaded process, so this fired unconditionally
    // AND the operator's value was lost on restart. Kept out of the loop above
    // because it is not an encoder field and restarts for a different reason.
    if (st.bufferSeconds !== undefined && st.bufferSeconds !== cur.stream.bufferSeconds) {
      next.stream.bufferSeconds = st.bufferSeconds as number;
      restart = true;
    }
    // Idle pause is enforced controller-side over telnet (broadcast/
    // stream-idle.ts) — no Liquidsoap boot file, no mixer restart. Turning it
    // off mid-idle is handled by the monitor's next tick, which resumes the
    // programme.
    if (st.idleWhenEmpty !== undefined) {
      next.stream.idleWhenEmpty = st.idleWhenEmpty as boolean;
    }
    if (st.idleAfterMinutes !== undefined) {
      next.stream.idleAfterMinutes = st.idleAfterMinutes as number;
    }
  }
  if ('loudness' in patch) {
    // Read live by queue.applyLoudnessGain when each track is annotated — no
    // Liquidsoap file, no restart. Applies from the next queued track.
    const lo = parseSettingsPatchKey<Record<string, unknown>>('loudness', patch.loudness);
    for (const k of ['targetLufs', 'maxBoostDb', 'source'] as const) {
      if (lo[k] !== undefined) (next.loudness as Record<string, unknown>)[k] = lo[k];
    }
  }
  if ('weather' in patch) {
    const w = parseSettingsPatchKey<Record<string, unknown>>('weather', patch.weather);
    // locationName / onAirLocation come back `undefined` when the schema
    // decided to IGNORE the value (non-string, or blank for locationName) —
    // the same silent drop the typeof guards did here.
    for (const k of ['lat', 'lng', 'locationName', 'onAirLocation', 'units'] as const) {
      if (w[k] !== undefined) (next.weather as Record<string, unknown>)[k] = w[k];
    }
  }
  if ('station' in patch) {
    // The schema resolves '' to the product default; the restart decision is
    // still a comparison against `cur` and stays here.
    const resolved = parseSettingsPatchKey<string>('station', patch.station);
    if (resolved !== cur.station) {
      restart = true;
    }
    next.station = resolved;
  }
  if ('stationDescription' in patch) {
    // No `restart` — this never reaches the DJ prompt or a liquidsoap_*.txt
    // file; it is read per-request by the web app's generateMetadata().
    next.stationDescription = parseSettingsPatchKey<string>(
      'stationDescription',
      patch.stationDescription,
    );
  }
  if ('timezone' in patch) {
    // '' = back to Auto (container TZ). setStationTimezone() below pushes the
    // accepted value into time.ts's module state — that stays here.
    next.timezone = parseSettingsPatchKey<string>('timezone', patch.timezone);
  }
  if ('locale' in patch) {
    next.locale = parseSettingsPatchKey<string>('locale', patch.locale);
  }
  if ('theme' in patch) {
    const t = parseSettingsPatchKey<{ active?: string }>('theme', patch.theme);
    if (t.active !== undefined) {
      const v = t.active;
      // A stale active theme (a retired built-in renamed in 58c3782b, or a
      // custom theme that isn't on disk) falls back to the built-in default
      // rather than failing the save — same tolerance as shows[].themeId above
      // and the serve-time fallback in GET /themes, and the same precedent as the
      // activeDjPromptId reset. Throwing here aborted the whole restore for any
      // install whose active theme id had since been retired (issue #917).
      next.theme.active = (await isValidThemeId(v)) ? v : DEFAULT_THEME_ID;
      if (next.theme.active !== v) {
        console.warn(`[theme] active theme "${v}" is not a known theme id — falling back to "${DEFAULT_THEME_ID}"`);
      }
    }
  }
  // Mood system (context-only — no Liquidsoap restart). Validate the vocabulary
  // first so the maps + festivals in the same patch can reference a newly-added
  // mood. The in-use removal guard (assertNoOrphanMoods) runs after shows are
  // validated below, so a same-patch show edit is seen.
  if ('moods' in patch) {
    next.moods = parseSettingsPatchKey('moods', patch.moods);
  }
  // The EFFECTIVE vocabulary — the same-patch one when `moods` rides along.
  // Captured ONCE so the maps, festivals and shows below all judge against the
  // same list; re-deriving per branch is a latent divergence.
  const moodNames = (next.moods || []).map((m: any) => m.name);
  // The mood family needs only the vocabulary; `showIds: null` says this branch
  // is not in a position to check roster membership — shows are validated below.
  const moodCtx = { moodNames, showIds: null };
  if ('moodSchedule' in patch) {
    next.moodSchedule = parseSettingsPatchKey('moodSchedule', patch.moodSchedule, moodCtx);
  }
  if ('weatherMoods' in patch) {
    next.weatherMoods = parseSettingsPatchKey('weatherMoods', patch.weatherMoods, moodCtx);
  }
  if ('festivals' in patch) {
    next.festivals = parseSettingsPatchKey('festivals', patch.festivals, moodCtx);
  }
  // Prompt-template library. `djPrompts` replaces the whole library;
  // `activeDjPromptId` switches which entry renders ('' = built-in default).
  // The legacy single-field `djPrompt` (onboarding wizard, older clients)
  // still works by mapping onto the library: '' selects the default, custom
  // text reuses the entry with identical text or appends a "Custom prompt".
  if ('djPrompts' in patch) {
    next.djPrompts = validateDjPromptsStrict(patch.djPrompts);
  }
  if ('activeDjPromptId' in patch) {
    next.activeDjPromptId = parseSettingsPatchKey<string>(
      'activeDjPromptId',
      patch.activeDjPromptId,
    );
  }
  if ('djPrompt' in patch) {
    // The length + placeholder rules come from the shared schema; what stays
    // here is the MAPPING onto the library, which reads and writes next.djPrompts.
    const v = parseSettingsPatchKey<string>('djPrompt', patch.djPrompt);
    if (v === '') {
      next.activeDjPromptId = '';
    } else {
      let entry = next.djPrompts.find((p: DjPromptEntry) => p.text === v);
      if (!entry) {
        if (next.djPrompts.length >= DJ_PROMPT_LIMIT) {
          throw new Error(`the prompt library is full (${DJ_PROMPT_LIMIT} entries)`);
        }
        entry = { id: mintId('dp_'), name: 'Custom prompt', text: v };
        next.djPrompts.push(entry);
      }
      next.activeDjPromptId = entry.id;
    }
  }
  if ('djPrompts' in patch || 'activeDjPromptId' in patch || 'djPrompt' in patch) {
    if (
      next.activeDjPromptId &&
      !next.djPrompts.some((p: DjPromptEntry) => p.id === next.activeDjPromptId)
    ) {
      if ('activeDjPromptId' in patch || 'djPrompt' in patch) {
        throw new Error('activeDjPromptId must be "" or the id of a djPrompts entry');
      }
      // A library-only patch removed the entry that was active — fall back to
      // the built-in default rather than failing the save.
      next.activeDjPromptId = '';
    }
    // djPrompt stays the resolved active text — the single field readers use.
    next.djPrompt =
      next.djPrompts.find((p: DjPromptEntry) => p.id === next.activeDjPromptId)?.text ?? '';
  }
  // Station house rules — appended to BOTH prompt paths (scripted talk AND the
  // pick/request/segment agents), which the djPrompt template never reaches
  // (issue #1182). Empty = off, so there's no minimum length.
  if ('djHouseRules' in patch) {
    next.djHouseRules = parseSettingsPatchKey<string>('djHouseRules', patch.djHouseRules);
  }
  // Station clock switch. Applies live — the policy module reads it on every
  // call, so there is no restart and nothing to re-render.
  if ('djSpeakClock' in patch) {
    next.djSpeakClock = parseSettingsPatchKey<boolean>('djSpeakClock', patch.djSpeakClock);
  }
  if ('personas' in patch) {
    next.personas = validatePersonasStrict(patch.personas);
  }
  if ('shows' in patch) {
    // Snapshot the theme registry once so the validator can stay sync.
    // listThemes() returns built-ins + cached user themes (30 s TTL) — same
    // source the picker reads.
    const allowedThemeIds = new Set((await listThemes()).map(t => t.id));
    next.shows = validateShowsStrict(patch.shows, next.personas, allowedThemeIds, moodNames);
  }
  if ('schedule' in patch) {
    next.schedule = validateScheduleStrict(patch.schedule, next.shows);
  }
  if ('scheduleOverride' in patch) {
    next.scheduleOverride = validateScheduleOverrideStrict(patch.scheduleOverride, next.shows);
  }
  // In-use removal guard: run once the vocabulary AND any same-patch shows are
  // validated, so a mood dropped from the vocab is rejected only if something
  // still references it.
  if ('moods' in patch) {
    assertNoOrphanMoods(next);
  }
  if ('activePersonaId' in patch) {
    if (!next.personas.some(p => p.id === patch.activePersonaId)) {
      throw new Error('activePersonaId must reference an existing persona');
    }
    next.activePersonaId = patch.activePersonaId;
  }
  if ('tts' in patch) {
    const t = patch.tts || {};
    if (t.defaultEngine !== undefined) {
      if (!TTS_ENGINES.includes(t.defaultEngine)) {
        throw new Error(`tts.defaultEngine must be one of: ${TTS_ENGINES.join(', ')}`);
      }
      next.tts.defaultEngine = t.defaultEngine;
    }
    if (t.enabled !== undefined) {
      if (typeof t.enabled !== 'boolean') {
        throw new Error('tts.enabled must be a boolean');
      }
      next.tts.enabled = t.enabled;
    }
    if (t.fallback !== undefined) {
      const fb = t.fallback || {};
      if (fb.enabled !== undefined && typeof fb.enabled !== 'boolean') {
        throw new Error('tts.fallback.enabled must be a boolean');
      }
      // Same strict validator every persona voice slot goes through, so the
      // per-engine voice rules are enforced identically — `where` names the
      // full path, so a bad value reads `tts.fallback.voice must ...`.
      // Deliberately NO cross-field rule of the llm.fallback
      // "openai-compatible needs baseUrl" kind: a cloud fallback whose provider
      // has no key simply fails engineUsable() and is skipped at rescue time,
      // which degrades to the local floor rather than blocking the save.
      const slot = validateTtsBlock(
        { ...next.tts.fallback, ...fb },
        'tts.fallback',
      );
      next.tts.fallback = {
        enabled: fb.enabled !== undefined ? fb.enabled : next.tts.fallback.enabled,
        engine: slot.engine,
        voice: slot.voice,
        cloudProvider: slot.cloudProvider,
      };
    }
    if (t.heavyEnabled !== undefined) {
      if (typeof t.heavyEnabled !== 'boolean') {
        throw new Error('tts.heavyEnabled must be a boolean');
      }
      next.tts.heavyEnabled = t.heavyEnabled;
    }
    if (t.kokoro !== undefined) {
      const k = t.kokoro || {};
      if (k.voice !== undefined) {
        const v = String(k.voice).trim();
        if (!KOKORO_VOICE_RE.test(v)) {
          throw new Error('tts.kokoro.voice must match <lang><gender>_<name>, e.g. bf_isabella');
        }
        next.tts.kokoro.voice = v;
      }
      if (k.lang !== undefined) {
        // Canonicalise before validating so a pre-#1213 client still posting
        // `fr` lands on `fr-fr` rather than being rejected outright.
        const v = canonicalKokoroLang(String(k.lang).trim());
        if (v && !KOKORO_LANG_RE.test(v)) {
          throw new Error(`tts.kokoro.lang must be one of: ${KOKORO_LANGS.join(', ')}`);
        }
        next.tts.kokoro.lang = v;
      }
    }
    if (t.chatterbox !== undefined) {
      const cb = t.chatterbox || {};
      if (cb.referenceVoice !== undefined) {
        const v = String(cb.referenceVoice).trim();
        if (v && !CHATTERBOX_VOICE_RE.test(v)) {
          throw new Error(
            'tts.chatterbox.referenceVoice must be a .wav filename (no path), or empty for the default voice',
          );
        }
        next.tts.chatterbox.referenceVoice = v;
      }
    }
    if (t.pocketTts !== undefined) {
      const pt = t.pocketTts || {};
      if (pt.voice !== undefined) {
        const v = String(pt.voice).trim();
        // Built-in id OR shared-folder .wav filename (issue #213).
        if (!POCKET_TTS_VOICE_RE.test(v) && !CHATTERBOX_VOICE_RE.test(v)) {
          throw new Error(
            'tts.pocketTts.voice must be a built-in voice id (e.g. alba) or a .wav filename',
          );
        }
        next.tts.pocketTts.voice = v;
      }
    }
    if (t.cloud !== undefined) {
      const c = t.cloud || {};
      const savedCloudProvider = next.tts.cloud.provider;
      if (c.enabled !== undefined) {
        next.tts.cloud.enabled = !!c.enabled;
      }
      if (c.provider !== undefined) {
        if (!TTS_CLOUD_PROVIDERS.includes(c.provider)) {
          throw new Error(`tts.cloud.provider must be one of: ${TTS_CLOUD_PROVIDERS.join(', ')}`);
        }
        next.tts.cloud.provider = c.provider;
      }
      if (c.model !== undefined) {
        const v = String(c.model).trim();
        if (v.length < 1 || v.length > 100 || /[\r\n]/.test(v)) {
          throw new Error('tts.cloud.model must be 1-100 chars with no line breaks');
        }
        next.tts.cloud.model = v;
      }
      if (c.voice !== undefined) {
        const v = String(c.voice).trim();
        // openai-compatible voices are server-specific (often arbitrary
        // cloning ref names) and may legitimately be blank — let the server
        // pick its own default. openai/elevenlabs require a voice id.
        const provider = c.provider !== undefined ? c.provider : next.tts.cloud.provider;
        const allowEmpty = provider === 'openai-compatible';
        if (v.length > 100 || (!allowEmpty && v.length < 1)) {
          throw new Error(
            allowEmpty
              ? 'tts.cloud.voice must be 0-100 chars'
              : 'tts.cloud.voice must be 1-100 chars',
          );
        }
        next.tts.cloud.voice = v;
      }
      // 'set' is the redaction sentinel from getRedacted() — ignore it so a
      // round-tripped settings form doesn't overwrite the real key.
      if (c.apiKey !== undefined && c.apiKey !== 'set') {
        next.tts.cloud.apiKey = String(c.apiKey);
      } else if (c.provider !== undefined && c.provider !== savedCloudProvider) {
        // The shared inline slot belongs to the provider that created it. A
        // provider transition without an explicit replacement must clear it,
        // otherwise a managed key can be forwarded to an arbitrary compatible
        // URL (or a compatibility bearer can be reinterpreted as managed).
        next.tts.cloud.apiKey = '';
      }
      // Dedicated compatibility bearer. Unlike the legacy shared slot, this
      // may safely persist while another managed provider is selected globally.
      if (c.compatApiKey !== undefined && c.compatApiKey !== 'set') {
        next.tts.cloud.compatApiKey = String(c.compatApiKey);
      }
      if (c.baseUrl !== undefined) {
        const v = String(c.baseUrl).trim();
        if (v.length > 200) throw new Error('tts.cloud.baseUrl must be 0-200 chars');
        if (v && !/^https?:\/\//i.test(v)) {
          throw new Error('tts.cloud.baseUrl must start with http:// or https://');
        }
        next.tts.cloud.baseUrl = v.replace(/\/+$/, ''); // strip trailing slashes
      }
      // ElevenLabs voice_settings — clamped, not rejected. The UI sliders can't
      // produce out-of-range values, so a strict throw would only fire for a
      // hand-crafted payload; clamp so the DJ never goes silent on a typo.
      // Applied for every provider on save so switching provider later
      // preserves the operator's tuning, but only spread into providerOptions
      // in cloud-speech.ts when provider === 'elevenlabs' (see there).
      if (c.voiceStability !== undefined) {
        const n = Number(c.voiceStability);
        next.tts.cloud.voiceStability = Number.isFinite(n) ? clamp01(n) : DEFAULTS.tts.cloud.voiceStability;
      }
      if (c.voiceStyle !== undefined) {
        const n = Number(c.voiceStyle);
        next.tts.cloud.voiceStyle = Number.isFinite(n) ? clamp01(n) : DEFAULTS.tts.cloud.voiceStyle;
      }
      if (c.voiceSimilarityBoost !== undefined) {
        const n = Number(c.voiceSimilarityBoost);
        next.tts.cloud.voiceSimilarityBoost = Number.isFinite(n) ? clamp01(n) : DEFAULTS.tts.cloud.voiceSimilarityBoost;
      }
      if (c.voiceUseSpeakerBoost !== undefined) {
        next.tts.cloud.voiceUseSpeakerBoost = !!c.voiceUseSpeakerBoost;
      }
      // Fish Audio synthesis controls. Clamp numeric knobs like the existing
      // ElevenLabs sliders; reject an unknown enum so a typo cannot silently
      // turn into a provider-side 422 and a different fallback voice.
      if (c.temperature !== undefined) {
        const n = Number(c.temperature);
        next.tts.cloud.temperature = Number.isFinite(n) ? clamp01(n) : DEFAULTS.tts.cloud.temperature;
      }
      if (c.topP !== undefined) {
        const n = Number(c.topP);
        next.tts.cloud.topP = Number.isFinite(n) ? clamp01(n) : DEFAULTS.tts.cloud.topP;
      }
      if (c.latency !== undefined) {
        if (!['low', 'normal', 'balanced'].includes(c.latency)) {
          throw new Error('tts.cloud.latency must be one of: low, normal, balanced');
        }
        next.tts.cloud.latency = c.latency;
      }
      // Extra openai-compatible body fields (issue #1317). Rejected rather than
      // clamped: unlike a slider, a bad param name or type is a request the
      // server 4xxs, which mid-show means a silent drop to a local fallback
      // voice. The rule is shared with the send path — see
      // settings/compat-params.ts.
      if (c.compatParams !== undefined) {
        next.tts.cloud.compatParams = validateCompatParams(c.compatParams);
      }
      // Fish credentials live only in process env/state/secrets.env. Clear the
      // legacy inline compatibility slot on every Fish save so a later provider
      // switch cannot reinterpret a stale bearer as OpenAI/ElevenLabs.
      if (next.tts.cloud.provider === 'fish-audio') {
        next.tts.cloud.apiKey = '';
      }
      // An OpenAI-compatible TTS server has no canonical endpoint — refuse to
      // save the provider without one. Mirrors the LLM-side check below.
      if (next.tts.cloud.provider === 'openai-compatible' && !next.tts.cloud.baseUrl) {
        throw new Error('tts.cloud.baseUrl is required when provider is "openai-compatible"');
      }
    }
    if (t.remote !== undefined) {
      const r = t.remote || {};
      if (r.url !== undefined) {
        const v = String(r.url).trim();
        if (v.length > 200) throw new Error('tts.remote.url must be 0-200 chars');
        if (v) {
          // Full parse (not just a prefix test) so a malformed host/port —
          // e.g. http://host:notaport or http://host:99999 — is rejected at
          // save time instead of silently failing the /health probe later.
          let parsed: URL;
          try {
            parsed = new URL(v);
          } catch {
            throw new Error('tts.remote.url must be a valid http:// or https:// URL');
          }
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error('tts.remote.url must start with http:// or https://');
          }
        }
        next.tts.remote.url = v.replace(/\/+$/, ''); // strip trailing slashes
      }
    }
    if (t.gainDb !== undefined) {
      if (typeof t.gainDb !== 'object' || t.gainDb === null || Array.isArray(t.gainDb)) {
        throw new Error('tts.gainDb must be an object keyed by engine');
      }
      for (const key of Object.keys(t.gainDb)) {
        if (!TTS_ENGINES.includes(key)) {
          throw new Error(`tts.gainDb has unknown engine "${key}"; must be one of: ${TTS_ENGINES.join(', ')}`);
        }
        next.tts.gainDb[key] = clampTtsGain(t.gainDb[key]);
      }
    }
    if (t.speed !== undefined) {
      if (typeof t.speed !== 'object' || t.speed === null || Array.isArray(t.speed)) {
        throw new Error('tts.speed must be an object keyed by engine');
      }
      for (const key of Object.keys(t.speed)) {
        if (!TTS_ENGINES.includes(key)) {
          throw new Error(`tts.speed has unknown engine "${key}"; must be one of: ${TTS_ENGINES.join(', ')}`);
        }
        next.tts.speed[key] = clampTtsSpeed(t.speed[key]);
      }
    }
    // Whole-array replace, like festivals — the admin UI always sends the
    // full edited list. No restart: read live on every speak() call.
    if (t.corrections !== undefined) {
      next.tts.corrections = validateTtsCorrectionsStrict(t.corrections);
    }
  }
  if ('llm' in patch) {
    const l = patch.llm || {};
    applyLlmLegPatch(next.llm, l, 'llm');
    // Route the primary inline key into keys[provider] AFTER the provider is
    // resolved, so it's stored under the identity it belongs to (issue #657).
    applyInlineKey(next.llm, next.llm.provider, l.apiKey);
    if (l.pickerAgent !== undefined) {
      next.llm.pickerAgent = !!l.pickerAgent;
    }
    if (l.noRepeatWindow !== undefined) {
      next.llm.noRepeatWindow = clampNoRepeatWindow(Number(l.noRepeatWindow), next.llm.noRepeatWindow);
    }
    if (l.artistVarietyWindow !== undefined) {
      next.llm.artistVarietyWindow = clampArtistVarietyWindow(
        Number(l.artistVarietyWindow), next.llm.artistVarietyWindow,
      );
    }
    if (l.requestWebResolve !== undefined) {
      next.llm.requestWebResolve = !!l.requestWebResolve;
    }
    if (l.agentTimeoutMs !== undefined) {
      next.llm.agentTimeoutMs = clampAgentTimeout(Number(l.agentTimeoutMs), next.llm.agentTimeoutMs);
    }
    if (l.pauseWhenEmpty !== undefined) {
      next.llm.pauseWhenEmpty = !!l.pauseWhenEmpty;
    }
    if (l.dailyTokenCap !== undefined) {
      next.llm.dailyTokenCap = clampDailyTokenCap(Number(l.dailyTokenCap), next.llm.dailyTokenCap);
    }
    if (l.budgetSoftPct !== undefined) {
      next.llm.budgetSoftPct = clampBudgetSoftPct(Number(l.budgetSoftPct), next.llm.budgetSoftPct);
    }
    if (l.maxOutputTokens !== undefined) {
      next.llm.maxOutputTokens = clampMaxOutputTokens(Number(l.maxOutputTokens), next.llm.maxOutputTokens);
    }
    if (l.exemptRequests !== undefined) {
      next.llm.exemptRequests = !!l.exemptRequests;
    }
    if (l.debugRawRequests !== undefined) {
      next.llm.debugRawRequests = !!l.debugRawRequests;
    }
    // An OpenAI-compatible provider is useless without a server to talk to.
    if (next.llm.provider === 'openai-compatible' && !next.llm.baseUrl) {
      throw new Error('llm.baseUrl is required when provider is "openai-compatible"');
    }
    // Backup leg — same connection fields, validated identically. The
    // openai-compatible-needs-baseUrl rule is enforced only when the fallback
    // is enabled, so a half-filled, disabled backup never blocks a save.
    if (l.fallback !== undefined) {
      const fb = l.fallback || {};
      if (fb.enabled !== undefined) {
        next.llm.fallback.enabled = !!fb.enabled;
      }
      applyLlmLegPatch(next.llm.fallback, fb, 'llm.fallback');
      // Fallback inline key shares the same per-provider map (keys live at
      // next.llm.keys, not under the fallback) — routed by the fallback's
      // resolved provider.
      applyInlineKey(next.llm, next.llm.fallback.provider, fb.apiKey);
      if (
        next.llm.fallback.enabled &&
        next.llm.fallback.provider === 'openai-compatible' &&
        !next.llm.fallback.baseUrl
      ) {
        throw new Error(
          'llm.fallback.baseUrl is required when its provider is "openai-compatible"',
        );
      }
    }
  }
  if ('search' in patch) {
    const sr = parseSettingsPatchKey<Record<string, unknown>>('search', patch.search);
    if (sr.provider !== undefined) next.search.provider = sr.provider as string;
    if (sr.baseUrl !== undefined) next.search.baseUrl = sr.baseUrl as string;
    // 'set' is the redaction sentinel from getRedacted() — ignore it so a
    // round-tripped form doesn't overwrite the real key. Tested against the RAW
    // patch value, not the parsed one: the sentinel means "leave the stored
    // value alone", which is an instruction to the applier rather than a value
    // a schema could return.
    if (sr.apiKey !== undefined && (patch.search as Record<string, unknown>)?.apiKey !== 'set') {
      next.search.apiKey = sr.apiKey as string;
    }
  }
  if ('embedding' in patch) {
    const e = patch.embedding || {};
    if (e.enabled !== undefined) next.embedding.enabled = !!e.enabled;
    if (e.provider !== undefined) {
      const v = String(e.provider).trim();
      // Empty string is meaningful — it means "follow settings.llm.provider".
      if (v && !LLM_PROVIDERS.includes(v)) {
        throw new Error(
          `embedding.provider must be empty or one of: ${LLM_PROVIDERS.join(', ')}`,
        );
      }
      next.embedding.provider = v;
    }
    if (e.model !== undefined) {
      const v = String(e.model).trim();
      if (v.length > 100) throw new Error('embedding.model must be 0-100 chars');
      next.embedding.model = v;
    }
    // Dedicated embedding endpoint (issue #405). Empty → inherit settings.llm.
    // New path: providerBaseUrls map keyed by provider id (issue #1082).
    if (e.providerBaseUrls !== undefined) {
      if (!e.providerBaseUrls || typeof e.providerBaseUrls !== 'object' || Array.isArray(e.providerBaseUrls)) {
        throw new Error('embedding.providerBaseUrls must be an object map of provider → URL');
      }
      const incoming = e.providerBaseUrls as Record<string, unknown>;
      const existing = (next.embedding.providerBaseUrls as Record<string, string> | undefined) ?? {};
      const merged: Record<string, string> = { ...existing };
      for (const p of Object.keys(incoming)) {
        if (!LLM_PROVIDERS.includes(p)) continue;
        const v = String(incoming[p] ?? '').trim();
        if (v.length > 200) throw new Error(`embedding.providerBaseUrls.${p} must be 0-200 chars`);
        if (v && !/^https?:\/\//i.test(v)) {
          throw new Error(`embedding.providerBaseUrls.${p} must start with http:// or https://`);
        }
        const clean = v.replace(/\/+$/, '');
        if (clean) merged[p] = clean; else delete merged[p];
      }
      next.embedding.providerBaseUrls = merged;
    }
    // Legacy single baseUrl — seed the map under the EFFECTIVE provider (own,
    // else the chat provider) — the same key the admin UI reads and writes.
    // The flat field itself is re-derived after the patch blocks below.
    if (e.baseUrl !== undefined) {
      const v = String(e.baseUrl).trim();
      if (v.length > 200) throw new Error('embedding.baseUrl must be 0-200 chars');
      if (v && !/^https?:\/\//i.test(v)) {
        throw new Error('embedding.baseUrl must start with http:// or https://');
      }
      const clean = v.replace(/\/+$/, '');
      const prov = next.embedding.provider || next.llm.provider || '';
      if (prov && LLM_PROVIDERS.includes(prov)) {
        const urls = (next.embedding.providerBaseUrls as Record<string, string> | undefined) ?? {};
        if (clean) urls[prov] = clean; else delete urls[prov];
        next.embedding.providerBaseUrls = urls;
      }
    }
    if (e.ollamaUrl !== undefined) {
      const v = String(e.ollamaUrl).trim();
      if (v.length > 200) throw new Error('embedding.ollamaUrl must be 0-200 chars');
      if (v && !/^https?:\/\//i.test(v)) {
        throw new Error('embedding.ollamaUrl must start with http:// or https://');
      }
      next.embedding.ollamaUrl = v.replace(/\/+$/, '');
    }
    if (e.apiKey !== undefined && e.apiKey !== 'set') {
      const v = String(e.apiKey).trim();
      if (v.length > 200) throw new Error('embedding.apiKey must be 0-200 chars');
      next.embedding.apiKey = v;
    }
    if (e.seedCount !== undefined) {
      const v = parseInt(e.seedCount, 10);
      if (!Number.isFinite(v) || v < 0 || v > 50_000) {
        throw new Error('embedding.seedCount must be an integer 0-50000 (0 = auto)');
      }
      next.embedding.seedCount = v;
    }
    if (e.knnNeighbours !== undefined) {
      const v = parseInt(e.knnNeighbours, 10);
      if (!Number.isFinite(v) || v < 1 || v > 50) {
        throw new Error('embedding.knnNeighbours must be an integer 1-50');
      }
      next.embedding.knnNeighbours = v;
    }
    if (e.moodVoteThreshold !== undefined) {
      const v = parseFloat(e.moodVoteThreshold);
      if (!Number.isFinite(v) || v < 0 || v > 1) {
        throw new Error('embedding.moodVoteThreshold must be between 0 and 1');
      }
      next.embedding.moodVoteThreshold = v;
    }
    if (e.confidenceThreshold !== undefined) {
      const v = parseFloat(e.confidenceThreshold);
      if (!Number.isFinite(v) || v < 0 || v > 1) {
        throw new Error('embedding.confidenceThreshold must be between 0 and 1');
      }
      next.embedding.confidenceThreshold = v;
    }
    if (e.maxActiveLearningRounds !== undefined) {
      const v = parseInt(e.maxActiveLearningRounds, 10);
      if (!Number.isFinite(v) || v < 0 || v > 10) {
        throw new Error('embedding.maxActiveLearningRounds must be an integer 0-10');
      }
      next.embedding.maxActiveLearningRounds = v;
    }
    if (e.audioFusionWeight !== undefined) {
      const v = parseFloat(e.audioFusionWeight);
      if (!Number.isFinite(v) || v < 0 || v > 1) {
        throw new Error('embedding.audioFusionWeight must be between 0 and 1');
      }
      next.embedding.audioFusionWeight = v;
    }
    // LLM tag batch size — how many tracks per tagging call. Weaker models
    // truncate/error on large batches, so operators can drop this. Clamp kept in
    // sync with the CLI --batch flag + load() normalisation (music/tag-library.ts).
    if (e.batchSize !== undefined) {
      const v = parseInt(e.batchSize, 10);
      if (!Number.isFinite(v) || v < 1 || v > 50) {
        throw new Error('embedding.batchSize must be an integer 1-50');
      }
      next.embedding.batchSize = v;
    }
    if (e.enrichment !== undefined) {
      const en = e.enrichment || {};
      if (en.lastfmTags !== undefined) {
        next.embedding.enrichment.lastfmTags = !!en.lastfmTags;
      }
      if (en.lyrics !== undefined) {
        next.embedding.enrichment.lyrics = !!en.lyrics;
      }
      if (en.originalYear !== undefined) {
        next.embedding.enrichment.originalYear = !!en.originalYear;
      }
    }
  }
  // Re-derive the embedding leg's flat baseUrl on EVERY update, not just when
  // the embedding block was patched: the leg inherits the chat provider when
  // its own is empty, so an llm.provider-only change also moves which map slot
  // is live. Runtime (embeddingCfg) reads the flat field — issues #405/#1082.
  {
    const embedProv = (next.embedding.provider || next.llm.provider || '') as string;
    const embedUrls = (next.embedding.providerBaseUrls as Record<string, string> | undefined) ?? {};
    next.embedding.baseUrl = (embedProv && embedUrls[embedProv]) ? embedUrls[embedProv] : '';
  }
  if ('skills' in patch) {
    const sk = patch.skills || {};
    if (sk.enabled !== undefined) {
      if (sk.enabled === null || typeof sk.enabled !== 'object') {
        throw new Error('skills.enabled must be an object of name → boolean');
      }
      for (const [name, on] of Object.entries(sk.enabled)) {
        if (typeof on !== 'boolean') {
          throw new Error(`skills.enabled.${name} must be a boolean`);
        }
        next.skills.enabled[name] = on;
        // Disabling a skill station-wide also revokes it from every persona
        // that explicitly carries it, so a later re-enable is a fresh
        // per-persona opt-in rather than a silent return. The `null` "all
        // skills" sentinel stays untouched — it means "whatever the station
        // enables", not a list to edit.
        if (!on) {
          for (const p of next.personas) {
            if (Array.isArray(p.skills) && p.skills.includes(name)) {
              p.skills = p.skills.filter((slug: string) => slug !== name);
            }
          }
        }
      }
    }
  }
  if ('audio' in patch) {
    // stemCacheGb throws rather than silently ignoring, matching
    // analyzeQuietMinutes: swallowing an out-of-range value meant the admin UI
    // showed a saved budget the sweep was never using. Ceiling raised
    // 500 → 1000 (#1257) — at the measured ~13 MB/track a 500 GB budget stops
    // short of a ~50k-track library.
    const au = parseSettingsPatchKey<Record<string, unknown>>('audio', patch.audio);
    for (const k of [
      'embeddings',
      'vocalActivity',
      'stemCache',
      'stemCacheGb',
      'analyzeQuietOnly',
      'analyzeQuietMinutes',
    ] as const) {
      if (au[k] !== undefined) (next.audio as Record<string, unknown>)[k] = au[k];
    }
  }
  if ('transitions' in patch) {
    const tr = parseSettingsPatchKey<Record<string, unknown>>('transitions', patch.transitions);
    for (const k of ['pairDrain', 'stemBlends'] as const) {
      if (tr[k] !== undefined) (next.transitions as Record<string, unknown>)[k] = tr[k];
    }
  }
  // On the shared schema (#1348). The block schemas keep the branches' own
  // leniency — a non-object block is an empty patch, an absent field is left
  // alone — so this stays a plain "apply what was sent".
  if ('sfx' in patch) {
    const sx = parseSettingsPatchKey<{ enabled?: boolean }>('sfx', patch.sfx);
    if (sx.enabled !== undefined) {
      next.sfx.enabled = sx.enabled;
    }
  }
  if ('beds' in patch) {
    const bd = parseSettingsPatchKey<{
      enabled?: boolean;
      thresholdSec?: number;
      crossSec?: number;
    }>('beds', patch.beds);
    if (bd.enabled !== undefined) {
      next.beds.enabled = bd.enabled;
    }
    if (bd.thresholdSec !== undefined) {
      next.beds.thresholdSec = bd.thresholdSec;
    }
    if (bd.crossSec !== undefined) {
      next.beds.crossSec = bd.crossSec;
    }
  }
  if ('ui' in patch) {
    // `skin` is slug-only — the web registry resolves it and falls back on
    // unknowns, so an invalid value is DROPPED rather than erroring the whole
    // patch. The schema returns undefined for that case, which this skips.
    const ui = parseSettingsPatchKey<Record<string, unknown>>('ui', patch.ui);
    for (const k of ['boothBuddy', 'skin', 'tuneInOverlay'] as const) {
      if (ui[k] !== undefined) (next.ui as Record<string, unknown>)[k] = ui[k];
    }
  }
  if ('privacy' in patch) {
    // Field rules on the shared schema; the lock-needs-a-password invariant
    // below is NOT one of them — it reads the MERGED state, so a lock turned on
    // by this patch can be satisfied by a password that was already stored.
    const pv = parseSettingsPatchKey<Record<string, unknown>>('privacy', patch.privacy);
    const rawPv = (patch.privacy || {}) as Record<string, unknown>;
    if (pv.privatePlayer !== undefined) {
      next.privacy.privatePlayer = pv.privatePlayer as boolean;
    }
    // Disclosure toggle, not a lock: it is deliberately outside the
    // "a lock needs a password" invariant below, needs no mixer restart, and
    // applies live on the next public read.
    if (pv.publishPersonaSouls !== undefined) {
      next.privacy.publishPersonaSouls = pv.publishPersonaSouls as boolean;
    }
    // 'set' is the redaction sentinel from getRedacted() — ignore it so a
    // round-tripped form doesn't overwrite the stored secret. Compared against
    // the RAW value: ' set ' is NOT the sentinel and is stored as a password.
    if (pv.password !== undefined && rawPv.password !== 'set') {
      next.privacy.password = pv.password as string;
    }
    if (pv.listenerAuth !== undefined) {
      const v = pv.listenerAuth as boolean;
      if (v !== cur.privacy.listenerAuth) {
        // Flipping the toggle adds/removes the <mount> auth blocks in
        // icecast.xml, which only re-render on a broadcast restart. Password
        // changes don't need this — URL auth validates live.
        next.privacy.listenerAuth = v;
        restart = true;
      }
    }
    // Whatever combination the patch produced, never persist a lock that is on
    // with no password behind it. For the stream that would fail every
    // listener closed at /listener-auth; for the player it would render a
    // prompt nobody can satisfy, locking the operator out of their own station
    // with no in-band way back in.
    if (
      (next.privacy.privatePlayer || next.privacy.listenerAuth) &&
      !next.privacy.password
    ) {
      throw new Error('set a station password before turning on a privacy lock');
    }
  }
  if ('requests' in patch) {
    // The schema decides "usable or absent" per field; the fallback to the
    // CURRENT value is this spread. Same result as the old per-field ternaries,
    // including the load-bearing part: an emptied admin input arrives as JSON
    // null, which is UNUSABLE rather than 0, so it leaves the stored value
    // alone instead of clamping to the field's floor and closing the request
    // line. The rebuild keeps exactly the seven known keys.
    const rq = parseSettingsPatchKey<Record<string, unknown>>('requests', patch.requests);
    const curReq = next.requests || DEFAULTS.requests;
    const pick = <K extends keyof typeof curReq>(k: K) =>
      (rq[k as string] !== undefined ? rq[k as string] : curReq[k]) as (typeof curReq)[K];
    next.requests = {
      enabled: pick('enabled'),
      maxPending: pick('maxPending'),
      globalHourlyCap: pick('globalHourlyCap'),
      repeatCooldownMin: pick('repeatCooldownMin'),
      cooldownSec: pick('cooldownSec'),
      perIpHourlyCap: pick('perIpHourlyCap'),
      onePendingPerIp: pick('onePendingPerIp'),
    };
  }
  if ('webhooks' in patch) {
    next.webhooks = validateWebhooksStrict(patch.webhooks, next.webhooks || []);
  }
  if ('webhooksPolicy' in patch) {
    const wp = parseSettingsPatchKey<Record<string, unknown>>(
      'webhooksPolicy',
      patch.webhooksPolicy,
    );
    if (wp.trackPlayListenerGated !== undefined) {
      next.webhooksPolicy.trackPlayListenerGated = wp.trackPlayListenerGated as boolean;
    }
  }
  if ('scrobble' in patch) {
    const sb = parseSettingsPatchKey<{
      lastfm?: Record<string, unknown>;
      listenbrainz?: Record<string, unknown>;
    }>('scrobble', patch.scrobble);
    const rawSb = (patch.scrobble || {}) as Record<string, Record<string, unknown> | undefined>;
    // 'set' is the redaction sentinel from getRedacted() — ignore it so a
    // round-tripped form doesn't overwrite the stored secret. Tested against
    // the RAW patch value: "keep what is stored" is an instruction to the
    // applier, not a value any schema could return. It guards ONLY the secret
    // fields — a username of literally 'set' has always been stored as such.
    const LASTFM_SECRETS = ['apiKey', 'apiSecret', 'sessionKey'];
    if (sb.lastfm !== undefined) {
      const lf = sb.lastfm;
      for (const k of ['enabled', 'username', 'apiKey', 'apiSecret', 'sessionKey'] as const) {
        if (lf[k] === undefined) continue;
        if (LASTFM_SECRETS.includes(k) && rawSb.lastfm?.[k] === 'set') continue;
        (next.scrobble.lastfm as Record<string, unknown>)[k] = lf[k];
      }
    }
    if (sb.listenbrainz !== undefined) {
      const lb = sb.listenbrainz;
      for (const k of ['enabled', 'username', 'userToken', 'baseUrl'] as const) {
        if (lb[k] === undefined) continue;
        if (k === 'userToken' && rawSb.listenbrainz?.[k] === 'set') continue;
        (next.scrobble.listenbrainz as Record<string, unknown>)[k] = lb[k];
      }
    }
  }
  if ('likes' in patch) {
    const lk = parseSettingsPatchKey<Record<string, unknown>>('likes', patch.likes);
    for (const k of [
      'enabled',
      'starInNavidrome',
      'influenceDj',
      'maxTracks',
      'windowDays',
    ] as const) {
      if (lk[k] !== undefined) (next.likes as Record<string, unknown>)[k] = lk[k];
    }
  }

  // Post-patch integrity sweep — a personas/shows change in this patch may
  // have orphaned a show owner, a schedule slot, or the active persona.
  {
    const personaIds = next.personas.map(p => p.id);
    next.shows = next.shows.filter(s => personaIds.includes(s.personaId));
    // A deleted persona also vanishes from every guest roster (the show itself
    // survives — losing a guest is not losing the show).
    for (const s of next.shows) {
      s.guestPersonaIds = coerceGuestPersonaIds(s.guestPersonaIds, s.personaId, personaIds);
    }
    const showIds = next.shows.map(s => s.id);
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
        if (next.schedule[d][h] && !showIds.includes(next.schedule[d][h])) {
          next.schedule[d][h] = null;
        }
      }
    }
    // A takeover pinning a show that no longer exists dies with the show.
    if (next.scheduleOverride && !showIds.includes(next.scheduleOverride.showId)) {
      next.scheduleOverride = null;
    }
    if (!personaIds.includes(next.activePersonaId)) next.activePersonaId = personaIds[0];

    // Garbage-collect avatar files for personas that no longer exist. Best
    // effort — a missing directory or a vanished file is fine, this just
    // keeps the on-disk state from accumulating dead images.
    const removedIds = (cur.personas || [])
      .map((p: { id: string }) => p.id)
      .filter((id: string) => !personaIds.includes(id));
    if (removedIds.length) {
      try {
        const entries = await readdir(PERSONA_AVATAR_DIR);
        await Promise.all(
          entries
            .filter(e => removedIds.some(id => e.startsWith(`${id}.`)))
            .map(e => unlink(`${PERSONA_AVATAR_DIR}/${e}`).catch(() => {})),
        );
      } catch {
        // Directory doesn't exist yet — nothing to clean.
      }
    }
  }

  setCache(next);
  // Applied-on-save, same pattern as the liquidsoap_*.txt files below —
  // minus the restart: the next zonedParts() call picks it up.
  setStationTimezone(next.timezone);
  // shows + schedule are persisted to their own file (schedule.json); strip
  // them from the settings.json payload so legacy installs migrate forward
  // on the first write. The in-memory `cache` keeps the full shape so
  // resolveActiveShow / getEffectivePersona / the integrity sweep all
  // continue to work against one merged view.
  const { shows: _shows, schedule: _schedule, scheduleOverride: _override, ...settingsPersist } = next;
  // Atomic replace — a crash mid-write must not take the operator's whole
  // config (or show schedule) with it.
  await writeFileAtomic(SETTINGS_PATH, JSON.stringify(settingsPersist, null, 2));
  await writeFileAtomic(
    SCHEDULE_PATH,
    JSON.stringify(
      { shows: next.shows, schedule: next.schedule, override: next.scheduleOverride ?? null },
      null,
      2,
    ),
  );
  await writeLiquidsoapSettings(next);
  return { saved: next, requiresRestart: restart };
}

// Called from server.js startup so the files exist before Liquidsoap reads
// them on its next start. Idempotent.
export async function ensureLiquidsoapSettingsFile() {
  const s = await load();
  if (
    !existsSync(LIQ_JINGLE_RATIO_PATH) ||
    !existsSync(LIQ_CROSSFADE_PATH) ||
    !existsSync(LIQ_ARCHIVE_ENABLED_PATH) ||
    !existsSync(LIQ_ARCHIVE_BITRATE_PATH) ||
    !existsSync(LIQ_OPUS_ENABLED_PATH) ||
    !existsSync(LIQ_STREAM_BITRATE_PATH) ||
    !existsSync(LIQ_STREAM_BUFFER_SECONDS_PATH) ||
    !existsSync(ICECAST_LISTENER_AUTH_PATH)
  ) {
    await writeLiquidsoapSettings(s);
  }
}

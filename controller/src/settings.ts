// Durable settings — overrides for values with static defaults in code, stored
// at <stateDir>/settings.json. Some apply live; others need a Liquidsoap restart.
// Public barrel for ./settings/*: owns load() (lenient, never throws) and
// update() (strict, throws for the admin UI). Import from './settings.js' only.

import { readFile, unlink, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { STATE_DIR } from './config.js';
import { writeFileAtomic } from './util/atomic-file.js';
import { DEFAULT_THEME_ID, isValidThemeId, listThemes } from './themes.js';
import { isValidTimezone, setStationTimezone } from './time.js';
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
  isDefaultTakeover,
  mintId,
  normalizeLlmHeaders,
  normalizeLlmKeys,
  normalizeLlmProviderBaseUrls,
  normalizeMoodMap,
  normalizeMoods,
  normalizeTtsCorrections,
  normalizeTtsGainMap,
  normalizeTtsSpeedMap,
  takeoverShowId,
  TRANSITION_EFFECTS,
  validateTtsCorrectionsStrict,
} from './settings/vocab.js';
import {
  AAC_BITRATE_SET,
  BOUNDS,
  DEFAULTS,
  MP3_BITRATE_SET,
  OPUS_BITRATE_SET,
  coerceMaxTrackSeconds,
  coerceMinTrackLengthSeconds,
  rawMaxTrackSec,
} from './settings/defaults.js';
import { validateCompatParams } from './settings/compat-params.js';
import { parseSettingsPatchKey } from './settings/patch-registry.js';
import {
  PICKER_ALBUM_HOURS_BOUNDS,
  STREAM_BUFFER_SECONDS_BOUNDS,
  STREAM_COUNTRY_HEADER_RE,
  STREAM_GEOIP_DB_PATH_MAX,
  STREAM_MAX_LISTENERS_BOUNDS,
  maxTrackSecondsValueSchema,
  type ScheduledBackupSettings,
} from './schemas/settings.js';
import { minTrackSeconds, peek, setCache } from './settings/store.js';
import {
  SKILL_RENAMES,
  normalizeArchiveRetentionDays,
  normalizeBackups,
  normalizeDjPrompts,
  normalizeDuckDepth,
  normalizeHandoverOffsetMinutes,
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
  LINK_STYLES,
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
  TRANSITION_EFFECTS,
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
  announceLinks,
  castHouseRulesBlock,
  castSpeakerIdRule,
  effectiveFadeAtShowEnd,
  effectiveFrequency,
  effectiveMaxTrackSec,
  effectiveMinTrackSec,
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
export { effectEnabled, enabledEffects } from './settings/transition-effects.js';
export type {
  DjPromptEntry,
  EraWindow,
  LoudnessSource,
  NormalizedShow,
  ScheduleOverride,
  Webhook,
} from './settings/vocab.js';

// One file per persona, basename `<personaId>.<ext>`. The upload route is the
// only writer; the post-update orphan sweep is the only deleter.
export const PERSONA_AVATAR_DIR = `${STATE_DIR}/persona-avatars`;

const SETTINGS_PATH = `${STATE_DIR}/settings.json`;
// `shows` + the 7x24 `schedule` share one file, always loaded/saved together.
// load() migrates them out of settings.json on first load after upgrade.
const SCHEDULE_PATH = `${STATE_DIR}/schedule.json`;

// Round then clamp into [min, max] for the settings.requests coercions.
// A CLEARED field is absent, not zero: `Number` maps ''/null/false/[] to 0, so
// only a real number or a numeric string counts as a value; anything else
// falls back to `def` rather than committing the field's floor.
const intIn = (v: unknown, def: number, min: number, max: number) => {
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

  // shows + schedule live in schedule.json; if it exists its contents win,
  // else fall back to the legacy in-line copy on settings.json. update() never
  // writes these keys back, so the next save completes the migration.
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

  // Fresh install (no valid roster) ships the seed DJs.
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

  // A pre-library settings.json (custom djPrompt, no djPrompts array) migrates
  // that text into a lone library entry.
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

  // Per-provider base-URL maps (#1082), one per leg. The flat legacy `baseUrl`
  // is derived from the map; the stored flat value is only a pre-map fallback.
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
  // legacy dedicated embedding URL (#405) migrates under the EFFECTIVE provider.
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
    // Bounded here as well as at the save path (load repairs, never throws):
    // an out-of-range `p` reaches radio.liq as a music BOOST under the DJ.
    // Bounds come from the shared schema constant, never a copy.
    ducking: {
      voice: normalizeDuckDepth(stored.ducking?.voice, DEFAULTS.ducking.voice),
      intro: normalizeDuckDepth(stored.ducking?.intro, DEFAULTS.ducking.intro),
    },
    maxTrackSeconds: coerceMaxTrackSeconds(rawMaxTrackSec(stored), false) ?? DEFAULTS.maxTrackSeconds,
    // Show-boundary fade (#1574). Anything but an explicit boolean = off.
    fadeAtShowEnd:
      typeof stored.fadeAtShowEnd === 'boolean'
        ? stored.fadeAtShowEnd
        : DEFAULTS.fadeAtShowEnd,
    archive: {
      enabled:
        typeof stored.archive?.enabled === 'boolean'
          ? stored.archive.enabled
          : DEFAULTS.archive.enabled,
      bitrate: archiveBitrate,
      // Keep-forever guard: a pre-existing enabled archive with no stored
      // value stays at 0, never pruned.
      retentionDays: normalizeArchiveRetentionDays(stored.archive),
    },
    // Scheduled backups (#1570). Absent block = `{ cadence: 'off' }`.
    // Like every section here it composes field by field and does NOT spread
    // DEFAULTS: a field missing from this block saves, then vanishes on the
    // next cold load (controller/CLAUDE.md's THREE edits).
    backups: normalizeBackups(stored.backups),
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
      // (schemas/settings.ts streamSchema), so a saved value survives a restart.
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
      // Same shared constant as bufferSeconds above, for the same reason.
      maxListeners:
        Number.isInteger(stored.stream?.maxListeners) &&
        stored.stream.maxListeners >= STREAM_MAX_LISTENERS_BOUNDS.min &&
        stored.stream.maxListeners <= STREAM_MAX_LISTENERS_BOUNDS.max
          ? stored.stream.maxListeners
          : DEFAULTS.stream.maxListeners,
      // Listener-country fallbacks (#1485), bounded against exactly what
      // streamPatchSchema accepts. Repaired, never refused: a bad header name
      // costs the header link, never a boot.
      countryHeader:
        typeof stored.stream?.countryHeader === 'string' &&
        (stored.stream.countryHeader.trim() === '' ||
          STREAM_COUNTRY_HEADER_RE.test(stored.stream.countryHeader.trim()))
          ? stored.stream.countryHeader.trim()
          : DEFAULTS.stream.countryHeader,
      geoipDbPath:
        typeof stored.stream?.geoipDbPath === 'string' &&
        stored.stream.geoipDbPath.trim().length <= STREAM_GEOIP_DB_PATH_MAX
          ? stored.stream.geoipDbPath.trim()
          : DEFAULTS.stream.geoipDbPath,
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
      // Absent key -> '' -> falls back to locationName at read time.
      onAirLocation: stored.weather?.onAirLocation ?? DEFAULTS.weather.onAirLocation,
      units:
        stored.weather?.units === 'imperial' || stored.weather?.units === 'metric'
          ? stored.weather.units
          : DEFAULTS.weather.units,
    },
    djPrompt,
    djPrompts,
    activeDjPromptId,
    // Trimmed + capped on load so a hand-edited file can't bloat every prompt.
    // '' (or a pre-#1182 file with no key) = off.
    djHouseRules:
      typeof stored.djHouseRules === 'string'
        ? stored.djHouseRules.trim().slice(0, DJ_HOUSE_RULES_MAX)
        : '',
    // Missing/non-boolean coerces to the default `true`.
    djSpeakClock:
      typeof stored.djSpeakClock === 'boolean'
        ? stored.djSpeakClock
        : DEFAULTS.djSpeakClock,
    // Missing/non-boolean coerces to the default `false`.
    djTalkOnlyBetweenTracks:
      typeof stored.djTalkOnlyBetweenTracks === 'boolean'
        ? stored.djTalkOnlyBetweenTracks
        : DEFAULTS.djTalkOnlyBetweenTracks,
    // Repaired, not refused: an offset the talk table's programme row cannot
    // sample is a sign-off that never airs.
    handover: {
      offsetMinutes: normalizeHandoverOffsetMinutes(
        stored.handover?.offsetMinutes, DEFAULTS.handover.offsetMinutes,
      ),
    },
    station:
      typeof stored.station === 'string' && stored.station.trim()
        ? stored.station.trim().slice(0, 80)
        : DEFAULTS.station,
    stationDescription:
      typeof stored.stationDescription === 'string'
        ? stored.stationDescription.trim().slice(0, 200)
        : DEFAULTS.stationDescription,
    // Invalid stored zone falls back to Auto; never crash on a bad zone.
    timezone:
      typeof stored.timezone === 'string' && isValidTimezone(stored.timezone.trim())
        ? stored.timezone.trim()
        : DEFAULTS.timezone,
    locale:
      stored.locale === 'en-US' || stored.locale === 'en-GB'
        ? stored.locale
        : DEFAULTS.locale,
    theme: {
      // Shape only. A stale id pointing at a removed theme is resolved by
      // /themes falling back to the default.
      active:
        typeof stored.theme?.active === 'string' && stored.theme.active.trim()
          ? stored.theme.active.trim()
          : DEFAULTS.theme.active,
    },
    // Seeded from FESTIVAL_DEFAULTS only when the key is absent/invalid: a
    // persisted empty array means the operator cleared the calendar.
    festivals: Array.isArray(stored.festivals) ? stored.festivals : FESTIVAL_DEFAULTS,
    // Lenient normalise. An empty/absent vocabulary reseeds MOOD_DEFAULTS;
    // the two maps fill missing keys from their seed defaults.
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
      // Absent/non-boolean coerces to the default (false).
      publishPersonaSouls:
        typeof stored.privacy?.publishPersonaSouls === 'boolean'
          ? stored.privacy.publishPersonaSouls
          : DEFAULTS.privacy.publishPersonaSouls,
    },
    // Absent/malformed coerces field-by-field to DEFAULTS.requests, never
    // undefined/NaN — callers gate on settings.get()?.requests.
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
      // Missing/non-boolean coerces to the default `true`.
      enabled:
        typeof stored.tts?.enabled === 'boolean'
          ? stored.tts.enabled
          : DEFAULTS.tts.enabled,
      defaultEngine: TTS_ENGINES.includes(stored.tts?.defaultEngine)
        ? stored.tts.defaultEngine
        : DEFAULTS.tts.defaultEngine,
      // Rescue slot. Reuses the persona voice-slot normaliser so the per-engine
      // voice rules can't drift; only `enabled` is extra, defaulting off.
      fallback: normalizeTtsFallback(stored.tts?.fallback),
      // Missing/non-boolean coerces to DEFAULTS.tts.heavyEnabled.
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
        // Legacy codes canonicalised first (`fr` -> `fr-fr`, #1213).
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
        // Explicit boolean wins; otherwise a saved cloud key keeps cloud on.
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
        // Migrate the old shared slot into the compatibility slot only when it
        // was saved under the compatibility provider.
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
        // ElevenLabs voice_settings, clamped to [0,1]: an out-of-range value
        // 400s the whole speak call.
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
        sendSpeed:
          typeof stored.tts?.cloud?.sendSpeed === 'boolean'
            ? stored.tts.cloud.sendSpeed
            : DEFAULTS.tts.cloud.sendSpeed,
        // Fish Audio controls; only the Fish provider sends these on the wire.
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
        // Extra openai-compatible body fields. Lenient: an invalid list drops
        // to none rather than throwing.
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
      // One gain per known engine; missing keys -> 0, unknown keys dropped.
      gainDb: normalizeTtsGainMap(stored.tts?.gainDb),
      // One multiplier per known engine; missing -> 1.0, unknown dropped.
      speed: normalizeTtsSpeedMap(stored.tts?.speed),
      // Malformed entries dropped, list capped; absent loads as [].
      corrections: normalizeTtsCorrections(stored.tts?.corrections),
    },
    llm: {
      provider: LLM_PROVIDERS.includes(stored.llm?.provider)
        ? stored.llm.provider
        : DEFAULTS.llm.provider,
      model: typeof stored.llm?.model === 'string' ? stored.llm.model.trim() : DEFAULTS.llm.model,
      // Legacy single slot migrates into `keys` below then clears: one source
      // of truth for inline keys (#657).
      apiKey: '',
      keys: normalizeLlmKeys(stored.llm),
      ollamaUrl:
        typeof stored.llm?.ollamaUrl === 'string'
          ? stored.llm.ollamaUrl.trim()
          : DEFAULTS.llm.ollamaUrl,
      providerBaseUrls: llmBaseUrls,
      baseUrl: llmBaseUrls[llmProvider]
        ?? (typeof stored.llm?.baseUrl === 'string' ? stored.llm.baseUrl.trim() : DEFAULTS.llm.baseUrl),
      // Extra openai-compatible request headers (#1618). Malformed entries
      // dropped rather than thrown; absent loads as {} (no extra headers).
      headers: normalizeLlmHeaders(stored.llm?.headers),
      reasoning:
        typeof stored.llm?.reasoning === 'boolean' ? stored.llm.reasoning : DEFAULTS.llm.reasoning,
      // Only 'auto' downgrades the forced tool_choice; else 'required' (#570).
      toolChoice: stored.llm?.toolChoice === 'auto' ? 'auto' : DEFAULTS.llm.toolChoice,
      // 0 disables (Ollama default), else clamped to [2048, 131072], floored.
      numCtx: clampNumCtx(stored.llm?.numCtx, DEFAULTS.llm.numCtx),
      // Clamped to [1.0, 2.0]; 1.0 = off.
      repeatPenalty: clampRepeatPenalty(stored.llm?.repeatPenalty, DEFAULTS.llm.repeatPenalty),
      pickerAgent:
        typeof stored.llm?.pickerAgent === 'boolean'
          ? stored.llm.pickerAgent
          : DEFAULTS.llm.pickerAgent,
      // Clamped to [0, 1000] (<= the 2500-entry sidecar cap).
      noRepeatWindow: clampNoRepeatWindow(stored.llm?.noRepeatWindow, DEFAULTS.llm.noRepeatWindow),
      // Clamped to [0, 25].
      artistVarietyWindow: clampArtistVarietyWindow(
        stored.llm?.artistVarietyWindow,
        DEFAULTS.llm.artistVarietyWindow,
      ),
      requestWebResolve:
        typeof stored.llm?.requestWebResolve === 'boolean'
          ? stored.llm.requestWebResolve
          : DEFAULTS.llm.requestWebResolve,
      // Clamped to [5s, 300s].
      agentTimeoutMs: clampAgentTimeout(stored.llm?.agentTimeoutMs, DEFAULTS.llm.agentTimeoutMs),
      pauseWhenEmpty:
        typeof stored.llm?.pauseWhenEmpty === 'boolean'
          ? stored.llm.pauseWhenEmpty
          : DEFAULTS.llm.pauseWhenEmpty,
      // Budget cap; 0 = disabled.
      dailyTokenCap: clampDailyTokenCap(stored.llm?.dailyTokenCap, DEFAULTS.llm.dailyTokenCap),
      budgetSoftPct: clampBudgetSoftPct(stored.llm?.budgetSoftPct, DEFAULTS.llm.budgetSoftPct),
      // Per-call output cap (#712); 0 = built-in per-strategy defaults.
      maxOutputTokens: clampMaxOutputTokens(stored.llm?.maxOutputTokens, DEFAULTS.llm.maxOutputTokens),
      // Discovery-round override; 0 = follow the provider capability table.
      discoverySteps: clampDiscoverySteps(stored.llm?.discoverySteps, DEFAULTS.llm.discoverySteps),
      exemptRequests:
        typeof stored.llm?.exemptRequests === 'boolean'
          ? stored.llm.exemptRequests
          : DEFAULTS.llm.exemptRequests,
      debugRawRequests:
        typeof stored.llm?.debugRawRequests === 'boolean'
          ? stored.llm.debugRawRequests
          : DEFAULTS.llm.debugRawRequests,
      fallback: (() => {
        const fb = stored.llm?.fallback || {};
        return {
          enabled: typeof fb.enabled === 'boolean' ? fb.enabled : DEFAULTS.llm.fallback.enabled,
          provider: LLM_PROVIDERS.includes(fb.provider)
            ? fb.provider
            : DEFAULTS.llm.fallback.provider,
          model: typeof fb.model === 'string' ? fb.model.trim() : DEFAULTS.llm.fallback.model,
          // Legacy slot migrated into settings.llm.keys above, then cleared.
          apiKey: '',
          ollamaUrl:
            typeof fb.ollamaUrl === 'string' ? fb.ollamaUrl.trim() : DEFAULTS.llm.fallback.ollamaUrl,
          providerBaseUrls: fbBaseUrls,
          baseUrl: fbBaseUrls[fbProvider]
            ?? (typeof fb.baseUrl === 'string' ? fb.baseUrl.trim() : DEFAULTS.llm.fallback.baseUrl),
          headers: normalizeLlmHeaders(fb.headers),
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
      searxngEngines:
        typeof stored.search?.searxngEngines === 'string'
          ? stored.search.searxngEngines
          : DEFAULTS.search.searxngEngines,
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
      // Effective provider = own, else the chat provider.
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
          // Same rename on the enable toggle map.
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
      // Per-effect kill switches (#1565); absent means the default `true`.
      effects: Object.fromEntries(TRANSITION_EFFECTS.map(k => [
        k,
        typeof stored.transitions?.effects?.[k] === 'boolean'
          ? stored.transitions.effects[k]
          : DEFAULTS.transitions.effects[k],
      ])) as typeof DEFAULTS.transitions.effects,
    },
    sfx: {
      enabled: typeof stored.sfx?.enabled === 'boolean' ? stored.sfx.enabled : DEFAULTS.sfx.enabled,
    },
    beds: {
      enabled: typeof stored.beds?.enabled === 'boolean' ? stored.beds.enabled : DEFAULTS.beds.enabled,
      requestIntros: typeof stored.beds?.requestIntros === 'boolean' ? stored.beds.requestIntros : DEFAULTS.beds.requestIntros,
      thresholdSec: Number.isFinite(stored.beds?.thresholdSec) ? stored.beds.thresholdSec : DEFAULTS.beds.thresholdSec,
      crossSec: Number.isFinite(stored.beds?.crossSec) ? stored.beds.crossSec : DEFAULTS.beds.crossSec,
      tailSec: Number.isFinite(stored.beds?.tailSec) ? stored.beds.tailSec : DEFAULTS.beds.tailSec,
    },
    silenceTrim: {
      enabled:
        typeof stored.silenceTrim?.enabled === 'boolean'
          ? stored.silenceTrim.enabled
          : DEFAULTS.silenceTrim.enabled,
      minGapMs: Number.isInteger(stored.silenceTrim?.minGapMs) &&
        stored.silenceTrim.minGapMs >= BOUNDS.silenceTrimMinGapMs.min &&
        stored.silenceTrim.minGapMs <= BOUNDS.silenceTrimMinGapMs.max
        ? stored.silenceTrim.minGapMs
        : DEFAULTS.silenceTrim.minGapMs,
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
      navidrome: {
        enabled:
          typeof stored.scrobble?.navidrome?.enabled === 'boolean'
            ? stored.scrobble.navidrome.enabled
            : DEFAULTS.scrobble.navidrome.enabled,
      },
    },
    // Album cooldown (#1485 FR 3). Bounds-clamped, not validated: load is
    // lenient by contract.
    picker: {
      albumHours: Number.isFinite(Number(stored.picker?.albumHours))
        ? Math.min(
            PICKER_ALBUM_HOURS_BOUNDS.max,
            Math.max(PICKER_ALBUM_HOURS_BOUNDS.min, Number(stored.picker.albumHours)),
          )
        : DEFAULTS.picker.albumHours,
      // Minimum-track-length floor (#1573). The crossfade floor is NOT
      // re-applied on load: a crossfade lowered later must not delete a floor
      // the operator set deliberately.
      minTrackLengthSeconds:
        coerceMinTrackLengthSeconds(stored.picker?.minTrackLengthSeconds, false)
        ?? DEFAULTS.picker.minTrackLengthSeconds,
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

// Lenient: drops invalid entries rather than failing boot.

export async function update(patch) {
  const cur = await load();
  const next = JSON.parse(JSON.stringify(cur));
  let restart = false;

  // On the shared schema (#1348, settings/patch-registry.ts). The schema says
  // what a value may BE; whether it costs a mixer restart stays here.
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
  if ('ducking' in patch) {
    const dk = parseSettingsPatchKey<{ voice?: number; intro?: number }>('ducking', patch.ducking);
    // Per-field change gating: the panel posts the whole block, so only a real
    // change may set the restart flag.
    if (dk.voice !== undefined && dk.voice !== cur.ducking.voice) {
      next.ducking.voice = dk.voice;
      restart = true;
    }
    if (dk.intro !== undefined && dk.intro !== cur.ducking.intro) {
      next.ducking.intro = dk.intro;
      restart = true;
    }
  }
  if ('maxTrackSeconds' in patch || 'maxTrackMinutes' in patch) {
    // Applies the shared schema's bound to the RESOLVED value (seconds, or the
    // legacy minutes alias x 60).
    const parsedCap = maxTrackSecondsValueSchema(BOUNDS.maxTrackSeconds).safeParse(
      rawMaxTrackSec(patch),
    );
    if (!parsedCap.success) throw new Error(parsedCap.error.issues[0].message);
    const v = parsedCap.data;
    // Non-zero caps must clear the crossfade-relative floor (0 = unlimited
    // stays allowed). Uses next's crossfade, applied above if this patch
    // changed it.
    const floor = minTrackSeconds(next);
    if (v !== 0 && v < floor) {
      throw new Error(
        `maxTrackSeconds must be 0 (no limit) or at least ${floor}s`,
      );
    }
    // Read live by the drain + auto-playlist refresh; no restart.
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
      // Enforced controller-side (scheduler cleanup); no restart.
      next.archive.retentionDays = a.retentionDays;
    }
  }
  if ('backups' in patch) {
    const b = parseSettingsPatchKey<Partial<ScheduledBackupSettings>>(
      'backups',
      patch.backups,
    );
    // Read live by the scheduler's hourly tick; no restart.
    if (b.cadence !== undefined) next.backups.cadence = b.cadence;
    if (b.keep !== undefined) next.backups.keep = b.keep;
  }
  if ('stream' in patch) {
    const st = parseSettingsPatchKey<Record<string, number | boolean | undefined>>(
      'stream',
      patch.stream,
    );
    // Every encoder field restarts the mixer, and only on a real change.
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
    // Listener-side buffer depth (Icecast <burst-size>, seconds); 0 disables
    // burst-on-connect, capped at 60s. restart=true because burst lives in
    // icecast.xml, re-rendered when the telnet restart bounces the container.
    // Change-gated against `cur`, which requires load() to compose it.
    if (st.bufferSeconds !== undefined && st.bufferSeconds !== cur.stream.bufferSeconds) {
      next.stream.bufferSeconds = st.bufferSeconds as number;
      restart = true;
    }
    // Concurrent-listener ceiling (Icecast <limits><clients>). Same lifecycle
    // as bufferSeconds. ICECAST_MAX_CLIENTS in the broadcast container's env
    // WINS at render time, so this save can be a no-op on air.
    if (st.maxListeners !== undefined && st.maxListeners !== cur.stream.maxListeners) {
      next.stream.maxListeners = st.maxListeners as number;
      restart = true;
    }
    // Enforced controller-side over telnet (broadcast/stream-idle.ts); no
    // restart, and the monitor's next tick resumes the programme.
    if (st.idleWhenEmpty !== undefined) {
      next.stream.idleWhenEmpty = st.idleWhenEmpty as boolean;
    }
    if (st.idleAfterMinutes !== undefined) {
      next.stream.idleAfterMinutes = st.idleAfterMinutes as number;
    }
    // Listener-country fallbacks, read live per beacon; no restart. Clearing
    // either to '' is a legitimate save, hence no truthiness guard.
    for (const k of ['countryHeader', 'geoipDbPath'] as const) {
      if (st[k] !== undefined) (next.stream as Record<string, unknown>)[k] = st[k];
    }
  }
  if ('loudness' in patch) {
    // Read live by queue.applyLoudnessGain; applies from the next queued track.
    const lo = parseSettingsPatchKey<Record<string, unknown>>('loudness', patch.loudness);
    for (const k of ['targetLufs', 'maxBoostDb', 'source'] as const) {
      if (lo[k] !== undefined) (next.loudness as Record<string, unknown>)[k] = lo[k];
    }
  }
  if ('weather' in patch) {
    const w = parseSettingsPatchKey<Record<string, unknown>>('weather', patch.weather);
    // `undefined` means the schema chose to IGNORE the value (non-string, or
    // blank for locationName).
    for (const k of ['lat', 'lng', 'locationName', 'onAirLocation', 'units'] as const) {
      if (w[k] !== undefined) (next.weather as Record<string, unknown>)[k] = w[k];
    }
  }
  if ('station' in patch) {
    // The schema resolves '' to the product default; the restart decision is a
    // comparison against `cur`.
    const resolved = parseSettingsPatchKey<string>('station', patch.station);
    if (resolved !== cur.station) {
      restart = true;
    }
    next.station = resolved;
  }
  if ('stationDescription' in patch) {
    // No restart: read per-request by the web app's generateMetadata().
    next.stationDescription = parseSettingsPatchKey<string>(
      'stationDescription',
      patch.stationDescription,
    );
  }
  if ('timezone' in patch) {
    // '' = back to Auto (container TZ); setStationTimezone() below pushes the
    // accepted value into time.ts's module state.
    next.timezone = parseSettingsPatchKey<string>('timezone', patch.timezone);
  }
  if ('locale' in patch) {
    next.locale = parseSettingsPatchKey<string>('locale', patch.locale);
  }
  if ('theme' in patch) {
    const t = parseSettingsPatchKey<{ active?: string }>('theme', patch.theme);
    if (t.active !== undefined) {
      const v = t.active;
      // A stale active theme falls back to the built-in default rather than
      // failing the save, which would abort a whole restore (#917).
      next.theme.active = (await isValidThemeId(v)) ? v : DEFAULT_THEME_ID;
      if (next.theme.active !== v) {
        console.warn(`[theme] active theme "${v}" is not a known theme id — falling back to "${DEFAULT_THEME_ID}"`);
      }
    }
  }
  // Context-only, no restart. Validate the vocabulary FIRST so same-patch maps
  // and festivals can reference a new mood; assertNoOrphanMoods runs after
  // shows are validated below.
  if ('moods' in patch) {
    next.moods = parseSettingsPatchKey('moods', patch.moods);
  }
  // The EFFECTIVE vocabulary, captured ONCE so maps, festivals and shows all
  // judge against the same list.
  const moodNames = (next.moods || []).map((m: any) => m.name);
  // `showIds: null` = this branch cannot check roster membership.
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
  // `djPrompts` replaces the whole library; `activeDjPromptId` picks the entry
  // ('' = built-in default). Legacy single-field `djPrompt` maps onto the
  // library: '' selects the default, custom text reuses or appends an entry.
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
    // Length + placeholder rules are the schema's; the MAPPING onto the
    // library stays here.
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
      // A library-only patch removed the active entry; fall back to default.
      next.activeDjPromptId = '';
    }
    // djPrompt stays the resolved active text.
    next.djPrompt =
      next.djPrompts.find((p: DjPromptEntry) => p.id === next.activeDjPromptId)?.text ?? '';
  }
  // Appended to BOTH prompt paths, which the djPrompt template never reaches
  // (#1182). Empty = off.
  if ('djHouseRules' in patch) {
    next.djHouseRules = parseSettingsPatchKey<string>('djHouseRules', patch.djHouseRules);
  }
  // Applies live; the policy module reads it on every call.
  if ('djSpeakClock' in patch) {
    next.djSpeakClock = parseSettingsPatchKey<boolean>('djSpeakClock', patch.djSpeakClock);
  }
  // Applies live; broadcast/talk-air.ts reads it on every talk tick.
  if ('djTalkOnlyBetweenTracks' in patch) {
    next.djTalkOnlyBetweenTracks =
      parseSettingsPatchKey<boolean>('djTalkOnlyBetweenTracks', patch.djTalkOnlyBetweenTracks);
  }
  if ('handover' in patch) {
    // Read live by broadcast/handover-policy.ts each programme tick.
    const hv = parseSettingsPatchKey<{ offsetMinutes?: number }>('handover', patch.handover);
    if (hv.offsetMinutes !== undefined) next.handover.offsetMinutes = hv.offsetMinutes;
  }
  // Show-boundary fade (#1574), read live by the drain; no restart.
  if ('fadeAtShowEnd' in patch) {
    next.fadeAtShowEnd = parseSettingsPatchKey<boolean>('fadeAtShowEnd', patch.fadeAtShowEnd);
  }
  if ('personas' in patch) {
    next.personas = validatePersonasStrict(patch.personas);
  }
  if ('shows' in patch) {
    // Snapshot the theme registry once so the validator can stay sync.
    const allowedThemeIds = new Set((await listThemes()).map(t => t.id));
    next.shows = validateShowsStrict(patch.shows, next.personas, allowedThemeIds, moodNames);
  }
  if ('schedule' in patch) {
    next.schedule = validateScheduleStrict(patch.schedule, next.shows);
  }
  if ('scheduleOverride' in patch) {
    next.scheduleOverride = validateScheduleOverrideStrict(patch.scheduleOverride, next.shows);
  }
  // Runs once the vocabulary AND any same-patch shows are validated.
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
      // Same strict validator every persona voice slot uses; `where` names the
      // full path. Deliberately NO "openai-compatible needs baseUrl" rule: an
      // unusable cloud fallback is skipped at rescue time rather than blocking
      // the save.
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
        // Canonicalise before validating so a pre-#1213 `fr` lands on `fr-fr`.
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
        // Built-in id OR shared-folder .wav filename (#213).
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
        // openai-compatible voices may legitimately be blank (server picks its
        // own); openai/elevenlabs require a voice id.
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
      // 'set' is getRedacted()'s sentinel: keep the stored key.
      if (c.apiKey !== undefined && c.apiKey !== 'set') {
        next.tts.cloud.apiKey = String(c.apiKey);
      } else if (c.provider !== undefined && c.provider !== savedCloudProvider) {
        // The shared inline slot belongs to the provider that created it: a
        // provider change without a replacement key must clear it, or a managed
        // key gets forwarded to an arbitrary compatible URL.
        next.tts.cloud.apiKey = '';
      }
      // Dedicated compatibility bearer; may persist while another managed
      // provider is selected globally.
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
      // Clamped, not rejected, so the DJ never goes silent on a typo. Saved for
      // every provider (so a provider switch preserves the tuning) but only sent
      // when provider === 'elevenlabs'.
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
      // Send `speed` upstream vs. stretch locally (#942); compat path only.
      if (c.sendSpeed !== undefined) {
        next.tts.cloud.sendSpeed = !!c.sendSpeed;
      }
      // Clamp numeric knobs; REJECT an unknown enum, which would otherwise
      // become a provider-side 422 and a different fallback voice.
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
      // Extra openai-compatible body fields (#1317). Rejected rather than
      // clamped: a bad param name/type 4xxs the request mid-show. Rule shared
      // with the send path (settings/compat-params.ts).
      if (c.compatParams !== undefined) {
        next.tts.cloud.compatParams = validateCompatParams(c.compatParams);
      }
      // Fish credentials live only in env/state/secrets.env; clear the legacy
      // inline slot so a later provider switch can't reinterpret a stale bearer.
      if (next.tts.cloud.provider === 'fish-audio') {
        next.tts.cloud.apiKey = '';
      }
      // No canonical endpoint, so refuse the provider without one.
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
          // Full parse, not a prefix test, so a malformed host/port is refused
          // at save time rather than failing the /health probe later.
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
    // Whole-array replace; read live on every speak() call, so no restart.
    if (t.corrections !== undefined) {
      next.tts.corrections = validateTtsCorrectionsStrict(t.corrections);
    }
  }
  if ('llm' in patch) {
    const l = patch.llm || {};
    applyLlmLegPatch(next.llm, l, 'llm');
    // Route the inline key into keys[provider] AFTER the provider is resolved
    // (#657).
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
    // openai-compatible needs a baseUrl.
    if (next.llm.provider === 'openai-compatible' && !next.llm.baseUrl) {
      throw new Error('llm.baseUrl is required when provider is "openai-compatible"');
    }
    // The needs-baseUrl rule applies only when the fallback is ENABLED, so a
    // half-filled disabled backup never blocks a save.
    if (l.fallback !== undefined) {
      const fb = l.fallback || {};
      if (fb.enabled !== undefined) {
        next.llm.fallback.enabled = !!fb.enabled;
      }
      applyLlmLegPatch(next.llm.fallback, fb, 'llm.fallback');
      // Keys live at next.llm.keys, routed by the fallback's provider.
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
  if ('picker' in patch) {
    const pk = parseSettingsPatchKey<Record<string, unknown>>('picker', patch.picker);
    if (pk.albumHours !== undefined) next.picker.albumHours = pk.albumHours as number;
    if (pk.minTrackLengthSeconds !== undefined) {
      // Whole seconds; the shared bounds helper is number-like (albumHours
      // takes fractions), so the rounding lands here.
      const v = Math.round(pk.minTrackLengthSeconds as number);
      // A positive FLOOR must clear the crossfade-derived minimum (a track
      // under 2x the crossfade gets no solo airtime); 0 = off stays allowed.
      // Uses next's crossfade, applied above if this patch changed it.
      const floor = minTrackSeconds(next);
      if (v !== 0 && v < floor) {
        throw new Error(
          `picker.minTrackLengthSeconds must be 0 (no floor) or at least ${floor}s`,
        );
      }
      // Read live by both pick paths and the auto-playlist refresh; no restart.
      next.picker.minTrackLengthSeconds = v;
    }
  }
  if ('search' in patch) {
    const sr = parseSettingsPatchKey<Record<string, unknown>>('search', patch.search);
    if (sr.provider !== undefined) next.search.provider = sr.provider as string;
    if (sr.baseUrl !== undefined) next.search.baseUrl = sr.baseUrl as string;
    if (sr.searxngEngines !== undefined) next.search.searxngEngines = sr.searxngEngines as string;
    // 'set' is getRedacted()'s sentinel, tested against the RAW patch value:
    // it is an instruction to the applier, not a value a schema could return.
    if (sr.apiKey !== undefined && (patch.search as Record<string, unknown>)?.apiKey !== 'set') {
      next.search.apiKey = sr.apiKey as string;
    }
  }
  if ('embedding' in patch) {
    const e = patch.embedding || {};
    if (e.enabled !== undefined) next.embedding.enabled = !!e.enabled;
    if (e.provider !== undefined) {
      const v = String(e.provider).trim();
      // '' means "follow settings.llm.provider".
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
    // Dedicated embedding endpoint (#405); '' inherits settings.llm.
    // providerBaseUrls is keyed by provider id (#1082).
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
    // Legacy flat baseUrl seeds the map under the EFFECTIVE provider (own,
    // else the chat provider); the flat field is re-derived below.
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
    // Tracks per tagging call. Clamp kept in sync with the CLI --batch flag
    // and load()'s normalisation (music/tag-library.ts).
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
  // Re-derived on EVERY update, not just when `embedding` was patched: the leg
  // inherits the chat provider, so an llm.provider-only change moves which map
  // slot is live. Runtime reads the flat field (#405/#1082).
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
        // Disabling a skill station-wide revokes it from every persona that
        // explicitly carries it. The `null` "all skills" sentinel is untouched.
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
    // Throws rather than silently ignoring: a swallowed out-of-range value
    // showed the admin UI a budget the sweep never used.
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
    // Nested block needs its own per-field loop: a flat copy would replace the
    // whole `effects` object, resetting the fields the patch did not send.
    const fx = tr.effects as Record<string, unknown> | undefined;
    if (fx !== undefined) {
      for (const k of TRANSITION_EFFECTS) {
        if (fx[k] !== undefined) (next.transitions.effects as Record<string, unknown>)[k] = fx[k];
      }
    }
  }
  // On the shared schema (#1348). The block schemas keep the branches' own
  // leniency: a non-object block is an empty patch, an absent field is left
  // alone.
  if ('sfx' in patch) {
    const sx = parseSettingsPatchKey<{ enabled?: boolean }>('sfx', patch.sfx);
    if (sx.enabled !== undefined) {
      next.sfx.enabled = sx.enabled;
    }
  }
  if ('beds' in patch) {
    const bd = parseSettingsPatchKey<{
      enabled?: boolean;
      requestIntros?: boolean;
      thresholdSec?: number;
      crossSec?: number;
      tailSec?: number;
    }>('beds', patch.beds);
    if (bd.enabled !== undefined) {
      next.beds.enabled = bd.enabled;
    }
    if (bd.requestIntros !== undefined) {
      next.beds.requestIntros = bd.requestIntros;
    }
    if (bd.thresholdSec !== undefined) {
      next.beds.thresholdSec = bd.thresholdSec;
    }
    if (bd.crossSec !== undefined) {
      next.beds.crossSec = bd.crossSec;
    }
    if (bd.tailSec !== undefined) {
      next.beds.tailSec = bd.tailSec;
    }
  }
  if ('silenceTrim' in patch) {
    const st = parseSettingsPatchKey<{
      enabled?: boolean;
      minGapMs?: number;
    }>('silenceTrim', patch.silenceTrim);
    if (st.enabled !== undefined) {
      next.silenceTrim.enabled = st.enabled;
    }
    if (st.minGapMs !== undefined) {
      next.silenceTrim.minGapMs = st.minGapMs;
    }
  }
  if ('ui' in patch) {
    // `skin` is slug-only: an invalid value is DROPPED (schema returns
    // undefined) rather than erroring the whole patch.
    const ui = parseSettingsPatchKey<Record<string, unknown>>('ui', patch.ui);
    for (const k of ['boothBuddy', 'skin', 'tuneInOverlay'] as const) {
      if (ui[k] !== undefined) (next.ui as Record<string, unknown>)[k] = ui[k];
    }
  }
  if ('privacy' in patch) {
    // The lock-needs-a-password invariant below is NOT a schema rule: it reads
    // MERGED state, so a lock turned on here can be satisfied by a stored
    // password.
    const pv = parseSettingsPatchKey<Record<string, unknown>>('privacy', patch.privacy);
    const rawPv = (patch.privacy || {}) as Record<string, unknown>;
    if (pv.privatePlayer !== undefined) {
      next.privacy.privatePlayer = pv.privatePlayer as boolean;
    }
    // Disclosure toggle, not a lock: outside the lock-needs-a-password
    // invariant below, no restart, applies on the next public read.
    if (pv.publishPersonaSouls !== undefined) {
      next.privacy.publishPersonaSouls = pv.publishPersonaSouls as boolean;
    }
    // 'set' is getRedacted()'s sentinel, compared against the RAW value:
    // ' set ' is NOT the sentinel and is stored as a password.
    if (pv.password !== undefined && rawPv.password !== 'set') {
      next.privacy.password = pv.password as string;
    }
    if (pv.listenerAuth !== undefined) {
      const v = pv.listenerAuth as boolean;
      if (v !== cur.privacy.listenerAuth) {
        // The toggle adds/removes <mount> auth blocks in icecast.xml, which
        // only re-render on a restart. Password changes validate live.
        next.privacy.listenerAuth = v;
        restart = true;
      }
    }
    // Never persist a lock that is on with no password behind it: the stream
    // would fail every listener closed at /listener-auth and the player would
    // render a prompt nobody can satisfy.
    if (
      (next.privacy.privatePlayer || next.privacy.listenerAuth) &&
      !next.privacy.password
    ) {
      throw new Error('set a station password before turning on a privacy lock');
    }
  }
  if ('requests' in patch) {
    // The schema decides "usable or absent" per field; the fallback to the
    // CURRENT value is this spread. An emptied admin input arrives as JSON null
    // = UNUSABLE (not 0), so it leaves the stored value alone rather than
    // clamping to the field's floor and closing the request line.
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
      navidrome?: Record<string, unknown>;
    }>('scrobble', patch.scrobble);
    const rawSb = (patch.scrobble || {}) as Record<string, Record<string, unknown> | undefined>;
    // 'set' is getRedacted()'s sentinel, tested against the RAW patch value.
    // It guards ONLY the secret fields: a username of literally 'set' is
    // stored as such.
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
    // No sentinel: Navidrome reuses config.navidrome's credentials (#1298).
    if (sb.navidrome !== undefined) {
      const nd = sb.navidrome;
      if (nd.enabled !== undefined) next.scrobble.navidrome.enabled = nd.enabled as boolean;
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

  // Post-patch integrity sweep: this patch may have orphaned a show owner, a
  // schedule slot or the active persona.
  {
    const personaIds = next.personas.map(p => p.id);
    next.shows = next.shows.filter(s => personaIds.includes(s.personaId));
    // A deleted persona vanishes from every guest roster; the show survives.
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
    // A takeover pinning a dead show dies with it; a null target is Default
    // programming, not an orphan, and survives.
    if (next.scheduleOverride && !isDefaultTakeover(next.scheduleOverride)) {
      const pinnedId = takeoverShowId(next.scheduleOverride);
      if (!pinnedId || !showIds.includes(pinnedId)) next.scheduleOverride = null;
    }
    if (!personaIds.includes(next.activePersonaId)) next.activePersonaId = personaIds[0];

    // Best-effort GC of avatar files for personas that no longer exist.
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
        // Directory doesn't exist yet.
      }
    }
  }

  setCache(next);
  // Applied on save; the next zonedParts() call picks it up, no restart.
  setStationTimezone(next.timezone);
  // shows + schedule persist to schedule.json; strip them from the
  // settings.json payload so legacy installs migrate forward on the first
  // write. The in-memory cache keeps the full merged shape.
  const { shows: _shows, schedule: _schedule, scheduleOverride: _override, ...settingsPersist } = next;
  // Atomic replace: a crash mid-write must not take the whole config.
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

// Called at startup so the files exist before Liquidsoap's next start.
// Idempotent.
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

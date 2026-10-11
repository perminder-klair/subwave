import { normalizeStationLocale } from '../../../lib/format';
import { normalizeGeminiSafety, TRANSITION_EFFECTS, type TransitionEffect } from '../../../lib/schemas.generated';
import type { FormState, SettingsData, LlmHeaderRow } from './shared';

// The single client-side copy, read by both form hydration and the dirty-check.
// Must mirror DEFAULTS.tts.cloud in controller/src/settings.ts.
export const ELEVENLABS_VS_DEFAULTS = {
  voiceStability: 0.5,
  voiceStyle: 0,
  voiceSimilarityBoost: 0.75,
  voiceUseSpeakerBoost: true,
} as const;

export const FISH_TTS_DEFAULTS = {
  temperature: 0.7,
  topP: 0.7,
  latency: 'normal' as const,
};

/**
 * Wire map -> editor rows. Order is the stored order, so the list renders the
 * way the operator left it.
 */
function headerRows(raw: Record<string, string> | undefined): LlmHeaderRow[] {
  if (!raw || typeof raw !== 'object') return [];
  return Object.keys(raw).map((name) => ({ name, value: raw[name] ?? '' }));
}

export function settingsForm(v: NonNullable<SettingsData['values']>): FormState {
  return {
    crossfadeDuration: String(v.crossfadeDuration ?? ''),
    ducking: {
      voice: String(v.ducking?.voice ?? 0.22),
      intro: String(v.ducking?.intro ?? 0.3),
    },
    maxTrackLengthMode: v.maxTrackLengthMode === 'exclude' ? 'exclude' : 'cut',
    maxTrackSeconds: String(v.maxTrackSeconds ?? 0),
    fadeAtShowEnd: v.fadeAtShowEnd === true,
    silenceTrim: {
      enabled: v.silenceTrim?.enabled ?? false,
      minGapMs: String(v.silenceTrim?.minGapMs ?? 1500),
    },
    transitions: {
      pairDrain: v.transitions?.pairDrain ?? true,
      stemBlends: v.transitions?.stemBlends ?? false,
      // Absent reads as ON, matching the controller's resolver
      // (settings/transition-effects.ts) — a station that has never saved
      // this block has the whole kit.
      effects: Object.fromEntries(
        TRANSITION_EFFECTS.map(k => [k, v.transitions?.effects?.[k] !== false]),
      ) as Record<TransitionEffect, boolean>,
      stemCache: v.audio?.stemCache ?? false,
      stemCacheGb: String(v.audio?.stemCacheGb ?? 15),
    },
    archive: {
      enabled: v.archive?.enabled ?? false,
      bitrate: String(v.archive?.bitrate ?? 128),
      retentionDays: String(v.archive?.retentionDays ?? 30),
    },
    stream: {
      opusEnabled: v.stream?.opusEnabled ?? true,
      opusBitrate: String(v.stream?.opusBitrate ?? 96),
      flacEnabled: v.stream?.flacEnabled ?? false,
      aacEnabled: v.stream?.aacEnabled ?? false,
      aacBitrate: String(v.stream?.aacBitrate ?? 192),
      bitrate: String(v.stream?.bitrate ?? 192),
      bufferSeconds: String(v.stream?.bufferSeconds ?? 22),
      oggIcyMetadata: v.stream?.oggIcyMetadata ?? true,
      idleWhenEmpty: v.stream?.idleWhenEmpty ?? false,
      idleAfterMinutes: String(v.stream?.idleAfterMinutes ?? 10),
      maxListeners: String(v.stream?.maxListeners ?? 100),
      countryHeader: v.stream?.countryHeader ?? '',
      geoipDbPath: v.stream?.geoipDbPath ?? '',
    },
    loudness: {
      targetLufs: String(v.loudness?.targetLufs ?? -14),
      maxBoostDb: String(v.loudness?.maxBoostDb ?? 6),
      source: v.loudness?.source ?? 'replaygain-then-measured',
    },
    station: v.station ?? '',
    stationDescription: v.stationDescription ?? '',
    timezone: v.timezone ?? '',
    locale: normalizeStationLocale(v.locale),
    privacy: {
      privatePlayer: v.privacy?.privatePlayer ?? false,
      listenerAuth: v.privacy?.listenerAuth ?? false,
      // Arrives as the 'set' sentinel ('' when unset) — never the secret.
      password: v.privacy?.password ?? '',
      publishPersonaSouls: v.privacy?.publishPersonaSouls ?? false,
    },
    requests: {
      enabled: v.requests?.enabled !== false,
      maxPending: String(v.requests?.maxPending ?? 6),
      cooldownSec: String(v.requests?.cooldownSec ?? 60),
      perIpHourlyCap: String(v.requests?.perIpHourlyCap ?? 8),
      globalHourlyCap: String(v.requests?.globalHourlyCap ?? 30),
      repeatCooldownMin: String(v.requests?.repeatCooldownMin ?? 120),
      onePendingPerIp: v.requests?.onePendingPerIp !== false,
    },
    kokoroLang: v.tts?.kokoro?.lang ?? '',
    // Absent (a settings.json predating the key) reads as OFF, matching the
    // controller's own coercion in settings.load().
    djTalkOnlyBetweenTracks: v.djTalkOnlyBetweenTracks === true,
    pauseTalkMinSeconds: String(v.pauseTalkMinSeconds ?? 20),
    djBehaviour: {
      showWelcome: v.djBehaviour?.showWelcome === true,
      previewNextShow: v.djBehaviour?.previewNextShow !== false,
      sameHostAcknowledgement: v.djBehaviour?.sameHostAcknowledgement === true,
      extendedSleeveNotes: v.djBehaviour?.extendedSleeveNotes === true,
      releaseYearMentions: v.djBehaviour?.releaseYearMentions ?? 'regular',
      recapLimit: String(v.djBehaviour?.recapLimit ?? 10),
      recapMinutes: String(v.djBehaviour?.recapMinutes ?? 120),
      recapChars: String(v.djBehaviour?.recapChars ?? 140),
    },
    weather: {
      lat: String(v.weather?.lat ?? ''),
      lng: String(v.weather?.lng ?? ''),
      locationName: v.weather?.locationName ?? '',
      onAirLocation: v.weather?.onAirLocation ?? '',
      units: v.weather?.units === 'imperial' ? 'imperial' : 'metric',
    },
    tts: {
      // Absent (a settings.json predating the key) reads as ON, matching the
      // controller's own coercion in settings.load().
      enabled: v.tts?.enabled !== false,
      defaultEngine: v.tts?.defaultEngine ?? 'piper',
      // Absent block = off, matching the controller's normalizeTtsFallback().
      fallback: {
        enabled: v.tts?.fallback?.enabled === true,
        engine: v.tts?.fallback?.engine ?? 'piper',
        voice: v.tts?.fallback?.voice ?? '',
        cloudProvider: v.tts?.fallback?.cloudProvider ?? 'openai',
      },
      kokoro: { voice: v.tts?.kokoro?.voice ?? 'bf_isabella' },
      chatterbox: { referenceVoice: v.tts?.chatterbox?.referenceVoice ?? '' },
      pocketTts: { voice: v.tts?.pocketTts?.voice ?? 'alba' },
      // Absent block = the engine's own defaults, matching the controller's
      // coercion: an empty model means "walk the fallback chain".
      gemini: {
        // Absent = browse every language, which is the pre-existing behaviour
        // of a station that never set it.
        libraryLanguage: v.tts?.gemini?.libraryLanguage ?? '',
        model: v.tts?.gemini?.model ?? '',
        voice: v.tts?.gemini?.voice ?? 'Puck',
        pronunciation: v.tts?.gemini?.pronunciation ?? '',
      },
      cloud: {
        enabled: v.tts?.cloud?.enabled ?? false,
        provider: v.tts?.cloud?.provider ?? 'openai',
        model: v.tts?.cloud?.model ?? '',
        voice: v.tts?.cloud?.voice ?? '',
        baseUrl: v.tts?.cloud?.baseUrl ?? '',
        voiceStability: typeof v.tts?.cloud?.voiceStability === 'number' ? v.tts.cloud.voiceStability : ELEVENLABS_VS_DEFAULTS.voiceStability,
        voiceStyle: typeof v.tts?.cloud?.voiceStyle === 'number' ? v.tts.cloud.voiceStyle : ELEVENLABS_VS_DEFAULTS.voiceStyle,
        voiceSimilarityBoost: typeof v.tts?.cloud?.voiceSimilarityBoost === 'number' ? v.tts.cloud.voiceSimilarityBoost : ELEVENLABS_VS_DEFAULTS.voiceSimilarityBoost,
        voiceUseSpeakerBoost: typeof v.tts?.cloud?.voiceUseSpeakerBoost === 'boolean' ? v.tts.cloud.voiceUseSpeakerBoost : ELEVENLABS_VS_DEFAULTS.voiceUseSpeakerBoost,
        temperature: typeof v.tts?.cloud?.temperature === 'number' ? v.tts.cloud.temperature : FISH_TTS_DEFAULTS.temperature,
        topP: typeof v.tts?.cloud?.topP === 'number' ? v.tts.cloud.topP : FISH_TTS_DEFAULTS.topP,
        latency: v.tts?.cloud?.latency === 'low'
          ? 'low'
          : v.tts?.cloud?.latency === 'balanced'
            ? 'balanced'
            : FISH_TTS_DEFAULTS.latency,
        // Extra openai-compatible body fields (issue #1317). Rows are text
        // pairs on the wire too — the controller coerces them to JSON types
        // at send time, so the form never has to guess a value's shape.
        compatParams: Array.isArray(v.tts?.cloud?.compatParams)
          ? v.tts.cloud.compatParams.map(p => ({ key: String(p?.key ?? ''), value: String(p?.value ?? '') }))
          : [],
      },
      remote: { url: v.tts?.remote?.url ?? '' },
      // Per-engine voice level (dB), keyed by engine id — `pocket-tts` (hyphen).
      gainDb: {
        piper: 0,
        kokoro: 0,
        chatterbox: 0,
        'pocket-tts': 0,
        cloud: 0,
        remote: 0,
        ...(v.tts?.gainDb || {}),
      },
      // Per-engine speech speed (×), keyed by engine id — `pocket-tts` (hyphen).
      speed: {
        piper: 1,
        kokoro: 1,
        chatterbox: 1,
        'pocket-tts': 1,
        cloud: 1,
        remote: 1,
        ...(v.tts?.speed || {}),
      },
      corrections: (v.tts?.corrections || []).map(c => ({ from: c.from ?? '', to: c.to ?? '' })),
    },
    llm: {
      provider: v.llm?.provider ?? 'ollama',
      model: v.llm?.model ?? '',
      ollamaUrl: v.llm?.ollamaUrl ?? '',
      numCtx: typeof v.llm?.numCtx === 'number' ? v.llm.numCtx : 16384,
      repeatPenalty: typeof v.llm?.repeatPenalty === 'number' ? v.llm.repeatPenalty : 1.15,
      // Stored providerBaseUrls win; otherwise the legacy single baseUrl seeds
      // the current provider's slot so no URL is lost.
      providerBaseUrls: (() => {
        const llmAny = v.llm as ({ provider?: string; baseUrl?: string; providerBaseUrls?: Record<string, string> }) | undefined;
        const stored = llmAny?.providerBaseUrls;
        if (stored && typeof stored === 'object') return { ...stored };
        const legacy = llmAny?.baseUrl ?? '';
        const prov = llmAny?.provider ?? 'ollama';
        return legacy ? { [prov]: legacy } : {};
      })(),
      headers: headerRows(v.llm?.headers),
      compatibleMode: v.llm?.compatibleMode === 'hosted' ? 'hosted' : 'local',
      reasoning: !!v.llm?.reasoning,
      toolChoice: v.llm?.toolChoice === 'auto' ? 'auto' : 'required',
      pickerAgent: !!v.llm?.pickerAgent,
      // Fallback must track the controller's default (config.ts, 250): a
      // settings.json written before the field existed omits the key, and
      // seeding the OLD default here means opening Settings and saving any
      // LLM field silently persists it over the new one.
      noRepeatWindow: String(typeof v.llm?.noRepeatWindow === 'number' ? v.llm.noRepeatWindow : 250),
      artistVarietyWindow: String(typeof v.llm?.artistVarietyWindow === 'number' ? v.llm.artistVarietyWindow : 5),
      requestWebResolve: !!v.llm?.requestWebResolve,
      agentTimeoutMs: typeof v.llm?.agentTimeoutMs === 'number' ? v.llm.agentTimeoutMs : 45000,
      pauseWhenEmpty: !!v.llm?.pauseWhenEmpty,
      dailyTokenCap: typeof v.llm?.dailyTokenCap === 'number' ? v.llm.dailyTokenCap : 0,
      budgetSoftPct: typeof v.llm?.budgetSoftPct === 'number' ? v.llm.budgetSoftPct : 80,
      exemptRequests: v.llm?.exemptRequests !== false,
      maxOutputTokens: typeof v.llm?.maxOutputTokens === 'number' ? v.llm.maxOutputTokens : 0,
      discoverySteps: typeof v.llm?.discoverySteps === 'number' ? v.llm.discoverySteps : 0,
      geminiSafety: normalizeGeminiSafety(v.llm?.geminiSafety),
      fallback: {
        enabled: !!v.llm?.fallback?.enabled,
        provider: v.llm?.fallback?.provider ?? 'ollama',
        model: v.llm?.fallback?.model ?? '',
        ollamaUrl: v.llm?.fallback?.ollamaUrl ?? '',
        numCtx: typeof v.llm?.fallback?.numCtx === 'number' ? v.llm.fallback.numCtx : 16384,
        repeatPenalty: typeof v.llm?.fallback?.repeatPenalty === 'number' ? v.llm.fallback.repeatPenalty : 1.15,
        discoverySteps: typeof v.llm?.fallback?.discoverySteps === 'number' ? v.llm.fallback.discoverySteps : 0,
        geminiSafety: normalizeGeminiSafety(v.llm?.fallback?.geminiSafety),
        providerBaseUrls: (() => {
          const fbAny = v.llm?.fallback as ({ provider?: string; baseUrl?: string; providerBaseUrls?: Record<string, string> }) | undefined;
          const stored = fbAny?.providerBaseUrls;
          if (stored && typeof stored === 'object') return { ...stored };
          const legacy = fbAny?.baseUrl ?? '';
          const prov = fbAny?.provider ?? 'ollama';
          return legacy ? { [prov]: legacy } : {};
        })(),
        headers: headerRows(v.llm?.fallback?.headers),
        compatibleMode: v.llm?.fallback?.compatibleMode === 'hosted' ? 'hosted' : 'local',
        reasoning: !!v.llm?.fallback?.reasoning,
      },
    },
    search: {
      provider: v.search?.provider ?? 'duckduckgo',
      // GET /settings returns the apiKey redacted to 'set' | '' — that
      // round-trips through POST harmlessly (settings.update ignores 'set').
      apiKey: v.search?.apiKey ?? '',
      baseUrl: v.search?.baseUrl ?? '',
      searxngEngines: v.search?.searxngEngines ?? '',
    },
    embedding: {
      enabled: v.embedding?.enabled ?? true,
      provider: v.embedding?.provider ?? '',
      model: v.embedding?.model ?? '',
      headers: headerRows(v.embedding?.headers),
      providerBaseUrls: (() => {
        const stored = (v.embedding as { providerBaseUrls?: Record<string, string> })?.providerBaseUrls;
        if (stored && typeof stored === 'object') return { ...stored };
        // Legacy migration keys by the EFFECTIVE provider (own, else the chat
        // provider), the same key LibrarySection reads and writes.
        const legacy = v.embedding?.baseUrl ?? '';
        const prov = v.embedding?.provider || v.llm?.provider || '';
        return legacy && prov ? { [prov]: legacy } : {};
      })(),
      ollamaUrl: v.embedding?.ollamaUrl ?? '',
      seedCount: String(v.embedding?.seedCount ?? 0),
      knnNeighbours: String(v.embedding?.knnNeighbours ?? 10),
      moodVoteThreshold: String(v.embedding?.moodVoteThreshold ?? 0.4),
      confidenceThreshold: String(v.embedding?.confidenceThreshold ?? 0.35),
      maxActiveLearningRounds: String(v.embedding?.maxActiveLearningRounds ?? 3),
      audioFusionWeight: String(v.embedding?.audioFusionWeight ?? 0.5),
      batchSize: String(v.embedding?.batchSize ?? 25),
      enrichment: {
        lastfmTags: v.embedding?.enrichment?.lastfmTags ?? false,
        lyrics: v.embedding?.enrichment?.lyrics ?? true,
      },
    },
    scrobble: {
      lastfm: {
        enabled: !!v.scrobble?.lastfm?.enabled,
        // 'set' sentinel from getRedacted() — round-trips harmlessly.
        apiKey: v.scrobble?.lastfm?.apiKey ?? '',
        apiSecret: v.scrobble?.lastfm?.apiSecret ?? '',
        sessionKey: v.scrobble?.lastfm?.sessionKey ?? '',
        username: v.scrobble?.lastfm?.username ?? '',
      },
      listenbrainz: {
        enabled: !!v.scrobble?.listenbrainz?.enabled,
        userToken: v.scrobble?.listenbrainz?.userToken ?? '',
        username: v.scrobble?.listenbrainz?.username ?? '',
        baseUrl: v.scrobble?.listenbrainz?.baseUrl ?? '',
      },
      navidrome: {
        enabled: !!v.scrobble?.navidrome?.enabled,
      },
    },
    picker: {
      // 0 = off, and that IS the shipped default — an absent key must read as
      // off rather than inventing a cooldown the operator never asked for.
      albumHours: String(typeof v.picker?.albumHours === 'number' ? v.picker.albumHours : 0),
      // Same rule: absent reads as 0 = no floor, which is the shipped
      // default and today's behaviour.
      minTrackLengthSeconds: String(
        typeof v.picker?.minTrackLengthSeconds === 'number' ? v.picker.minTrackLengthSeconds : 0,
      ),
    },
    likes: {
      enabled: v.likes?.enabled ?? true,
      starInNavidrome: v.likes?.starInNavidrome ?? true,
      influenceDj: !!v.likes?.influenceDj,
      maxTracks: String(v.likes?.maxTracks ?? 10),
      windowDays: String(v.likes?.windowDays ?? 30),
    },
  };
}

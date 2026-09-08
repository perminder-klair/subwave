// Shipped defaults, the numeric bounds update() checks patches against, and the
// pure helpers that read them. Part of the settings/ split — see ../settings.ts.

import { config } from '../config.js';
// artist-guard.ts is a leaf (imports only music/recency.ts), so no cycle back
// through settings.
import { ARTIST_VARIETY_WINDOW } from '../broadcast/dj-agent/artist-guard.js';
import {
  BEDS_CROSS_SEC_BOUNDS,
  BEDS_TAIL_SEC_BOUNDS,
  SILENCE_TRIM_MIN_GAP_MS_BOUNDS,
  BACKUP_KEEP_BOUNDS,
  BACKUP_KEEP_DEFAULT,
  BEDS_THRESHOLD_SEC_BOUNDS,
  CROSSFADE_DURATION_BOUNDS,
  DUCK_DEPTH_BOUNDS,
  HANDOVER_OFFSET_BOUNDS,
  JINGLE_RATIO_BOUNDS,
  LOUDNESS_MAX_BOOST_DB_BOUNDS,
  LOUDNESS_TARGET_LUFS_BOUNDS,
} from '../schemas/settings.js';
import { SHOW_MAX_TRACK_SECONDS, SHOW_MIN_TRACK_LENGTH_MAX } from '../schemas/show.js';
import { DEFAULT_THEME_ID } from '../themes.js';
import {
  AAC_BITRATES,
  FESTIVAL_DEFAULTS,
  LoudnessSource,
  MOOD_DEFAULTS,
  MP3_BITRATES,
  OPUS_BITRATES,
  PERIOD_MOOD_DEFAULTS,
  SEED_PERSONAS,
  WEATHER_MOOD_DEFAULTS,
  Webhook,
  emptyWeek,
} from './vocab.js';

export const DEFAULTS = {
  jingleRatio: 30, // 1 jingle per N music tracks
  crossfadeDuration: 10.0, // seconds
  // `smooth_add`'s `p`: the fraction of music LEFT UP, not the cut (0.22 is
  // ~-13 dB, 0.30 is ~-10). Read once at mixer startup from
  // liquidsoap_duck_{voice,intro}.txt, so a change needs a mixer restart.
  // `voice` is the heavy say.txt duck; `intro` the light talk-over duck.
  ducking: { voice: 0.22, intro: 0.30 },
  // Cap on autonomously-picked track length; 0 = no cap (#447). A show's own
  // maxTrackSeconds overrides it. Listener requests bypass it.
  maxTrackSeconds: 0,
  // Fade a long track out at the next show change (#1574). A show's own
  // `fadeAtShowEnd` (null = inherit) overrides it; absent at both levels = off.
  // The cut rides the #447 liq_cue_out stamp; policy in broadcast/show-boundary.ts.
  fadeAtShowEnd: false,
  // Hourly archive output, off by default (the second MP3 encoder is the
  // largest constant CPU cost, #137). retentionDays bounds disk growth
  // (~1.4 GB/day at 128 kbps); 0 = keep forever.
  archive: { enabled: false, bitrate: 128, retentionDays: 30 },
  // Scheduled rotating config backups (#1570). OFF by default, load-bearing:
  // this is the only scheduled job that DELETES operator files. `keep` is inert
  // until a cadence is picked.
  backups: { cadence: 'off' as const, keep: BACKUP_KEEP_DEFAULT },
  stream: {
    // Secondary Ogg-Opus mount, off by default: only Blink selects it and it
    // costs a continuous encoder plus a 44.1->48k resample.
    opusEnabled: false,
    opusBitrate: 96,
    flacEnabled: false,
    aacEnabled: false,
    aacBitrate: 192,
    bitrate: 192,
    // Icecast <burst-size> in SECONDS, not bytes; the entrypoint converts per
    // mount (#993). Also how far behind the live edge every listener sits, so
    // /now-playing publishes it and players subtract it (#1114).
    bufferSeconds: 22,
    // ICY (out-of-band) titles on the Ogg mounts, on by default: most clients
    // freeze on the in-band Ogg comment read at connect (#1052). foobar2000 is
    // the exception, hence the toggle. MP3/AAC always use ICY.
    oggIcyMetadata: true,
    // Idle pause (broadcast/stream-idle.ts): after idleAfterMinutes with zero
    // listeners the mounts serve silence and the music chain stops being pulled.
    idleWhenEmpty: false,
    idleAfterMinutes: 10,
    // Icecast <limits><clients>, applied at broadcast boot. ICECAST_MAX_CLIENTS
    // in the environment WINS over this; the entrypoint logs which it took.
    maxListeners: 100,
    // Listener-country fallbacks for the audience rollup (#1485), both empty by
    // default (only `cf-ipcountry` is read). `countryHeader` names the header a
    // proxy sets instead; `geoipDbPath` points at an operator-supplied MaxMind
    // database. GEOIP_DB_PATH in the environment wins over the setting.
    countryHeader: '',
    geoipDbPath: '',
  },
  // Per-track loudness normalisation, read live at annotate time. maxBoostDb
  // caps the upward direction only and is further limited by measured peak
  // headroom. `source` picks ReplayGain tags vs the analyzer's LUFS (#998).
  loudness: {
    targetLufs: -14,
    maxBoostDb: 6,
    source: 'replaygain-then-measured' as LoudnessSource,
  },
  weather: {
    // The only location Open-Meteo sees; never reaches a prompt or a public
    // response.
    lat: 30.7333,
    lng: 76.7794,
    // Operator-facing label. Never spoken, never published.
    locationName: 'Punjab',
    // Where the station CLAIMS to broadcast from: the prompt's {location} and
    // `location` in GET /dj + /now-playing. Blank falls back to locationName,
    // so the public label can stay broader than the weather coordinates.
    onAirLocation: '',
    units: 'metric' as 'metric' | 'imperial',
  },
  // Substituted into the prompt's {station} and returned by GET /dj.
  station: 'SUB/WAVE',
  // Blurb for link previews. Deliberately NOT the on-air persona's tagline,
  // which changes with the hour (#1086). Empty = the web app uses the tagline.
  // Never enters the DJ prompt.
  stationDescription: '',
  // IANA zone for everything with local-time semantics. Empty = container TZ.
  // Applied live via time.ts setStationTimezone().
  timezone: '',
  // Display formatting only; does not change schedule or time-of-day semantics.
  locale: 'en-GB' as 'en-GB' | 'en-US',
  // Id only; the token map lives with the theme registry (themes.ts +
  // ${STATE_DIR}/themes/).
  theme: { active: DEFAULT_THEME_ID },
  // Falls back to FESTIVAL_DEFAULTS when empty/absent.
  festivals: FESTIVAL_DEFAULTS,
  // Operator-editable mood system: vocabulary + per-mood CLAP prompt, the
  // day-period map and the weather-condition map ('' = no steer).
  moods: MOOD_DEFAULTS,
  moodSchedule: PERIOD_MOOD_DEFAULTS,
  weatherMoods: WEATHER_MOOD_DEFAULTS,
  // Player toggles, read via GET /state and applied live. `skin` is a slug
  // only: the web app owns the registry and falls back on an unknown id, so
  // nothing validates it here.
  ui: { boothBuddy: false, skin: 'classic', tuneInOverlay: true },
  // Two independent locks over ONE shared password (#478). `privatePlayer` is
  // UI-level and applies live; `listenerAuth` re-renders icecast.xml so it needs
  // a mixer restart (password changes apply live). Either lock on REQUIRES a
  // password — see update().
  // `publishPersonaSouls` is NOT a lock and takes no part in that rule: it gates
  // roster-wide disclosure of persona souls. GET /dj is unaffected, having
  // always published the ON-AIR soul one at a time.
  privacy: { privatePlayer: false, listenerAuth: false, password: '', publishPersonaSouls: false },
  // Listener-request gates, applied live: queue depth, requests/hour, per-track
  // repeat cooldown (0 = off), minimum gap, and a single IP's share.
  requests: {
    enabled: true,
    maxPending: 6,
    globalHourlyCap: 30,
    repeatCooldownMin: 120,
    cooldownSec: 60,
    perIpHourlyCap: 8,
    onePendingPerIp: true,
  },
  // '' = DEFAULT_DJ_PROMPT_TEMPLATE. Always the RESOLVED text of the active
  // djPrompts entry, so readers never have to chase the library.
  djPrompt: '',
  djPrompts: [],
  activeDjPromptId: '',
  // Appended to EVERY spoken-output prompt (renderDjPrompt, agentPersonaPreamble,
  // castHouseRulesBlock), none of which the djPrompt template reaches
  // (#1182, #1420).
  djHouseRules: '',
  // false = the wall clock stays off air; daypart colour survives. Manual
  // /dj/segment triggers stay exempt. Policy in broadcast/clock-policy.ts.
  djSpeakClock: true,
  // Talk placement (#1485 FR 5b). false = every scheduled segment but the
  // ident airs the minute it is written, ducking the song. true = every
  // SCHEDULED segment is held for the next track boundary, so a held segment
  // may air a track late (bounded by PENDING_VOICE_MAX_AGE_MS). Manual /dj
  // triggers stay exempt. Policy in broadcast/talk-air.ts.
  djTalkOnlyBetweenTracks: false,
  // Station-clock minutes BEFORE a show boundary that the outgoing host signs
  // off (#1576); 5 = :55 of the final hour. Must be a multiple of
  // HANDOVER_OFFSET_STEP_MINUTES, the stride the talk table's programme row
  // samples on — a window off that stride never airs. The ordering half carries
  // no dial: the incoming host always waits for one closing track.
  handover: { offsetMinutes: 5 },
  // One persona at a time; a scheduled show can override who is on air.
  personas: SEED_PERSONAS,
  activePersonaId: SEED_PERSONAS[0].id,
  shows: [],
  // 7x24 grid of showId|null; an empty hour runs autonomously.
  schedule: emptyWeek(),
  // Timed takeover (#930): an epoch-ms window outranking the weekly grid.
  // Persisted in schedule.json.
  scheduleOverride: null,
  tts: {
    // false = music only, and scripts are never GENERATED so no tokens are
    // spent on talk. Picks and jingles keep running (silence those with
    // jingleRatio: 0). Manual triggers exempt. Policy in broadcast/voice-policy.ts.
    enabled: true,
    defaultEngine: 'piper',
    // Rescue voice, the TTS analogue of settings.llm.fallback. Unlike the
    // hardcoded chain behind it (defaultEngine -> piper -> kokoro) it carries a
    // VOICE, not just an engine; same shape as a persona's tts block.
    fallback: { enabled: false, engine: 'piper', voice: '', cloudProvider: 'openai' },
    // Advisory only; nothing branches on it (availability comes from
    // isAvailable() at call time). The CLI reads it to decide COMPOSE_PROFILES.
    heavyEnabled: false,
    kokoro: { voice: 'bf_isabella', lang: '' },
    // Used when chatterbox resolves with no persona voice; empty = model default.
    chatterbox: { referenceVoice: '' },
    // Used when pocket-tts resolves with no persona voice.
    pocketTts: { voice: 'alba' },
    // Used when an engine resolves to 'cloud'. A persona chooses provider+voice;
    // `model` is shared. `enabled: false` reports unavailable regardless of key.
    cloud: {
      enabled: false,
      provider: 'openai',
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      // Legacy inline key; new credentials live in secrets.env.
      apiKey: '',
      // Bearer for authenticated openai-compatible servers; stays provider-scoped.
      compatApiKey: '',
      // Includes the /v1 suffix. Required only for 'openai-compatible'.
      baseUrl: '',
      // ElevenLabs voice_settings, sent only for that provider; ranges and
      // defaults match ElevenLabs' own (#696).
      voiceStability: 0.5,
      voiceStyle: 0,
      voiceSimilarityBoost: 0.75,
      voiceUseSpeakerBoost: true,
      // openai-compatible only: send `speed` upstream instead of stretching
      // locally with ffmpeg atempo. Off by default because compat servers are
      // uneven with the field (#942). Inert for openai/elevenlabs.
      sendSpeed: false,
      // Fish Audio S2.1 controls; persisted always, sent only for fish-audio.
      temperature: 0.7,
      topP: 0.7,
      latency: 'normal' as 'low' | 'normal' | 'balanced',
      // Free-form extra body fields for openai-compatible servers (#1317) —
      // Chatterbox's temperature/seed/exaggeration and whatever the next engine
      // invents. Stored as text and coerced to JSON types at send time. Rules
      // live in settings/compat-params.ts.
      compatParams: [] as { key: string; value: string }[],
    },
    // Self-hosted TTS endpoint over HTTP (POST /speak → audio body, gated on a
    // /health probe) — the TTS equivalent of the LLM's custom base URL.
    remote: { url: '' },
    // Per-engine trim (dB) applied via liq_amplify on every spoken segment, to
    // level the loudness gap between engines. Stacks with each persona's own
    // tts.gainDb. See TTS_GAIN_CLAMP_DB and audio/tts.ts:voiceGainDb().
    gainDb: { piper: 0, kokoro: 0, chatterbox: 0, 'pocket-tts': 0, cloud: 0, remote: 0 },
    // Per-engine speech-rate multiplier (0.5–2.0x), composed on top of the
    // daypart energy and each persona's tts.speed. Only piper/kokoro/cloud honour
    // it — the other entries are inert. See clampTtsSpeed().
    speed: { piper: 1, kokoro: 1, chatterbox: 1, 'pocket-tts': 1, cloud: 1, remote: 1 },
    // Find→replace pairs applied to every booth-bound line before any engine sees
    // it (audio/speech-text.ts), e.g. { from: 'GHz', to: 'gigahertz' }.
    corrections: [],
  },
  llm: {
    provider: 'ollama',
    model: '',
    // Legacy single inline-key slot, superseded by `keys`. Always '' after
    // load(); resolution reads `keys`, never this.
    apiKey: '',
    // Per-provider inline API keys (#657). Only inline-key providers
    // (openai-compatible, locca) populate this; env-var providers use
    // state/secrets.env. Namespacing stops a switch leaving one provider's key
    // where another reads.
    keys: {},
    // Empty → config.ollama.url. Only used when provider === 'ollama'.
    ollamaUrl: '',
    // Per-provider base URLs (#1082); `baseUrl` below is derived from this and
    // kept only as a migration source.
    providerBaseUrls: {} as Record<string, string>,
    baseUrl: '',
    // Extra request headers on every openai-compatible / locca call (#1618),
    // for gateways routing on a header rather than the bearer token. Ignored by
    // every other provider.
    headers: {} as Record<string, string>,
    // Chain-of-thought for reasoning models. Off: an uncapped <think> block on a
    // small model balloons every call.
    reasoning: false,
    // How the structured-output paths force a tool call. 'required' is the
    // reliable path for local models that ignore JSON mode; 'auto' is for servers
    // that crash on tool_choice:"required" (#570).
    toolChoice: 'required',
    // DISCOVERY rounds the DJ agent gets before it must commit (`done`).
    // 0 = follow the provider capability table; 1-5 overrides it (the descriptor
    // keys off the PROVIDER and cannot know which model it serves). Every round
    // is a separate billable call and all rounds share one agentTimeoutMs.
    // Raising it never buys extra `done` attempts: the step cap is budget + 1.
    discoverySteps: 0,
    // Ollama num_ctx (local Ollama only). Ollama's 4096 default silently
    // truncates the front of a ~8k+ picker prompt, so the model never calls
    // `done` (#291). 0 = don't send num_ctx.
    numCtx: 16384,
    // Repetition penalty for local openai-compatible / locca servers; 1.0 = off.
    // Injected into the request body (the AI SDK has no field for it) and ignored
    // by every other provider, Ollama included.
    repeatPenalty: 1.15,
    // On: the session DJ agent drives picks/links/requests as a tool-loop.
    // Off: the stateless pool picker runs instead.
    pickerAgent: true,
    // Never re-air any of the last N DISTINCT plays. Non-relaxable: it survives
    // the filterPickerCandidates starvation cascade. Clamped to library size at
    // use; 0 disables; listener requests exempt. See music/recency.ts.
    noRepeatWindow: config.queue.noRepeatWindow,
    // Artist spacing in slots. Soft: if the run surfaced nothing fresher the
    // original pick stands, so it never costs a slot. 0 leaves only the
    // always-on back-to-back guard.
    artistVarietyWindow: ARTIST_VARIETY_WINDOW,
    // Gives the listener-request agent (never the per-track picker) an
    // `identifyRequestedTrack` tool. No-op unless searchReady().
    requestWebResolve: false,
    // Wall-clock ceiling on one DJ-agent generation. Main and recovery runs each
    // get the full budget, so worst case per pick is ~2x this.
    agentTimeoutMs: 45000,
    // Pause autonomous DJ LLM work when Icecast reports zero listeners; the
    // stream coasts on the auto playlist.
    pauseWhenEmpty: false,
    // Daily UTC token budget; 0 = unlimited. At budgetSoftPct the DJ drops to
    // the pool picker and mutes optional segments; at the cap it stops calling
    // the model at all and coasts on auto.m3u. Music never stops.
    // Enforced in broadcast/dj-budget.ts.
    dailyTokenCap: 0,
    // Percent of dailyTokenCap entering the soft tier; 0 or 100 disables it.
    budgetSoftPct: 80,
    // On: listener requests still reach the agent over the hard cap. No effect
    // until dailyTokenCap is set.
    exemptRequests: true,
    // Per-call max OUTPUT tokens, distinct from the cumulative dailyTokenCap.
    // 0 = the strategy built-ins (4000 text / 8000 object / 8000 agent); a value
    // (clamped 500-8000) overrides all three (#712).
    maxOutputTokens: 0,
    // Capture every outbound request body to ${STATE_DIR}/logs/llm-debug.log
    // (last 10, newest first) and stderr. LLM_DEBUG_RAW forces it on.
    debugRawRequests: false,
    // Backup LLM. A call whose primary host is UNREACHABLE (refused/DNS/timeout,
    // NOT a 429/5xx from a live host) retries once here, then routes back to the
    // primary next call. Station-level toggles are not per-leg, and library
    // tagging does NOT fail over.
    fallback: {
      enabled: false,
      provider: 'ollama',
      model: '',
      apiKey: '',
      ollamaUrl: '',
      providerBaseUrls: {} as Record<string, string>,
      baseUrl: '',
      // Per-leg: the backup may be a different gateway with its own header.
      headers: {} as Record<string, string>,
      reasoning: false,
      toolChoice: 'required',
      numCtx: 16384,
      repeatPenalty: 1.15,
      // Per-leg: the backup may run a different model, so it resolves its own
      // budget.
      discoverySteps: 0,
    },
  },
  // Embedding-propagated library tagger (music/tag-library.ts). `provider`/
  // `model` default to following settings.llm; Anthropic has no first-party
  // embedding API, so that leg needs a different provider.
  embedding: {
    enabled: true,
    provider: '',         // empty → follow settings.llm.provider
    model: '',            // empty → sensible default per provider
    // Embeddings often need a different endpoint than chat. Empty = inherit
    // settings.llm's URL, correct only when the chat server also embeds
    // (e.g. Ollama). See #405, #1082.
    providerBaseUrls: {} as Record<string, string>,
    baseUrl: '',          // deprecated single slot — migration source only
    ollamaUrl: '',        // Ollama embedding server URL (ollama provider)
    apiKey: '',           // empty → inherit settings.llm.apiKey
    seedCount: 0,         // 0 → auto (autoSeedCount: ~4% of the library, 200–2500)
    // Confidence is topSim x coverage, a product of two sub-1 terms
    // (tag-propagator.ts), so these gates sit well below 1. New installs only:
    // loadWithDefaults prefers a stored value.
    knnNeighbours: 10,
    moodVoteThreshold: 0.4,
    confidenceThreshold: 0.35,
    maxActiveLearningRounds: 3,
    // Weight of CLAP audio neighbours in mood propagation (fuseNeighbours).
    // 0 = text-only; 1 = trust audio as much as text.
    audioFusionWeight: 0.5,
    batchSize: 25,
    enrichment: {
      // Last.fm crowd tags. Tri-state: true = always, false = never, null = auto
      // (only when a Last.fm api_key is configured). Uses artist.getTopTags,
      // falling back to Navidrome's getArtistInfo2 when forced on with no key.
      lastfmTags: null as boolean | null,
      lyrics: true,       // fetch + include lyric excerpt in embed text
      // Resolve original release years for compilation tracks via MusicBrainz
      // (#842): a compilation's `year` tag is the compilation's release date.
      // Keyless API throttled to 1 req/s, so default-on.
      originalYear: true,
    },
  },
  // `duckduckgo` needs no key; `tavily` and `brave` read SEARCH_API_KEY (or the
  // override here).
  search: {
    provider: 'duckduckgo',
    apiKey: '',
    baseUrl: '',
    // Comma-separated SearXNG engine pin (#1353); empty sends no engines= param.
    searxngEngines: '',
  },
  skills: {
    enabled: {},
  },
  audio: {
    // CLAP "sounds-like" embeddings. Needs the CLAP stack; without it the
    // request is a clean no-op and the pass still fills bpm/key.
    // ANALYZE_AUDIO_EMBEDDING=1 also enables it (env wins ON, never off), as do
    // the env flags on the two toggles below.
    embeddings: false,
    // Demucs vocal-activity ranges for talk timing and intro detection.
    // Expensive, so opt-in. ANALYZE_VOCAL_ACTIVITY=1 also enables it.
    vocalActivity: false,
    // Keep the analysis pass's head/tail Demucs stems as FLAC under
    // state/stems/<id>/ so a transition render is a mix, not a fresh separation.
    // ~13-25 MB per track (#1257), LRU-swept to stemCacheGb.
    stemCache: false,
    stemCacheGb: 15,
    // Pause the analysis pass while anyone is listening, resuming after
    // analyzeQuietMinutes listener-free (#1099). Checked between tracks inside
    // runAnalysisPass, so it covers manual runs too. ANALYZE_QUIET_ONLY=1
    // also enables it.
    analyzeQuietOnly: false,
    analyzeQuietMinutes: 10,
  },
  // Transition scheduling + stem-blend rendering (docs/stem-transitions-research.md).
  transitions: {
    // Hold each queued pick unsent until its successor is known (or the on-air
    // track nears its end) so exit stamps can be sized for the real pair (#749).
    // Off reverts to the eager drain.
    pairDrain: true,
    // Needs pairDrain plus the heavy analyzer with a warmed stem cache.
    stemBlends: false,
    // Per-effect kill switches (#1565), all on. Resolved through
    // broadcast/transition-policy.ts, which reads an absent or malformed block
    // as "all on".
    effects: {
      sweep: true,
      washout: true,
      blend: true,
      dissolve: true,
      chop: true,
      loop: true,
    },
  },
  // When disabled the segment-director agent never sees the effect catalogue.
  // The files stay on disk either way.
  sfx: {
    enabled: true,
  },
  // An instrumental between two songs for the DJ to talk over (broadcast/beds.ts
  // + bed-policy.ts). Off by default. Controller-side only, so no mixer restart.
  beds: {
    enabled: false,
    // Front-pad a LISTENER REQUEST's intro with a bed rather than talking over
    // the song's opening, however short the intro (#1465). On by default WITHIN
    // beds.enabled, which is itself off.
    requestIntros: true,
    // Bed when the DJ's clip runs longer than this. Consulted ONLY when the
    // incoming track's vocal onset is unknown; a measured onset wins. Requests
    // ignore it (see requestIntros).
    thresholdSec: 12,
    // The bed's exit crossfade: how long the next song takes to ramp in.
    crossSec: 6,
    // Solo bed between the DJ's last word and that ramp (#1485 FR 5c). Sized
    // INTO the bed, not out of it, so it is the quiet heard at any crossSec.
    tailSec: 3,
  },
  // Cut near-silent runs off a track's head/tail (music/silence-trim.ts stamps
  // liq_cue_in / liq_cue_out; radio.liq's cue_cut does the cutting). OFF by
  // default: it acts on a MEASUREMENT. Controller-side only, no mixer restart.
  silenceTrim: {
    enabled: false,
    // Gaps shorter than this are left alone: a segued album's inter-track space
    // is deliberate.
    minGapMs: 1500,
  },
  // Fire-and-forget station-event POSTs (event list in broadcast/webhooks.ts).
  webhooks: [] as Webhook[],
  webhooksPolicy: {
    // track.play POSTs only when listener count > 0; fail-CLOSED on an
    // unknown/non-finite count, like scrobble.
    trackPlayListenerGated: false,
  },
  // Each backend is independent and paste-only, gated on listener count > 0 at
  // scrobble time; an unknown count fails CLOSED. Keys live here or in
  // state/secrets.env (env wins). `username` is display-only.
  scrobble: {
    lastfm: {
      enabled: false,
      apiKey: '',
      apiSecret: '',
      sessionKey: '',
      username: '',
    },
    listenbrainz: {
      enabled: false,
      userToken: '',
      username: '',
      // Self-hosted LB-compatible scrobblers; submit URL is
      // `${baseUrl}/submit-listens`. Env LISTENBRAINZ_API_URL wins.
      baseUrl: '',
    },
    // Navidrome play reporting via Subsonic `scrobble` (#1298). Reuses
    // config.navidrome's credentials and, unlike the two above, has NO listener
    // gate (broadcast/scrobble-pure.ts). Off by default.
    navidrome: {
      enabled: false,
    },
  },

  // Track-selection windows read by BOTH pick paths.
  // `albumHours`: how long a record stays on cooldown after one of its tracks
  // airs (#1485 FR 3). 0 = OFF; the artist window already blocks everything a
  // shorter album window would, so it is only worth setting ABOVE that window.
  picker: {
    albumHours: 0,
    // Minimum track length in SECONDS below which a track is never PICKED
    // (#1573); 0 = off. A show's own `minTrackLengthSeconds` overrides it.
    // Distinct from settings.minTrackSeconds(), the crossfade-derived floor,
    // which is this key's LOWER BOUND. Listener requests are exempt.
    minTrackLengthSeconds: 0,
  },

  // The player heart button (#991). `starInNavidrome` mirrors a first like into
  // Navidrome; `influenceDj` feeds top-liked tracks to both pick paths as a
  // weighted preference, never a lock.
  likes: {
    enabled: true,
    starInNavidrome: true,
    influenceDj: false,
    maxTracks: 10,
    windowDays: 30, // 0 = all time
  },
};

export const BOUNDS = {
  // Keys converted to the shared schema (#1348) take their numbers from
  // schemas/settings.ts: a mirrored module may not import a non-mirrored one.
  jingleRatio: { ...JINGLE_RATIO_BOUNDS, type: 'int' },
  crossfadeDuration: { ...CROSSFADE_DURATION_BOUNDS, type: 'float' },
  duckingVoice: { ...DUCK_DEPTH_BOUNDS, type: 'float' },
  duckingIntro: { ...DUCK_DEPTH_BOUNDS, type: 'float' },
  handoverOffsetMinutes: { ...HANDOVER_OFFSET_BOUNDS, type: 'int' },
  bedsThresholdSec: { ...BEDS_THRESHOLD_SEC_BOUNDS, type: 'float' },
  bedsCrossSec: { ...BEDS_CROSS_SEC_BOUNDS, type: 'float' },
  bedsTailSec: { ...BEDS_TAIL_SEC_BOUNDS, type: 'float' },
  // Ceiling from the shared show schema: the strict show validator bounds-checks
  // a show's override against this station figure, so two copies would drift.
  maxTrackSeconds: { min: 0, max: SHOW_MAX_TRACK_SECONDS, type: 'int' },
  // The FLOOR's ceiling (#1573), from the same schema module for the same
  // reason. Far lower than the cap's — see SHOW_MIN_TRACK_LENGTH_MAX.
  minTrackLengthSeconds: { min: 0, max: SHOW_MIN_TRACK_LENGTH_MAX, type: 'int' },
  silenceTrimMinGapMs: { ...SILENCE_TRIM_MIN_GAP_MS_BOUNDS, type: 'int' },
  backupsKeep: { ...BACKUP_KEEP_BOUNDS, type: 'int' },
  loudnessTargetLufs: { ...LOUDNESS_TARGET_LUFS_BOUNDS, type: 'float' },
  loudnessMaxBoostDb: { ...LOUDNESS_MAX_BOOST_DB_BOUNDS, type: 'float' },
};

export const MP3_BITRATE_SET = new Set<number>(MP3_BITRATES);
export const OPUS_BITRATE_SET = new Set<number>(OPUS_BITRATES);
export const AAC_BITRATE_SET = new Set<number>(AAC_BITRATES);

// True when the four ElevenLabs voice_settings knobs are all untouched, in which
// case cloud-speech OMITS the block so ElevenLabs uses the voice's own saved
// settings rather than these literals (#915).
export function cloudVoiceSettingsAreDefault(c: unknown): boolean {
  const d = DEFAULTS.tts.cloud;
  const cc = c as {
    voiceStability?: unknown;
    voiceStyle?: unknown;
    voiceSimilarityBoost?: unknown;
    voiceUseSpeakerBoost?: unknown;
  } | null | undefined;
  return cc?.voiceStability === d.voiceStability
    && cc?.voiceStyle === d.voiceStyle
    && cc?.voiceSimilarityBoost === d.voiceSimilarityBoost
    && cc?.voiceUseSpeakerBoost === d.voiceUseSpeakerBoost;
}

// Integer SECOND count. `allowNull` splits the two callers: the station default
// has no "unset" state (missing = 0 = off), a per-show value uses null for
// "inherit" (0 there = unlimited override). Clamps rather than throws.
export function coerceMaxTrackSeconds(raw: unknown, allowNull: boolean): number | null {
  if (raw == null || raw === '') return allowNull ? null : 0;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return allowNull ? null : 0;
  return Math.min(BOUNDS.maxTrackSeconds.max, Math.max(0, n));
}

// Integer SECOND floor (#1573). Same allowNull split as coerceMaxTrackSeconds:
// station default missing = 0 = no floor, per-show null = inherit.
export function coerceMinTrackLengthSeconds(raw: unknown, allowNull: boolean): number | null {
  if (raw == null || raw === '') return allowNull ? null : 0;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return allowNull ? null : 0;
  return Math.min(BOUNDS.minTrackLengthSeconds.max, Math.max(0, n));
}

// Back-compat with the MINUTES-era `maxTrackMinutes`. Returns raw seconds
// (null/''/undefined untouched) for coerceMaxTrackSeconds to clamp.
export function rawMaxTrackSec(o: unknown): unknown {
  if (o == null) return o;
  const rec = o as Record<string, unknown>;
  if (rec.maxTrackSeconds != null && rec.maxTrackSeconds !== '') return rec.maxTrackSeconds;
  if (rec.maxTrackMinutes != null && rec.maxTrackMinutes !== '') return Number(rec.maxTrackMinutes) * 60;
  return rec.maxTrackSeconds;
}

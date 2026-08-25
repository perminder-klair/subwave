// Shipped defaults, the numeric bounds update() checks patches against, and the
// pure helpers that read them. Part of the settings/ split — see ../settings.ts.

import { config } from '../config.js';
// Pure policy constant — artist-guard.ts imports only music/recency.ts, which
// imports nothing, so this stays a leaf and can't cycle back through settings.
import { ARTIST_VARIETY_WINDOW } from '../broadcast/dj-agent/artist-guard.js';
import {
  BEDS_CROSS_SEC_BOUNDS,
  SILENCE_TRIM_MIN_GAP_MS_BOUNDS,
  BEDS_THRESHOLD_SEC_BOUNDS,
  CROSSFADE_DURATION_BOUNDS,
  JINGLE_RATIO_BOUNDS,
  LOUDNESS_MAX_BOOST_DB_BOUNDS,
  LOUDNESS_TARGET_LUFS_BOUNDS,
} from '../schemas/settings.js';
import { SHOW_MAX_TRACK_SECONDS } from '../schemas/show.js';
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
  // Station-wide cap on autonomously-picked track length; 0 = no cap (#447). A
  // show's own maxTrackSeconds overrides it (0 there = unlimited). Listener
  // requests always bypass it.
  maxTrackSeconds: 0,
  // Hourly archive output. Off by default — the second MP3 encoder is the
  // largest constant CPU cost in the broadcast container (#137). retentionDays
  // bounds disk growth (~1.4 GB/day at 128 kbps); normalizeArchiveRetentionDays
  // keeps pre-existing keep-forever installs at 0 so upgrades never delete tapes.
  archive: { enabled: false, bitrate: 128, retentionDays: 30 },
  stream: {
    // Secondary Ogg-Opus mount (/stream.opus). Off by default — only Blink
    // selects it (web/hooks/usePlayer.ts), and it costs a continuous encoder
    // plus a 44.1→48k resample. /stream.mp3 always serves everyone.
    opusEnabled: false,
    opusBitrate: 96,
    flacEnabled: false,
    aacEnabled: false,
    aacBitrate: 192,
    bitrate: 192,
    // Icecast <burst-size> expressed in SECONDS, not bytes: a fixed byte count
    // stretches at low bitrates (512 KB is ~22s at 192k but ~66s at 64k), so the
    // entrypoint converts per mount (#993).
    //
    // This is also how far behind the live edge every listener sits for their
    // whole connection, so /now-playing publishes it as stream.bufferSeconds and
    // players subtract it to line titles up with the audio in someone's ears (#1114).
    bufferSeconds: 22,
    // ICY (out-of-band) titles on the Ogg mounts. ON by default: most clients
    // read the in-band Ogg comment once at connect and then freeze on that title
    // (#1052). foobar2000 is the exception — it parses chained-Ogg tags correctly
    // and the ICY channel breaks its Ogg-FLAC metadata — hence a toggle.
    // MP3/AAC always use ICY and are unaffected.
    oggIcyMetadata: true,
    // Idle pause (broadcast/stream-idle.ts): after idleAfterMinutes with zero
    // listeners the mounts keep serving silence but the music chain stops being
    // pulled — no decode, no Navidrome downloads — resuming mid-track on connect.
    idleWhenEmpty: false,
    idleAfterMinutes: 10,
  },
  // Per-track loudness normalisation (music/mix.ts gainForLoudness), read live at
  // annotate time. maxBoostDb caps the upward direction only, and the boost is
  // further limited by the track's own measured peak headroom. `source` picks the
  // figure: embedded ReplayGain tags (whole-file R128) vs the analyzer's measured
  // LUFS (leading window only) (#998).
  loudness: {
    targetLufs: -14,
    maxBoostDb: 6,
    source: 'replaygain-then-measured' as LoudnessSource,
  },
  weather: {
    // The ONLY location data Open-Meteo sees, and the only kind that never
    // reaches a prompt, a listener, or a public response.
    lat: 30.7333,
    lng: 76.7794,
    // Operator-facing label for those coordinates. Never spoken, never published.
    locationName: 'Punjab',
    // Where the station CLAIMS to broadcast from: the prompt's {location}, and
    // `location` in GET /dj + /now-playing. Blank falls back to locationName.
    // Lets an operator name a broad area while the weather reads exact
    // coordinates — a public station URL shouldn't be able to dox its operator.
    onAirLocation: '',
    units: 'metric' as 'metric' | 'imperial',
  },
  // The operator's station name (the product is still SUB/WAVE). Substituted into
  // the prompt's {station} and returned by GET /dj.
  station: 'SUB/WAVE',
  // Blurb for link previews (og:description et al). Deliberately NOT the on-air
  // persona's tagline — that changes with the hour, so a shared link would
  // describe itself differently depending on when it was opened (#1086). Empty =
  // unset, and the web app falls back to the tagline. Never enters the DJ prompt.
  stationDescription: '',
  // IANA zone driving everything with local-time semantics (time-of-day moods,
  // schedule slots, hourly checks, festival dates). Empty = the container's TZ.
  // Applied live via time.ts setStationTimezone().
  timezone: '',
  // Display copy / time formatting only; en-US switches visible clocks to AM/PM
  // without changing schedule or time-of-day semantics.
  locale: 'en-GB' as 'en-GB' | 'en-US',
  // Station-wide palette. Stored as an id only — the token map lives with the
  // theme registry (controller/src/themes.ts + ${STATE_DIR}/themes/) so it stays
  // in sync with the file on disk.
  theme: { active: DEFAULT_THEME_ID },
  // Mood-forming dates the DJ leans into. Falls back to FESTIVAL_DEFAULTS when
  // empty/absent.
  festivals: FESTIVAL_DEFAULTS,
  // Operator-editable mood system (/admin/moods): the vocabulary + per-mood CLAP
  // prompt, the day-period → mood map, and the weather-condition → mood map
  // ('' = no steer). Read live via moodVocab()/moodScheduleFor()/weatherMoodFor().
  moods: MOOD_DEFAULTS,
  moodSchedule: PERIOD_MOOD_DEFAULTS,
  weatherMoods: WEATHER_MOOD_DEFAULTS,
  // Presentational player toggles, read via GET /state and applied live.
  // `boothBuddy` gates the DJ-line mascot. `skin` is a slug only — the web app
  // owns the registry and falls back on an unknown id, so nothing validates it
  // here. `tuneInOverlay` gates the full-bleed tune-in gate; off drops the
  // takeover and listeners start via the skin's own play button.
  ui: { boothBuddy: false, skin: 'classic', tuneInOverlay: true },
  // Two independent locks over ONE shared password (#478). `privatePlayer` gates
  // the public web pages — UI-level, applies live. `listenerAuth` puts Icecast
  // listener auth on every mount via URL auth calling back into
  // POST /listener-auth, so toggling it re-renders icecast.xml and needs a mixer
  // restart; password changes apply live. Either lock on requires a password —
  // see update().
  //
  // `publishPersonaSouls` is NOT a lock and takes no part in that password rule.
  // It governs disclosure on the roster-wide public reads (/schedule's persona
  // index, GET /personas). A soul is the persona's system prompt, not a bio, so
  // handing over every one at once is opt-in. GET /dj is deliberately unaffected:
  // it has always published the ON-AIR soul, one at a time.
  privacy: { privatePlayer: false, listenerAuth: false, password: '', publishPersonaSouls: false },
  // Listener-request gates, all applied live. They bound the rate from several
  // angles at once: queue depth, requests/hour station-wide, per-track repeat
  // cooldown (0 = off), minimum gap between any two, and a single IP's share.
  requests: {
    enabled: true,
    maxPending: 6,
    globalHourlyCap: 30,
    repeatCooldownMin: 120,
    cooldownSec: 60,
    perIpHourlyCap: 8,
    onePendingPerIp: true,
  },
  // Global DJ prompt template; '' = DEFAULT_DJ_PROMPT_TEMPLATE. Always the
  // RESOLVED text of the active djPrompts entry, so renderDjPrompt (and an older
  // controller sharing the same settings.json) never has to chase the library.
  djPrompt: '',
  djPrompts: [],
  activeDjPromptId: '',
  // Per-station rules (TTS control tags, "spell out numbers", orthography)
  // appended to EVERY spoken-output prompt — renderDjPrompt, agentPersonaPreamble
  // and the multi-voice cast prompts (castHouseRulesBlock), none of which the
  // djPrompt template reaches (#1182, #1420).
  djHouseRules: '',
  // Station clock switch. false = the wall clock stays off air: no time of day
  // in links, idents, hand-overs, ad-libs, banter or programme beats, and the
  // automatic top-of-the-hour time check stands down. Daypart colour survives
  // ("after dark", "weekend", "late night", and the Period line) because that
  // is atmosphere rather than a clock reading. Manual /dj/segment triggers stay
  // exempt, so the operator's "Time check" pad still fires and still speaks the
  // time: off means "stop doing this unprompted". Policy lives in exactly one
  // place — broadcast/clock-policy.ts. Applies live; no restart.
  djSpeakClock: true,
  // One persona is active at a time; a scheduled show can override who is on air.
  personas: SEED_PERSONAS,
  activePersonaId: SEED_PERSONAS[0].id,
  shows: [],
  // 7-day x 24-hour grid of showId|null. An empty hour = run autonomously.
  schedule: emptyWeek(),
  // Timed takeover (#930): an epoch-ms window that outranks the weekly grid in
  // resolveActiveShow while live. Persisted in schedule.json.
  scheduleOverride: null,
  tts: {
    // Station-wide voice switch. false = music only: no links, idents, hourly
    // checks, segments, banter, mic-passes, programme beats or request intros —
    // and the scripts are never GENERATED, so an off station spends no tokens on
    // talk. Picks keep running and jingles keep playing (silence those with
    // jingleRatio: 0). Manual /dj/segment triggers stay exempt. Policy lives in
    // exactly one place: broadcast/voice-policy.ts.
    enabled: true,
    defaultEngine: 'piper',
    // Operator-chosen rescue voice — the TTS analogue of settings.llm.fallback.
    // Speaks when a persona's engine is known-unavailable up front or throws
    // mid-render. Unlike the hardcoded chain behind it (defaultEngine → piper →
    // kokoro) it carries a VOICE, not just an engine. Same {engine, voice,
    // cloudProvider} shape as a persona's tts block — audio/tts.ts hands it to
    // speakWith() as a synthetic persona.
    fallback: { enabled: false, engine: 'piper', voice: '', cloudProvider: 'openai' },
    // Advisory only: does the operator intend to run the tts-heavy sidecar?
    // Nothing branches on it — availability is read from isAvailable() at call
    // time. Both wizards write it so each surface knows the other's choice, and
    // the CLI uses it to decide whether to write COMPOSE_PROFILES.
    heavyEnabled: false,
    kokoro: { voice: 'bf_isabella', lang: '' },
    // Reference voice used when the engine resolves to chatterbox with no
    // persona-level voice. Empty = the model's built-in default.
    chatterbox: { referenceVoice: '' },
    // Built-in voice id used when the engine resolves to pocket-tts with no
    // persona-level voice.
    pocketTts: { voice: 'alba' },
    // Used when an engine resolves to 'cloud'. A persona chooses provider+voice;
    // `model` stays shared. `enabled: false` makes the engine report unavailable
    // regardless of key, so the pickers grey it out.
    cloud: {
      enabled: false,
      provider: 'openai',
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      // Legacy managed-provider inline key; new credentials live in secrets.env.
      apiKey: '',
      // Bearer for authenticated openai-compatible servers. Stays
      // provider-scoped even when personas use compat alongside a different
      // station-wide cloud provider.
      compatApiKey: '',
      // Includes the /v1 suffix. Required — and only used — when provider is
      // 'openai-compatible'.
      baseUrl: '',
      // ElevenLabs voice_settings, sent only for that provider. Ranges match
      // ElevenLabs' native ones; defaults mirror its UI so an unconfigured
      // install renders like the SDK's baseline (#696).
      voiceStability: 0.5,
      voiceStyle: 0,
      voiceSimilarityBoost: 0.75,
      voiceUseSpeakerBoost: true,
      // Fish Audio S2.1 controls. Persisted alongside the shared cloud config so
      // switching providers preserves the tuning, but sent only for fish-audio.
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
    // Per-provider inline API keys (#657). Only the inline-key providers
    // (openai-compatible, locca) populate this from the UI; env-var providers
    // keep their key in state/secrets.env. Namespacing by provider means
    // switching providers can never leave one provider's key where another reads.
    keys: {},
    // Empty → config.ollama.url. Only used when provider === 'ollama'.
    ollamaUrl: '',
    // Per-provider base URLs, so switching providers never overwrites another
    // provider's saved URL (#1082). `baseUrl` below is derived from this in
    // load()/applyLlmLegPatch() and kept only as a migration source.
    providerBaseUrls: {} as Record<string, string>,
    baseUrl: '',
    // Let reasoning models emit a chain-of-thought. Off by default: the DJ writes
    // short scripts and structured picks that don't benefit from it, and an
    // uncapped <think> block on a small model balloons every call.
    reasoning: false,
    // How the structured-output paths force a tool call. 'required' is the
    // reliable path for local models that ignore JSON mode. Switch to 'auto' ONLY
    // if your server crashes on tool_choice:"required" — recent vLLM implements it
    // via a guided-decoding backend some images mishandle (#570). On 'auto' the
    // done-tool path keeps its activeTools pinning, so a capable model still calls
    // the tool and misses fall back to the pool picker.
    toolChoice: 'required',
    // DISCOVERY rounds the DJ agent gets before it must commit (`done`).
    // 0 = follow the provider capability table (discoveryStepsFor()); 1–5 overrides.
    //
    // The override exists because the descriptor keys off the PROVIDER and can't
    // know which model it serves, and the two failure directions are opposite.
    // RAISE it when a capable model sits behind a forced-tool provider — one
    // cornered round plus an empty seed tool leaves it nothing to commit. LOWER it
    // when a cloud model wanders, or to cut tokens: every round is a separate
    // billable call against dailyTokenCap, and all rounds share one agentTimeoutMs.
    //
    // Raising it never buys extra attempts at `done` — the step cap is budget + 1,
    // so the run still commits once before handing off to recovery. The picker
    // prompt follows this number, so the model is told how many rounds it has.
    discoverySteps: 0,
    // Ollama num_ctx, local Ollama only. Ollama's own 4096 default silently
    // truncates the front of a ~8k+ picker prompt — dropping the system
    // instructions and tool defs — so the model never calls `done` (#291). 16384
    // holds a full turn on a 7–9B model / 12GB GPU; reasoning models need more.
    // 0 → don't send num_ctx. Ignored for `:cloud` models and other providers.
    numCtx: 16384,
    // Repetition penalty for local openai-compatible / locca servers. llama.cpp
    // defaults to 1.0 = OFF, which lets the tool-loop picker repeat a token block
    // until it hits the output cap and never calls `done`. Raise toward 1.25 if a
    // model still loops; 1.0 disables (e.g. a vLLM server that rejects the body
    // field). Injected into the request body — the AI SDK has no field for it —
    // and ignored by every other provider, Ollama included.
    repeatPenalty: 1.15,
    // On: the session DJ agent drives picks, links and requests as a tool-loop
    // over the session chat history. Off: the stateless pool picker runs instead,
    // still inside a session and still logged.
    pickerAgent: true,
    // The picker never re-airs any of the last N DISTINCT plays. Non-relaxable
    // (survives the filterPickerCandidates starvation cascade), which closes the
    // hole where a thin mood cluster let the cascade re-serve a just-played song.
    // Clamped to library size at use so a small catalogue never fully blocks; 0
    // disables. Listener requests are exempt. See music/recency.ts.
    noRepeatWindow: config.queue.noRepeatWindow,
    // Artist spacing, in slots: the agent path re-picks when its choice repeats
    // an artist from the last N slots, not just the one on air. Soft by design —
    // if the run surfaced nothing fresher the original pick stands, so this
    // never costs the station a slot. 0 leaves only the back-to-back guard,
    // which is always on. See broadcast/dj-agent/artist-guard.ts.
    artistVarietyWindow: ARTIST_VARIETY_WINDOW,
    // Gives the listener-request agent (never the per-track picker) an
    // `identifyRequestedTrack` tool that resolves a DESCRIBED track via web search
    // and matches it locally. Off by default: needs a search provider and costs a
    // web round-trip plus a small extraction call per use. No-op unless
    // searchReady().
    requestWebResolve: false,
    // Hard wall-clock ceiling on a single DJ-agent generation, enforced by
    // withDeadline. The main and recovery runs each get the full budget, so worst
    // case per pick is ~2x this before the stateless fallback. Reasoning-heavy
    // cloud models routinely need 20-40s.
    agentTimeoutMs: 45000,
    // Pause autonomous DJ LLM work and listener requests whenever Icecast reports
    // zero listeners — the stream coasts on the auto playlist.
    pauseWhenEmpty: false,
    // Daily token budget against bill-shock on a metered provider (the DJ calls
    // the model on essentially every transition, 24/7). 0 = unlimited. When set,
    // the day's UTC usage drives two tiers: at budgetSoftPct the DJ drops to the
    // cheap pool picker and mutes optional segments; at the cap it stops calling
    // the model entirely and coasts on the LLM-free auto playlist — music never
    // stops. Enforced in broadcast/dj-budget.ts.
    dailyTokenCap: 0,
    // Percent of dailyTokenCap that enters the soft tier. 0 or 100 disables it and
    // goes straight from normal to hard at the cap.
    budgetSoftPct: 80,
    // On: listener requests are still answered by the agent over the hard cap — a
    // human asked. Off: they fall through to the stateless matcher cascade. No
    // effect until dailyTokenCap is set.
    exemptRequests: true,
    // Per-call max OUTPUT tokens, distinct from the cumulative dailyTokenCap.
    // 0 = the strategy primitives' built-ins (4000 text / 8000 object / 8000
    // agent); a value (clamped 500–8000) overrides all three. The lever for a
    // local model on a small context window, where an 8000-token allowance can
    // crowd out the system prompt and risk truncation (#712).
    maxOutputTokens: 0,
    // Capture every outbound request body to ${STATE_DIR}/logs/llm-debug.log (last
    // 10, newest first) and stderr. LLM_DEBUG_RAW forces it on. The admin toggle
    // exists so no-CLI operators can flip it without editing env.
    debugRawRequests: false,
    // Optional backup LLM. When enabled, a call whose primary host is UNREACHABLE
    // (connection refused / DNS / timeout — not a 429/5xx from a host that's up)
    // retries once here, then routes straight back to the primary next call
    // (stateless fail-back). Built for "primary is a GPU box that's sometimes
    // powered off" (discussion #320). Station-level toggles (pickerAgent,
    // pauseWhenEmpty) are not per-leg, and heavy work (library tagging via
    // embeddings) does NOT fail over.
    fallback: {
      enabled: false,
      provider: 'ollama',
      model: '',
      apiKey: '',
      ollamaUrl: '',
      providerBaseUrls: {} as Record<string, string>,
      baseUrl: '',
      reasoning: false,
      toolChoice: 'required',
      numCtx: 16384,
      repeatPenalty: 1.15,
      // Per-leg like toolChoice/numCtx: the backup may be a different provider
      // running a different model, so it resolves its own budget.
      discoverySteps: 0,
    },
  },
  // Embedding-propagated library tagger (music/tag-library.ts): embed every
  // track's metadata text once, LLM-tag a small representative seed set, then
  // KNN-propagate moods/energy to the rest — ~10x fewer LLM calls than
  // brute-force batched tagging.
  //
  // `provider`/`model` default to following settings.llm. Anthropic has no
  // first-party embedding API, so Anthropic users need a different embedding
  // provider or an OPENAI_API_KEY for this leg.
  embedding: {
    enabled: true,
    provider: '',         // empty → follow settings.llm.provider
    model: '',            // empty → sensible default per provider
    // Embeddings often need a DIFFERENT endpoint than chat — one llama.cpp/locca
    // server can't serve both, so a dedicated embedding server runs on its own
    // port. Empty → inherit settings.llm's URL, which is only correct when the
    // chat server also does embeddings (e.g. Ollama). See #405, #1082.
    providerBaseUrls: {} as Record<string, string>,
    baseUrl: '',          // deprecated single slot — migration source only
    ollamaUrl: '',        // Ollama embedding server URL (ollama provider)
    apiKey: '',           // empty → inherit settings.llm.apiKey
    seedCount: 0,         // 0 → auto (autoSeedCount: ~4% of the library, 200–2500)
    // Confidence is topSim x coverage — a product of two sub-1 terms (see
    // tag-propagator.ts) — so the original 0.6 gates rejected even strong matches
    // and dumped the library into expensive active-learning. These only affect new
    // installs: loadWithDefaults prefers a stored value, so operators are never
    // silently overridden.
    knnNeighbours: 10,
    moodVoteThreshold: 0.4,
    confidenceThreshold: 0.35,
    maxActiveLearningRounds: 3,
    // CLAP audio fusion in mood propagation: tracks with a "sounds-like" vector
    // also pull neighbours from the audio-KNN space, scaled by this weight, before
    // the mood vote (tag-propagator.ts fuseNeighbours). Sound is the stronger mood
    // signal for instrumentals and thin-metadata tracks, and CLAP neighbours don't
    // cluster by album. 0 = text-only; 1 = trust audio as much as text.
    audioFusionWeight: 0.5,
    batchSize: 25,
    enrichment: {
      // Last.fm crowd tags. Tri-state: true = always fetch, false = never, null =
      // auto (only when a Last.fm api_key is configured).
      //
      // Tags come from the Last.fm REST API (artist.getTopTags), reusing the
      // scrobbling api_key. The older path went through Navidrome's
      // getArtistInfo2, where vanilla Navidrome's agent only surfaces bio +
      // images and tags always came back empty; it stays as the fallback when
      // forced on with no api_key, for custom Navidromes that DO expose tag[].
      lastfmTags: null as boolean | null,
      lyrics: true,       // fetch + include lyric excerpt in embed text
      // Resolve original release years for compilation tracks via MusicBrainz
      // (#842) — a compilation's `year` tag is the compilation's release date, so
      // era-bounded shows both mis-include and miss its tracks until each song's
      // true year is known. Keyless API (throttled to 1 req/s), so default-on.
      originalYear: true,
    },
  },
  // Web-search backend for the segment director's web-search capability.
  // `duckduckgo` needs no key; `tavily` and `brave` read SEARCH_API_KEY (or the
  // override here).
  search: {
    provider: 'duckduckgo',
    apiKey: '',
    baseUrl: '',
  },
  skills: {
    enabled: {},
  },
  audio: {
    // CLAP "sounds-like" embeddings — drive the audio-similar picker source, the
    // tracksThatSoundLikeThis tool and sonic journeys. Needs the CLAP stack in the
    // analysis backend; without it the request is a clean no-op and the pass still
    // fills bpm/key. ANALYZE_AUDIO_EMBEDDING=1 also enables it (env wins on,
    // never off) — as do the env flags on the two toggles below.
    embeddings: false,
    // Demucs vocal-activity ranges — drive content-aware talk timing and the
    // vocal-absence intro detector. Needs the demucs stack; expensive, so opt-in.
    // ANALYZE_VOCAL_ACTIVITY=1 also enables it.
    vocalActivity: false,
    // Keep the Demucs stems the analysis pass already computes (head + tail
    // windows) as FLAC under state/stems/<id>/, so a transition render is a fast
    // mix instead of a fresh separation. Needs the demucs stack like
    // vocalActivity; ~13-25 MB per track (#1257), LRU-swept to stemCacheGb.
    stemCache: false,
    stemCacheGb: 15,
    // Pause the analysis pass while anyone is listening, resuming once the stream
    // has been listener-free for analyzeQuietMinutes (#1099). Checked between
    // tracks inside runAnalysisPass, so it covers the tagger child, `npm run
    // analyze` and manual "Analyse now" runs alike — a pass outlives the click, so
    // the bypass is turning this off. ANALYZE_QUIET_ONLY=1 also enables it.
    analyzeQuietOnly: false,
    analyzeQuietMinutes: 10,
  },
  // Transition scheduling + stem-blend rendering (docs/stem-transitions-research.md).
  transitions: {
    // Hold each queued pick unsent until its successor is known (or the on-air
    // track nears its end), so its exit stamps — adaptive crossfade length, and
    // stem-blend clips — can be sized for the actual pair (#749). Kill-switch: off
    // reverts to the eager drain.
    pairDrain: true,
    // Needs pairDrain plus the heavy analyzer with a warmed stem cache.
    stemBlends: false,
  },
  // When disabled, the segment-director agent is never shown the effect
  // catalogue, so it stops garnishing spoken breaks with stingers. The files stay
  // on disk either way.
  sfx: {
    enabled: true,
  },
  // Beds — an instrumental between two songs for the DJ to talk over, so a long
  // link isn't talked over the song it's introducing (broadcast/beds.ts +
  // bed-policy.ts). Off by default: it needs a bed the operator is happy to hear
  // regularly, and a bed on EVERY link is morning-zoo radio. Controller-side only,
  // so toggling costs no mixer restart (unlike jingleRatio).
  beds: {
    enabled: false,
    // Front-pad a LISTENER REQUEST's intro with a bed instead of talking over
    // the song's opening, regardless of how short the intro is (#1465). Someone
    // asked for this track, so its first bars belong to them. On by default
    // WITHIN beds.enabled, which is itself off by default — so a fresh station
    // is unchanged, and a station already running beds gains this at upgrade.
    // That second half is a deliberate behaviour change, not an oversight.
    requestIntros: true,
    // Bed when the DJ's clip runs longer than this. Consulted ONLY where the
    // incoming track's vocal onset is unknown; a measured onset wins. See
    // bed-policy.rampBudgetMs. Requests ignore it — see requestIntros.
    thresholdSec: 12,
    // The bed's own exit crossfade — how long the next song takes to ramp in under
    // the DJ's closing words.
    crossSec: 6,
  },
  // Dead-air trim — cut near-silent runs off the head/tail of a track so a bad
  // rip's leading blank or a long mastering gap doesn't air as silence
  // (music/silence-trim.ts stamps liq_cue_in / liq_cue_out; radio.liq's
  // cue_cut does the cutting). OFF by default: it acts on a MEASUREMENT, and
  // an upgrade must sound byte-identical until the operator asks for this.
  // Controller-side only — no mixer restart.
  silenceTrim: {
    enabled: false,
    // Gaps shorter than this are left alone. A track legitimately opens a beat
    // after zero, and a segued album's inter-track space is deliberate; only a
    // gap the listener would call dead air is worth a cue point.
    minGapMs: 1500,
  },
  // Fire-and-forget station-event POSTs (event list in broadcast/webhooks.ts).
  webhooks: [] as Webhook[],
  webhooksPolicy: {
    // When true, track.play POSTs only when listener count > 0 (fail-closed on
    // null/unknown/non-finite, like scrobble).
    trackPlayListenerGated: false,
  },
  // Each backend is independent, paste-only (no OAuth), and gated on listener
  // count > 0 at scrobble time — a null/unknown count is treated as zero, i.e.
  // fail closed. Keys live here OR in state/secrets.env (env wins). `username` is
  // display-only.
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
      // For self-hosted LB-compatible scrobblers (e.g. Koito). Submit URL is
      // `${baseUrl}/submit-listens`. Env LISTENBRAINZ_API_URL wins.
      baseUrl: '',
    },
  },

  // The player heart button (#991). `starInNavidrome` mirrors each first like
  // into Navidrome via Subsonic star. `influenceDj` feeds the most-liked tracks
  // back to BOTH pick paths as a weighted preference — never a lock.
  likes: {
    enabled: true,
    starInNavidrome: true,
    influenceDj: false,
    maxTracks: 10,
    windowDays: 30, // 0 = all time
  },
};

export const BOUNDS = {
  // The keys converted to the shared schema (#1348) take their numbers from
  // schemas/settings.ts and re-export here: a mirrored module may not import a
  // non-mirrored one, so the schema has to own the constant.
  jingleRatio: { ...JINGLE_RATIO_BOUNDS, type: 'int' },
  crossfadeDuration: { ...CROSSFADE_DURATION_BOUNDS, type: 'float' },
  bedsThresholdSec: { ...BEDS_THRESHOLD_SEC_BOUNDS, type: 'float' },
  bedsCrossSec: { ...BEDS_CROSS_SEC_BOUNDS, type: 'float' },
  // Ceiling from the shared show schema: the strict show validator bounds-checks
  // a show's override against this station figure, so two copies would drift.
  maxTrackSeconds: { min: 0, max: SHOW_MAX_TRACK_SECONDS, type: 'int' },
  silenceTrimMinGapMs: { ...SILENCE_TRIM_MIN_GAP_MS_BOUNDS, type: 'int' },
  loudnessTargetLufs: { ...LOUDNESS_TARGET_LUFS_BOUNDS, type: 'float' },
  loudnessMaxBoostDb: { ...LOUDNESS_MAX_BOOST_DB_BOUNDS, type: 'float' },
};

export const MP3_BITRATE_SET = new Set<number>(MP3_BITRATES);
export const OPUS_BITRATE_SET = new Set<number>(OPUS_BITRATES);
export const AAC_BITRATE_SET = new Set<number>(AAC_BITRATES);

// True when the four ElevenLabs voice_settings knobs all sit at their shipped
// defaults, i.e. the operator never tuned them. cloud-speech then OMITS the
// voice_settings block so ElevenLabs defers to the voice's own VoiceLab-saved
// settings instead of having these literals forced onto every call (#915).
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

// Coerce a stored/per-show max-track-length to a clean integer SECOND count.
// `allowNull` distinguishes the two callers: the station default has no "unset"
// state (missing → 0 = off), whereas a per-show value uses null for "inherit the
// station default" (vs 0 = "unlimited override"). Clamps rather than throws —
// load() stays lenient.
export function coerceMaxTrackSeconds(raw: unknown, allowNull: boolean): number | null {
  if (raw == null || raw === '') return allowNull ? null : 0;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return allowNull ? null : 0;
  return Math.min(BOUNDS.maxTrackSeconds.max, Math.max(0, n));
}

// Back-compat: this cap was stored in MINUTES (`maxTrackMinutes`) before it moved
// to seconds. Returns the raw seconds value (leaving null/''/undefined untouched)
// for coerceMaxTrackSeconds to clamp.
export function rawMaxTrackSec(o: unknown): unknown {
  if (o == null) return o;
  const rec = o as Record<string, unknown>;
  if (rec.maxTrackSeconds != null && rec.maxTrackSeconds !== '') return rec.maxTrackSeconds;
  if (rec.maxTrackMinutes != null && rec.maxTrackMinutes !== '') return Number(rec.maxTrackMinutes) * 60;
  return rec.maxTrackSeconds;
}

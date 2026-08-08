// The shipped default settings object and the numeric bounds update() checks
// patches against, plus the few pure helpers that read them.
//
// Part of the settings/ split — see ../settings.ts for the public barrel.

import { config } from '../config.js';
import {
  BEDS_CROSS_SEC_BOUNDS,
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
  // Station-wide cap (seconds) on how long a single autonomously-picked track
  // may be — keeps hour-long album mixes and DJ sets out of normal rotation
  // (issue #447). 0 = no cap (default, unchanged behaviour). A scheduled show
  // can override this with its own `maxTrackSeconds` (0 there = "unlimited",
  // i.e. opt back out of the station cap for a long-form show). Listener
  // requests bypass the cap entirely — an explicit ask always plays.
  maxTrackSeconds: 0,
  // Hourly archive output. Off by default — the second MP3 encoder is the
  // largest constant CPU cost in the broadcast container, and most operators
  // don't use the archives, so they opt in via admin → Settings rather than
  // paying for the tape by default (issue #137). Dropping the bitrate (e.g.
  // 128 → 64 mono in a future change) also helps for operators who want it.
  // retentionDays: hourly recordings older than this many days are deleted by
  // the scheduler's hourly cleanup. Bounded by default — the old keep-forever
  // default (0) grew ~1.4 GB/day at 128 kbps until the disk filled, and
  // operators only noticed at 99 GB. The default must NOT reach installs that
  // already archive under keep-forever: normalizeArchiveRetentionDays keeps
  // them at 0 (see settings/normalize.ts), so upgrades never delete tapes.
  archive: { enabled: false, bitrate: 128, retentionDays: 30 },
  // Secondary Ogg-Opus broadcast mount (/stream.opus). Off by default — only
  // Blink (Chrome/Edge) clients ever select it (web/hooks/usePlayer.ts keeps
  // Safari/iOS/Firefox on MP3), and it adds a continuous Opus encoder + a
  // 44.1→48k resample, so operators opt in rather than pay that CPU unasked.
  // The mandatory /stream.mp3 mount always serves everyone.
  stream: {
    opusEnabled: false,
    opusBitrate: 96,
    flacEnabled: false,
    aacEnabled: false,
    aacBitrate: 192,
    bitrate: 192,
    // Seconds of already-broadcast audio Icecast bursts to a client on
    // connect (<burst-size>), so a cellular dead zone drains the buffer
    // instead of stalling (issue #993). Specified in SECONDS, not bytes:
    // burst-size is a byte count, so a fixed one silently stretches at low
    // bitrates — the old flat 512 KB was ~22s at 192k but ~66s at 64k. The
    // broadcast entrypoint converts this to bytes using stream.bitrate, so
    // the depth an operator picks is the depth every bitrate gets.
    //
    // This is also exactly how far behind the live edge every listener sits
    // for their whole connection, which is why /now-playing publishes it as
    // stream.bufferSeconds — players subtract it to line the now-playing
    // title and elapsed clock up with the audio actually in someone's ears
    // rather than the live edge (issue #1114).
    bufferSeconds: 22,
    // ICY (out-of-band) per-track titles on the Ogg mounts (/stream.opus +
    // /stream.flac). ON by default: most internet-radio clients (Ferrosonic,
    // Cast receivers, Symfonium) read the in-band Ogg comment only once at
    // connect and freeze on that title without ICY (issue #1052). foobar2000
    // is the known exception — it parses the in-band chained-Ogg tags
    // correctly, and the ICY channel on top breaks its Ogg-FLAC metadata — so
    // operators with fb2k listeners turn this off. Which camp a station's
    // listeners fall in is unknowable from here, hence a toggle rather than a
    // hardcoded value. MP3/AAC always use ICY and are unaffected.
    oggIcyMetadata: true,
    // Idle pause (broadcast/stream-idle.ts). When on, the controller flips
    // radio.liq's idle gate after idleAfterMinutes with zero Icecast
    // listeners: the mounts keep serving (silence), but the music chain
    // stops being pulled — no track decode, no Navidrome downloads — and
    // resumes mid-track within seconds of anyone connecting. Off by default:
    // a radio that plays to an empty room is the product's default fiction,
    // so going dark while unobserved is an explicit operator choice.
    idleWhenEmpty: false,
    idleAfterMinutes: 10,
  },
  // Per-track loudness normalisation (music/mix.ts gainForLoudness). targetLufs
  // is what every measured track is pulled toward; maxBoostDb caps the upward
  // direction only — cuts have a fixed wide clamp, and the boost is further
  // limited by the track's own measured peak headroom, so widening this on a
  // dynamic library won't slam the broadcast limiter. Read live per track at
  // annotate time; no mixer restart. `source` picks where the loudness figure
  // comes from (issue #998): embedded ReplayGain tags (whole-file stereo R128,
  // via Navidrome's OpenSubsonic replayGain field) vs the analyzer's measured
  // LUFS (leading window only). The default prefers the tag and falls back to
  // the measurement, so untagged libraries behave exactly as before.
  loudness: {
    targetLufs: -14,
    maxBoostDb: 6,
    source: 'replaygain-then-measured' as LoudnessSource,
  },
  weather: {
    // Precise point. The ONLY thing Open-Meteo sees, and the only location
    // data that never reaches a prompt, a listener, or a public response.
    lat: 30.7333,
    lng: 76.7794,
    // Operator-facing label for those coordinates — admin UI, /debug, CLI
    // status. Never spoken on air, never published. onAirLocation is what
    // listeners and the LLM get.
    locationName: 'Punjab',
    // The place the station CLAIMS to broadcast from: the DJ prompt's
    // {location}, and the `location` in GET /dj + GET /now-playing. Blank
    // falls back to locationName, so installs that never set it are
    // unchanged. Lets an operator name a broad area ("the Peak District")
    // while the weather still reads their exact coordinates — a station's
    // public URL shouldn't be able to dox its operator.
    onAirLocation: '',
    units: 'metric' as 'metric' | 'imperial',
  },
  // Operator-facing station name. Substituted into the DJ prompt's {station}
  // placeholder and returned by GET /dj for the landing page. The product is
  // still called SUB/WAVE — this is what the operator's station running on it
  // is called (e.g. "Frequency 88", "Late Shift Radio").
  station: 'SUB/WAVE',
  // Station-level blurb for link previews (og:description, twitter:description,
  // meta description). Deliberately NOT the on-air persona's tagline: that
  // changes with whoever is on air, so a shared station link would describe
  // itself differently depending on the hour (issue #1086). Empty = unset, and
  // the web app falls back to the persona tagline, preserving the behaviour of
  // installs that predate this field. Never enters the DJ prompt.
  stationDescription: '',
  // Station clock — IANA zone driving everything with local-time semantics
  // (time-of-day moods, schedule slots, hourly time checks, festival dates).
  // Empty = Auto: the container's own TZ, so existing installs are untouched.
  // Applied live via time.ts setStationTimezone(); no restart.
  timezone: '',
  // Operator-facing locale for display copy/time formatting. Defaults to the
  // existing UK English + 24-hour clock behaviour; en-US switches visible
  // clocks to AM/PM without changing schedule/time-of-day semantics.
  locale: 'en-GB' as 'en-GB' | 'en-US',
  // Station-wide visual theme — every listener and the admin UI render with
  // this palette. The id resolves through controller/src/themes.ts, which
  // ships the built-ins and reads optional user JSONs from
  // ${STATE_DIR}/themes/. Stored as id only; the actual token map lives with
  // the theme registry so it stays in sync with the file on disk.
  theme: { active: DEFAULT_THEME_ID },
  // Festival calendar — mood-forming dates the DJ leans into. Persisted here
  // so operators can add/edit/remove entries from the admin UI. Fall back to
  // FESTIVAL_DEFAULTS when empty/absent.
  festivals: FESTIVAL_DEFAULTS,
  // Operator-editable mood system (/admin/moods). `moods` is the vocabulary +
  // per-mood CLAP prompt; `moodSchedule` maps each fixed day-period to a mood;
  // `weatherMoods` maps each fixed weather condition to a mood ('' = no steer).
  // All read live via the moodVocab()/moodScheduleFor()/weatherMoodFor()
  // accessors. Seeded here; the operator's edits replace them.
  moods: MOOD_DEFAULTS,
  moodSchedule: PERIOD_MOOD_DEFAULTS,
  weatherMoods: WEATHER_MOOD_DEFAULTS,
  // Listener-player UI toggles — purely presentational, station-wide. The web
  // player reads these via GET /state (alongside the theme) and applies them
  // live; no restart. `boothBuddy` gates the DJ-line mascot — OFF by default,
  // so the line shows the classic ♪/◇ marker until an operator opts in.
  // `skin` is the station-wide player-skin id — the web app owns the skin
  // registry and falls back to its default on an unknown id, so the
  // controller only stores a slug, never validates against a list.
  // `tuneInOverlay` gates the full-bleed "Tap to tune in" gate — ON by default;
  // OFF drops the takeover and listeners start via the skin's own play button
  // (browsers still can't autoplay, so a tap is always required somewhere).
  ui: { boothBuddy: false, skin: 'classic', tuneInOverlay: true },
  // Private-station controls (issue #478). Two independent locks over ONE
  // shared `password`. `privatePlayer` gates the public web pages behind a
  // password prompt — UI-level only, applies live. `listenerAuth` puts
  // Icecast listener auth on every stream mount via URL auth calling back
  // into POST /listener-auth; no per-user accounts (Icecast can only do basic
  // auth). Toggling listenerAuth re-renders icecast.xml, so it needs a mixer
  // restart; password changes apply live (the controller validates every
  // connect). Either lock being on requires a password — see update().
  // `publishPersonaSouls` is NOT a lock and takes no part in the password rule
  // above — it governs DISCLOSURE on the roster-wide public reads (/schedule's
  // persona index, GET /personas). A soul is the persona's system prompt, not a
  // bio: operators write it assuming it stays backstage, so publishing every
  // one of them is opt-in and OFF by default (an upgrade changes nothing).
  // GET /dj is deliberately unaffected — it has always published the ON-AIR
  // persona's soul, one at a time, and removing that would break existing
  // public clients. This toggle is about handing over the whole roster at once.
  privacy: { privatePlayer: false, listenerAuth: false, password: '', publishPersonaSouls: false },
  // Listener-request pipeline gates (request-system hardening, 2026-07-28).
  // `enabled` is the master on/off for POST /request. The rest bound the
  // request rate from a few angles at once: `maxPending` caps the queue depth
  // regardless of source, `globalHourlyCap` bounds total requests/hour across
  // all listeners, `repeatCooldownMin` blocks the same track being
  // re-requested too soon (0 = off), `cooldownSec` is the minimum gap between
  // any two requests, and `perIpHourlyCap`/`onePendingPerIp` bound a single
  // IP's share. Every field applies live — no restart.
  requests: {
    enabled: true,
    maxPending: 6,
    globalHourlyCap: 30,
    repeatCooldownMin: 120,
    cooldownSec: 60,
    perIpHourlyCap: 8,
    onePendingPerIp: true,
  },
  // Global DJ prompt template. '' means "use DEFAULT_DJ_PROMPT_TEMPLATE".
  // Always the RESOLVED text of the active djPrompts entry — kept so
  // renderDjPrompt() (and an older controller sharing the same settings.json)
  // never has to chase the library.
  djPrompt: '',
  // Saved prompt-template library + which entry is active ('' = built-in
  // default). Switching templates just moves activeDjPromptId.
  djPrompts: [],
  activeDjPromptId: '',
  // Station house rules — per-station rules (TTS control tags, "spell out
  // numbers", locale orthography) appended to EVERY spoken-output prompt:
  // both the scripted-talk path (renderDjPrompt) and the agent paths
  // (agentPersonaPreamble), which the djPrompt template never reaches
  // (issue #1182). '' = off; default installs stay byte-identical.
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
  // The persona roster. One persona is "active" at a time (activePersonaId);
  // a scheduled show can override which persona is on-air for its hour.
  personas: SEED_PERSONAS,
  activePersonaId: SEED_PERSONAS[0].id,
  // Reusable show definitions, placed into the weekly schedule grid.
  shows: [],
  // 7-day x 24-hour grid of showId|null. An empty hour = run autonomously.
  schedule: emptyWeek(),
  // Timed takeover (#930): { showId, startedAt, expiresAt } epoch-ms window
  // that outranks the weekly grid in resolveActiveShow while it's live.
  // null = no takeover. Persisted in schedule.json alongside shows/schedule.
  scheduleOverride: null,
  tts: {
    // Station-wide voice switch. false = music only: the DJ never speaks — no
    // links, idents, hourly checks, segments, banter, mic-passes, programme
    // beats or listener-request intros — and, crucially, the scripts for those
    // are never GENERATED, so an off station spends no LLM tokens on talk.
    // Picks keep running (the stream needs a next track) and jingles keep
    // playing (pre-rendered WAVs on Liquidsoap's own rotate — silence those
    // with jingleRatio: 0). Manual /dj/segment triggers stay exempt: an
    // explicit operator action always fires. Policy lives in exactly one
    // place — broadcast/voice-policy.ts. Applies live; no restart.
    enabled: true,
    defaultEngine: 'piper',
    // Operator-chosen rescue voice — the TTS analogue of settings.llm.fallback.
    // When a persona's engine is known-unavailable up front, or throws
    // mid-render, this slot speaks instead: engine AND voice, where the
    // hardcoded chain behind it (defaultEngine → piper → kokoro) only ever
    // chose an engine and spoke with whatever global default it carried.
    // `enabled: false` (and an absent block, which normalises to this) keeps
    // the pre-fallback behaviour byte-for-byte. Same {engine, voice,
    // cloudProvider} shape as a persona's own tts block — deliberately, since
    // audio/tts.ts hands it to speakWith() as a synthetic persona.
    fallback: { enabled: false, engine: 'piper', voice: '', cloudProvider: 'openai' },
    // Advisory flag — does the operator intend to run the optional tts-heavy
    // sidecar (Chatterbox + PocketTTS)? Both setup wizards (CLI + /onboarding)
    // write to this so each surface knows the other's choice. Nothing in the
    // controller branches on it — engine availability is still read from
    // chatterbox.isAvailable() / pocketTts.isAvailable() at call time, which
    // is the source of truth. This is purely for the UI to show consistent
    // state and for the CLI to know whether to write COMPOSE_PROFILES.
    heavyEnabled: false,
    kokoro: { voice: 'bf_isabella', lang: '' },
    // Global Chatterbox fallback — used as the reference voice when the
    // engine resolves to chatterbox but no persona-level voice is set.
    // Empty filename means "use the model's built-in default voice".
    chatterbox: { referenceVoice: '' },
    // Global PocketTTS default voice — used when the engine resolves to
    // pocket-tts but no persona-level voice is set. Built-in voice id.
    pocketTts: { voice: 'alba' },
    // Cloud engine config — used when an engine resolves to 'cloud'. A persona
    // chooses provider+voice; `model` stays shared here. Managed credentials
    // use provider env vars; authenticated compatibility servers use the
    // dedicated `compatApiKey` slot below.
    // `enabled` is the operator's "Off" switch — when false the cloud engine
    // reports unavailable regardless of key, so the engine pickers grey it out.
    cloud: {
      enabled: false,
      provider: 'openai',
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      // Legacy managed-provider inline key. New managed credentials live in
      // secrets.env; retained for backward compatibility with older settings.
      apiKey: '',
      // Dedicated bearer for authenticated openai-compatible TTS servers. It
      // remains provider-scoped even when personas use compat alongside a
      // different station-wide Cloud provider.
      compatApiKey: '',
      // Base URL for the openai-compatible provider, including the /v1 suffix
      // (e.g. http://192.168.1.101:5000/v1). Required — and only used — when
      // provider === 'openai-compatible'.
      baseUrl: '',
      // ElevenLabs voice_settings. Applied ONLY when provider is 'elevenlabs';
      // ignored (and never sent) for openai / openai-compatible. All four match
      // ElevenLabs' native ranges: stability, style, similarity_boost ∈ [0,1],
      // use_speaker_boost is a bool. Defaults mirror ElevenLabs' UI defaults so
      // an unconfigured install renders exactly like the SDK's own baseline
      // (issue #696).
      voiceStability: 0.5,
      voiceStyle: 0,
      voiceSimilarityBoost: 0.75,
      voiceUseSpeakerBoost: true,
      // Fish Audio S2.1 synthesis controls. Persisted alongside the shared
      // cloud config so switching providers preserves the operator's tuning,
      // but sent only when provider === 'fish-audio'.
      temperature: 0.7,
      topP: 0.7,
      latency: 'normal' as 'low' | 'normal' | 'balanced',
      // Free-form extra body fields for openai-compatible servers (issue
      // #1317) — Chatterbox's temperature/seed/exaggeration, and whatever the
      // next self-hosted engine invents. Stored as text pairs and coerced to
      // JSON types at send time; sent ONLY when provider ===
      // 'openai-compatible'. Empty = today's request shape, byte for byte.
      // Rules live in settings/compat-params.ts.
      compatParams: [] as { key: string; value: string }[],
    },
    // Remote engine — a user-configured self-hosted TTS endpoint that renders
    // audio over HTTP (POST /speak → audio body, gated on a /health probe).
    // The TTS equivalent of the LLM's custom base URL. Empty → engine reports
    // unavailable; the dispatcher falls back.
    remote: { url: '' },
    // Per-engine voice level trim (dB), applied via Liquidsoap's liq_amplify on
    // every spoken segment that resolves to that engine. Levels the loudness gap
    // between engines (e.g. boost PocketTTS to match raw Piper). Stacks with each
    // persona's own tts.gainDb. All 0 = unity = today's behaviour. See
    // TTS_GAIN_CLAMP_DB and audio/tts.ts:voiceGainDb().
    gainDb: { piper: 0, kokoro: 0, chatterbox: 0, 'pocket-tts': 0, cloud: 0, remote: 0 },
    // Per-engine speech-rate multiplier (0.5–2.0×, 1.0 = no change), composed
    // on top of the daypart energy and each persona's own tts.speed in
    // audio/tts.ts:speak(). Only Piper/Kokoro/cloud honour it; chatterbox/
    // pocket-tts/remote ignore speed so their entries are inert. See clampTtsSpeed().
    speed: { piper: 1, kokoro: 1, chatterbox: 1, 'pocket-tts': 1, cloud: 1, remote: 1 },
    // Operator speech corrections — find→replace pairs applied to every
    // booth-bound line before any TTS engine sees it (audio/speech-text.ts).
    // Each entry: { from: 'GHz', to: 'gigahertz' }. Empty by default.
    corrections: [],
  },
  llm: {
    provider: 'ollama',
    model: '',
    // Legacy single inline-key slot. Superseded by `keys` (per-provider) — kept
    // only so an old settings.json migrates cleanly. Always '' after load();
    // resolution reads `keys`, never this. See llmKeyFor() / normalizeLlmKeys().
    apiKey: '',
    // Per-provider inline API keys, keyed by provider id (issue #657). Only the
    // inline-key providers (openai-compatible, locca) ever populate this from the
    // UI — env-var providers (openrouter, anthropic, …) keep their key in
    // state/secrets.env. Namespacing by provider means switching providers can
    // never leave one provider's key in the slot another provider then reads.
    keys: {},
    // Ollama server URL. Empty → fall back to config.ollama.url. Only used
    // when provider === 'ollama'.
    ollamaUrl: '',
    // Per-provider server base URLs. Keyed by provider id so switching providers
    // never overwrites another provider's saved URL (issue #1082). Replaces the
    // legacy single `baseUrl` field; at runtime `baseUrl` is derived from this map
    // in load()/applyLlmLegPatch(). The legacy field is kept as a migration source
    // on load only — it is never written after the first save with the new schema.
    providerBaseUrls: {} as Record<string, string>,
    // Deprecated single slot — kept so an old settings.json migrates cleanly.
    // Always derived from `providerBaseUrls` after load(). See
    // normalizeLlmProviderBaseUrls().
    baseUrl: '',
    // Whether to let reasoning ("thinking") models emit a chain-of-thought
    // before the answer. Off by default: the DJ writes short scripts and
    // structured picks that don't benefit from reasoning, and an uncapped
    // <think> block on a small model balloons every call (see llm/sdk.js
    // token caps + llm/provider.js no-think fetch).
    reasoning: false,
    // How SUB/WAVE forces a tool call in the structured-output paths (the emit /
    // done-tool harness). 'required' (default) makes the model call the tool —
    // the reliable path for local models that ignore JSON mode. Switch to 'auto'
    // ONLY if your server crashes on tool_choice:"required": recent vLLM
    // implements it via a guided-decoding backend that some images (newer
    // Intel/XPU builds) mishandle, while "auto" never engages it (issue #570).
    // On 'auto' the done-tool path keeps its activeTools pinning + instructions,
    // so a capable model still calls the tool; misses fall back to the pool
    // picker. Leave on 'required' unless you hit that crash.
    toolChoice: 'required',
    // How many DISCOVERY rounds the DJ agent gets before it must commit its pick
    // (`done`). 0 (the default) follows the provider capability table — 1 for
    // the forced-tool providers (ollama, openai-compatible, locca), 3 for the
    // rest; see discoveryStepsFor() in llm/internal/provider/capabilities.ts.
    // Set 1–5 to override.
    //
    // The override exists because the descriptor keys off the PROVIDER and can't
    // know which model that provider is serving, and the two failure directions
    // are opposite. RAISE it (2–3) when a capable model sits behind a
    // forced-tool provider — a good local model on llama.cpp/vLLM gets one
    // cornered round it doesn't need, and a seed tool that comes back empty then
    // leaves it with nothing to commit. LOWER it to 1 when a cloud model wanders
    // across its three rounds, or simply to cut tokens: every extra round is a
    // separate billable call counting against dailyTokenCap, and all rounds share
    // the one agentTimeoutMs deadline with the recovery legs behind them.
    //
    // Raising it never buys extra attempts at `done` — the step cap is derived
    // as budget + 1, so the run still commits once and then hands off to the
    // recovery cascade. The picker prompt follows this number too, so the model
    // is told how many rounds it actually has.
    discoverySteps: 0,
    // Ollama context window (num_ctx), local Ollama only. Ollama's own default
    // is 4096, but the session DJ agent feeds ~8k+ (the 40-turn session window
    // + tool schemas + discovery results), so the default silently truncates
    // the front of the prompt — dropping the system instructions and tool
    // defs — and the model never calls `done` ("agent did not call the done
    // tool", issue #291). 16384 holds a full picker turn comfortably on a 7–9B
    // model / 12GB GPU. Reasoning models burn more of it on <think>, so bump it
    // if you run those. Ignored for `:cloud` models and every other provider
    // (they manage their own context). 0 → don't send num_ctx (Ollama default).
    numCtx: 16384,
    // Repetition penalty for local openai-compatible / locca servers (llama.cpp,
    // vLLM, LM Studio). llama.cpp's own default is 1.0 = OFF, which lets the
    // tool-loop picker run away repeating a token block until it hits the output
    // cap and never calls `done`. 1.15 is a sane floor; raise toward 1.25 if a
    // model still loops, or set 1.0 to disable (e.g. a vLLM server that rejects
    // the `repeat_penalty` body field). Injected into the request body — the AI
    // SDK's openai provider has no field for it. Ignored by every other provider
    // (incl. Ollama: ai-sdk-ollama v4 has no per-call repeat_penalty channel).
    repeatPenalty: 1.15,
    // When on, the session DJ agent drives track-picking, links and listener
    // requests as a tool-loop over the session chat history (broadcast/
    // dj-agent.js). When off, the stateless pool picker runs instead — still
    // inside a session, still logged, just without the conversational loop.
    pickerAgent: true,
    // Count-based hard no-repeat window: the picker never re-airs any of the
    // last N DISTINCT plays. Non-relaxable (survives the filterPickerCandidates
    // starvation cascade), so it closes the hole where a thin mood cluster let
    // the cascade re-serve a just-played song. Clamped to library size at use
    // (effectiveNoRepeatWindow) so a small catalogue never fully blocks; 0
    // disables. Seeded from config.queue.noRepeatWindow (env NO_REPEAT_WINDOW);
    // listener requests stay exempt. See music/recency.ts + broadcast/queue.ts.
    noRepeatWindow: config.queue.noRepeatWindow,
    // When on, the listener-request agent (djAgentRequest only — never the
    // per-track picker) gets an extra `identifyRequestedTrack` tool that resolves
    // a DESCRIBED track ("the song from the new Dune movie") via web search, then
    // matches it against the local library. Off by default: it needs a web-search
    // provider (settings.search) and costs a web round-trip + a small extraction
    // call per use. No-op unless searchReady() — see llm/internal/tools/picker/tools/identify-requested-track.ts.
    requestWebResolve: false,
    // Hard wall-clock ceiling (ms) on a single DJ-agent generation (track
    // picks and listener requests). Enforced by withDeadline in llm/sdk.ts;
    // the main and recovery runs each get the full budget, so worst case per
    // pick is ~2× this before the stateless fallback takes over. Raise it for
    // slow models (reasoning-heavy cloud models routinely need 20-40s per
    // pick); lower it if you want snappier fallbacks.
    agentTimeoutMs: 45000,
    // When on, autonomous DJ LLM work (track picks, links, station IDs,
    // hourly checks, segments) and listener requests pause whenever Icecast
    // reports zero listeners — the stream coasts on the auto playlist — and
    // resume as soon as someone tunes in. Off by default.
    pauseWhenEmpty: false,
    // Daily LLM token budget — a safety net against bill-shock on a metered
    // provider (the DJ calls the model on essentially every track transition,
    // 24/7). 0 = unlimited (the default — most installs run free local Ollama
    // and must be unaffected). When set, the day's token usage (UTC, summed
    // from the same usage stats as the lifetime ticker) drives a two-tier
    // degradation: at `budgetSoftPct` of the cap the DJ drops to the cheap pool
    // picker and mutes optional segments (links, station IDs, hourly, weather/
    // news/etc.); at the cap it stops calling the model entirely and the stream
    // coasts on the LLM-free auto playlist — music never stops. Enforced in
    // broadcast/dj-budget.ts; see llm/internal/core/pure.ts `budgetMode`.
    dailyTokenCap: 0,
    // When the day's usage crosses this percent of dailyTokenCap, enter the
    // "soft" tier (cheap picker, no optional segments). 0 or 100 disables the
    // soft tier and goes straight from normal to hard at the cap.
    budgetSoftPct: 80,
    // When on (the default), listener requests are still answered by the agent
    // even over the hard cap — a human asked, so honour it. When off, requests
    // over the cap fall through to the stateless matcher cascade like every
    // other LLM path. No effect until dailyTokenCap is set.
    exemptRequests: true,
    // Per-call max OUTPUT tokens — distinct from dailyTokenCap (a cumulative
    // daily budget). This caps the size of each individual model response. The
    // strategy primitives default to generous built-ins (4000 text / 8000
    // object / 8000 agent); 0 = use those defaults. Set a value (clamped
    // 500–8000) to override all three — the lever for a local model on a small
    // context window, where an 8000-token response allowance can crowd out the
    // system prompt / tool listing and risk truncation, and is pure waste with
    // reasoning off. Resolved via resolveMaxOutputTokens(); see issue #712.
    maxOutputTokens: 0,
    // When on (or when LLM_DEBUG_RAW is set in the env), every outbound model
    // request's exact body is captured to ${STATE_DIR}/logs/llm-debug.log (the
    // last 10, newest first) and dumped to stderr — a copy-pasteable view of
    // exactly what SUB/WAVE sends the provider, for debugging odd model
    // behaviour. The admin toggle (admin → Debug) means no-CLI operators can
    // flip it without editing env; the env flag can only force it on. Off by
    // default: zero file writes / overhead when disabled.
    debugRawRequests: false,
    // Optional backup LLM. When `enabled`, any LLM call whose primary host is
    // unreachable (connection refused / DNS / timeout — NOT a 429/5xx from a
    // host that's up) is retried once against this leg, then routed straight
    // back to the primary on the next call (stateless fail-back). Built for the
    // "primary is a GPU box that's sometimes powered off, backup is the
    // always-on server running a smaller model" case (discussion #320). Same
    // connection fields as the primary; the station-level toggles (pickerAgent,
    // pauseWhenEmpty) are not per-leg. Heavy work (library tagging via
    // embeddings) does NOT fail over — it stays on the primary.
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
      // Per-leg like toolChoice/numCtx above: the backup may be a different
      // provider running a different model, so it resolves its own budget.
      discoverySteps: 0,
    },
  },
  // Embedding-propagated library tagger (music/tag-library.ts).
  //
  // The tagger embeds every track's metadata text once (free if Ollama-local,
  // ~$1 for 50k via OpenAI), LLM-tags a small representative seed set, then
  // KNN-propagates moods/energy to the rest. Cuts LLM call count ~10x vs.
  // brute-force batched tagging.
  //
  // `provider` and `model` default to following settings.llm; set them here
  // to use a different provider for embeddings than for chat. Anthropic has
  // no first-party embedding API — Anthropic users either set a different
  // embedding provider or set OPENAI_API_KEY for the embedding leg.
  embedding: {
    enabled: true,
    provider: '',         // empty → follow settings.llm.provider
    model: '',            // empty → sensible default per provider
    // Embeddings often need a DIFFERENT endpoint than chat: one llama.cpp /
    // locca server can't serve both chat and embeddings, so a dedicated
    // embedding server runs on its own port. Empty → inherit settings.llm's
    // baseUrl / ollamaUrl (fine only when the chat server also does embeddings,
    // e.g. Ollama). See issue #405.
    providerBaseUrls: {} as Record<string, string>, // per-provider embedding server URLs (issue #1082)
    baseUrl: '',          // deprecated single slot — migration source only, never written after first save
    ollamaUrl: '',        // Ollama embedding server URL (ollama provider)
    apiKey: '',           // empty -> inherit settings.llm.apiKey
    seedCount: 0,         // 0 → auto (see autoSeedCount in tag-library.ts: ~4% of
                          //   the library, floored 200 / capped 2500)
    // Propagation defaults. These were 5 / 0.6 / 0.6 and propagated almost
    // nothing: confidence is topSim×coverage (a product of two sub-1 terms — see
    // tag-propagator.ts), so a 0.6 gate rejected even strong matches and dumped
    // the library into expensive active-learning. Loosened so KNN propagation
    // actually carries the bulk of tagging. NOTE: only affects NEW installs / a
    // reset — an existing settings.json keeps its saved values (loadWithDefaults
    // below prefers a stored value), so operators are never silently overridden.
    knnNeighbours: 10,        // was 5 — a broader, more stable neighbour vote
    moodVoteThreshold: 0.4,   // was 0.6 — a mood carried by ~a third propagates
    confidenceThreshold: 0.35, // was 0.6 — see the topSim×coverage note above
    maxActiveLearningRounds: 3,
    // CLAP audio fusion in mood propagation: tracks with a "sounds-like"
    // audio vector also pull neighbours from the audio-KNN space, scaled by
    // this weight, before the mood vote (tag-propagator.ts fuseNeighbours).
    // Sound is the stronger mood signal for instrumentals / thin-metadata
    // tracks, and CLAP neighbours don't cluster by album. 0 = text-only
    // (today's behaviour); 1 = trust audio similarity as much as text. Only
    // bites where the acoustic analysis has produced audio vectors.
    audioFusionWeight: 0.5,
    batchSize: 25,
    enrichment: {
      // Last.fm crowd tags. Tri-state: true = always fetch, false = never,
      // null = auto (fetch only when a Last.fm api_key is configured — see
      // music/lastfm.ts + the gate in tag-library.ts phaseEnrich).
      //
      // Tags now come straight from the Last.fm REST API (artist.getTopTags)
      // reusing the scrobbling api_key, which actually returns tag[]. The old
      // path went through Navidrome's getArtistInfo2, where vanilla Navidrome's
      // agent only surfaces bio + images — never tag[] — so tags always came
      // back empty. That Navidrome path stays as the fallback when lastfmTags
      // is forced on (true) but no api_key is set (custom Navidromes that DO
      // expose tag[]). Default `null` avoids the wasted round trip for keyless
      // vanilla-Navidrome installs.
      lastfmTags: null as boolean | null,
      lyrics: true,       // fetch + include lyric excerpt in embed text
      // Resolve original release years for compilation-album tracks via
      // MusicBrainz (issue #842) — a compilation's `year` tag is the
      // compilation's own release date, so era-bounded shows both mis-include
      // and miss its tracks until each song's true year is known. Keyless API
      // (1 req/s, throttled in music/musicbrainz.ts), so default-on.
      originalYear: true,
    },
  },
  // Web-search backend for the segment director's web-search capability.
  // Default `duckduckgo` works out of the box with no key; `tavily` and
  // `brave` read their key from SEARCH_API_KEY (or the optional override
  // below). `apiKey` is only meaningful for the keyed providers.
  search: {
    provider: 'duckduckgo',
    apiKey: '',
    baseUrl: '',
  },
  skills: {
    enabled: {},
  },
  // Audio (CLAP) "sounds-like" embeddings — drive the audio-similar picker
  // source, the tracksThatSoundLikeThis tool and sonic journeys. When on, the
  // analysis pass asks the backend for an embedding per track; the backend
  // needs the CLAP stack (tts-heavy built with WITH_CLAP=1, or a local venv
  // with torch+transformers) — without it the request is a clean no-op and
  // the pass still fills bpm/key. ANALYZE_AUDIO_EMBEDDING=1 in the env also
  // enables it regardless of this toggle (env wins on, never off).
  audio: {
    embeddings: false,
    // Demucs vocal-activity ranges — drives content-aware talk timing and a
    // vocal-absence intro detector. When on, the analysis pass asks the backend
    // for vocal ranges per track; the backend needs the demucs stack (tts-heavy
    // built WITH_DEMUCS=1, or a local venv with torch+demucs) — without it the
    // request is a clean no-op. ANALYZE_VOCAL_ACTIVITY=1 also enables it
    // regardless of this toggle (env wins on, never off). Expensive — opt-in.
    vocalActivity: false,
    // Stem cache (feature: stem-blend transitions). When on, the analysis
    // pass keeps the Demucs stems it already computes (head + tail windows)
    // as FLAC under state/stems/<id>/ so transition renders are a fast mix
    // instead of a fresh separation. Needs the demucs stack like
    // vocalActivity; ~13-25 MB per track (field average ~13, #1257),
    // LRU-swept to stemCacheGb.
    stemCache: false,
    stemCacheGb: 15,
    // Quiet-times gate (#1099): pause the analysis pass while anyone is
    // listening, resuming once the stream has been listener-free for
    // analyzeQuietMinutes. Checked between tracks inside runAnalysisPass, so
    // it covers both the server-spawned tagger child and `npm run analyze`,
    // and applies to manual "Analyse now" runs too (a pass outlives the
    // click; the bypass is turning this off). ANALYZE_QUIET_ONLY=1 also
    // enables it (env wins on, never off), mirroring the toggles above.
    analyzeQuietOnly: false,
    analyzeQuietMinutes: 10,
  },
  // Transition scheduling + stem-blend rendering (docs/stem-transitions-research.md).
  transitions: {
    // Pair-aware drains (the #749 fix): hold each queued pick unsent until
    // its successor is known (or the on-air track nears its end), so its
    // exit stamps — adaptive crossfade length, and stem-blend clips when
    // enabled — can be sized for the actual pair. Kill-switch: off reverts
    // to the historical eager drain, byte-for-byte.
    pairDrain: true,
    // Pre-rendered stem-blend transitions (needs pairDrain + the heavy
    // analyzer with the stem cache warmed). Off by default — opt-in like
    // every heavy audio feature.
    stemBlends: false,
  },
  // Sound-effects library. When disabled, the segment-director agent is never
  // shown the effect catalogue, so it stops garnishing spoken breaks with
  // stingers. The library files themselves stay on disk either way.
  sfx: {
    enabled: true,
  },
  // Beds — an instrumental bed between two songs for the DJ to talk over, so a
  // long link isn't talked over the song it's introducing (broadcast/beds.ts +
  // broadcast/bed-policy.ts). Off by default: it needs a bed the operator is
  // happy to hear regularly, and a bed on EVERY link is morning-zoo radio.
  //
  // Controller-side only — no liquidsoap_*.txt, so toggling costs no mixer
  // restart, unlike jingleRatio.
  beds: {
    enabled: false,
    // Bed when the DJ's clip runs longer than this. Consulted ONLY where the
    // incoming track's vocal onset is unknown; where the analyzer measured
    // vocal ranges, the real onset wins and this is ignored. See
    // bed-policy.rampBudgetMs.
    thresholdSec: 12,
    // The bed's own exit crossfade — how long the next song takes to ramp in
    // under the DJ's closing words.
    crossSec: 6,
  },
  // Outbound webhooks. Each entry POSTs station events (see broadcast/
  // webhooks.ts for the event list) to `url` with a fire-and-forget HTTP
  // call. `track.play` can be listener-gated via webhooksPolicy (off by
  // default — see broadcast/queue.ts). Empty by default — operators add hooks
  // via the admin UI.
  webhooks: [] as Webhook[],
  webhooksPolicy: {
    // When true, track.play POSTs only when listener count > 0 (fail-closed on
    // null/unknown/non-finite, like scrobble). Default false = always send.
    trackPlayListenerGated: false,
  },
  // Station-wide scrobbling. Each backend is independent; both are paste-only
  // (no OAuth) and both are gated on listener count > 0 at scrobble time (a
  // null/unknown count is treated as zero — fail closed, see broadcast/
  // scrobble.ts). API keys/secrets/tokens live here OR in state/secrets.env
  // (env wins). `username` is display-only.
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
      // Optional override for self-hosted LB-compatible scrobblers (e.g. Koito).
      // Full submit URL is `${baseUrl}/submit-listens`. Env LISTENBRAINZ_API_URL wins.
      baseUrl: '',
    },
  },

  // Listener likes (#991) — the player heart button. `starInNavidrome` mirrors
  // each first like of a song into Navidrome via Subsonic star (any Subsonic
  // client sees it under Starred). `influenceDj` feeds the most-liked tracks
  // back to BOTH pick paths (agent prompt lean + pool picker source) as a
  // weighted preference signal — never a lock. Window/limit bound that signal.
  likes: {
    enabled: true,
    starInNavidrome: true,
    influenceDj: false,
    maxTracks: 10,
    windowDays: 30, // 0 = all time
  },
};

export const BOUNDS = {
  // The three keys converted to the shared schema (#1348) take their numbers
  // from schemas/settings.ts rather than declaring them here. A mirrored module
  // may not import a non-mirrored one, so the shared schema has to own the
  // constant and this re-exports it — the same rule that homed SHOW_ID_RE in
  // schemas/show.ts. The rationale for each figure moved with it.
  jingleRatio: { ...JINGLE_RATIO_BOUNDS, type: 'int' },
  crossfadeDuration: { ...CROSSFADE_DURATION_BOUNDS, type: 'float' },
  bedsThresholdSec: { ...BEDS_THRESHOLD_SEC_BOUNDS, type: 'float' },
  bedsCrossSec: { ...BEDS_CROSS_SEC_BOUNDS, type: 'float' },
  // 0 = off; 36000 s (10h) is a generous ceiling that still leaves room for
  // long-form mix shows without letting a typo set an absurd value.
  // Ceiling from the shared show schema: the strict show validator has always
  // bounds-checked a show's own override against this station figure, so two
  // copies of the number would drift.
  maxTrackSeconds: { min: 0, max: SHOW_MAX_TRACK_SECONDS, type: 'int' },
  loudnessTargetLufs: { ...LOUDNESS_TARGET_LUFS_BOUNDS, type: 'float' },
  loudnessMaxBoostDb: { ...LOUDNESS_MAX_BOOST_DB_BOUNDS, type: 'float' },
};

export const MP3_BITRATE_SET = new Set<number>(MP3_BITRATES);
export const OPUS_BITRATE_SET = new Set<number>(OPUS_BITRATES);
export const AAC_BITRATE_SET = new Set<number>(AAC_BITRATES);

// True when the four ElevenLabs voice_settings knobs (issue #696) all sit at
// their shipped defaults, i.e. the operator never tuned them. cloud-speech uses
// this to OMIT the voice_settings block in that case so ElevenLabs defers to the
// voice's own VoiceLab-saved settings, instead of forcing these literals onto
// every call (issue #915 review). Compared against DEFAULTS so there's a single
// source of truth for the default values.
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
// state (missing → 0 = off), whereas a per-show value uses null to mean "inherit
// the station default" (vs 0 = "unlimited override"). Out-of-band values clamp
// into [0, max] rather than throw — load() stays lenient.
export function coerceMaxTrackSeconds(raw: unknown, allowNull: boolean): number | null {
  if (raw == null || raw === '') return allowNull ? null : 0;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return allowNull ? null : 0;
  return Math.min(BOUNDS.maxTrackSeconds.max, Math.max(0, n));
}

// Back-compat: this cap was stored and sent in MINUTES (`maxTrackMinutes`) before
// it moved to seconds. Prefer the new `maxTrackSeconds` key; fall back to a legacy
// minutes value ×60 so an existing settings.json / show and any stale client keep
// working. Returns the raw seconds value (leaving null/''/undefined untouched) for
// coerceMaxTrackSeconds to clamp.
export function rawMaxTrackSec(o: unknown): unknown {
  if (o == null) return o;
  const rec = o as Record<string, unknown>;
  if (rec.maxTrackSeconds != null && rec.maxTrackSeconds !== '') return rec.maxTrackSeconds;
  if (rec.maxTrackMinutes != null && rec.maxTrackMinutes !== '') return Number(rec.maxTrackMinutes) * 60;
  return rec.maxTrackSeconds;
}


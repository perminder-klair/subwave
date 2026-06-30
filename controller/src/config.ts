// Centralised config — reads from env, with sensible defaults

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// The shared state directory — every file-based IPC channel lives under here.
// In Docker the compose files mount <repo>/state → /var/sub-wave and pass
// STATE_DIR=/var/sub-wave. Native dev (`npm run dev` from controller/) has no
// such mount, so it falls back to the repo-local state/ dir resolved relative
// to this file (controller/src/config.js → ../../state).
export const STATE_DIR = process.env.STATE_DIR
  || resolve(dirname(fileURLToPath(import.meta.url)), '../../state');

// Repo-bundled static audio (studio bed, emergency clip, default sound
// effects). In Docker the compose files mount <repo>/sounds → /sounds and
// pass SOUNDS_DIR=/sounds. Native dev falls back to the repo-local sounds/
// dir resolved relative to this file (controller/src/config.js → ../../sounds).
export const SOUNDS_DIR = process.env.SOUNDS_DIR
  || resolve(dirname(fileURLToPath(import.meta.url)), '../../sounds');

// TTS speech-rate multiplier: 1.0 = normal pace, lower = slower, higher =
// faster. TTS_SPEED is the cross-engine default; each engine can be tuned
// independently with its own var (PIPER_SPEED / KOKORO_SPEED / CLOUD_TTS_SPEED).
// The multiplier semantics are consistent everywhere — piper.js inverts it
// internally because Piper expresses rate as length_scale (higher = slower).
const TTS_SPEED = process.env.TTS_SPEED || '1.0';

// Shared directory for operator-uploaded reference WAVs. Both Chatterbox and
// PocketTTS read from here for zero-shot voice cloning. `TTS_VOICE_DIR` is the
// canonical override; `CHATTERBOX_VOICE_DIR` is honoured for back-compat with
// operators who pinned the old chatterbox-only path. The legacy folder
// (state/chatterbox-voices/) is still read at list/resolve time so pre-existing
// installs keep working without a manual file move.
const VOICES_DIR = process.env.TTS_VOICE_DIR
  || process.env.CHATTERBOX_VOICE_DIR
  || `${STATE_DIR}/voices`;
const LEGACY_VOICES_DIR = `${STATE_DIR}/chatterbox-voices`;

export const config = {
  // Absolute path to the shared state dir — modules build their own file
  // paths from this rather than hardcoding /var/sub-wave.
  stateDir: STATE_DIR,
  soundsDir: SOUNDS_DIR,
  navidrome: {
    url: process.env.NAVIDROME_URL || 'http://navidrome:4533',
    user: process.env.NAVIDROME_USER || '',
    password: process.env.NAVIDROME_PASS || '',
    apiVersion: '1.16.1',
    clientName: 'sub-wave',
  },
  ollama: {
    // Default-when-blank server URL + model. The admin Settings UI
    // (`llm.ollamaUrl` / `llm.model`) overrides both — there are no
    // OLLAMA_URL / OLLAMA_MODEL env vars; the UI fields are the only source.
    url: 'http://localhost:11434',
    model: 'nemotron-3-super:cloud',
  },
  piper: {
    binary: process.env.PIPER_BIN || '/usr/local/bin/piper',
    voice: process.env.PIPER_VOICE || '/opt/piper/voices/en_GB-alan-medium.onnx',
    voiceConfig: process.env.PIPER_VOICE_CONFIG || '/opt/piper/voices/en_GB-alan-medium.onnx.json',
    outDir: process.env.PIPER_OUT || `${STATE_DIR}/voice`,
    speed: parseFloat(process.env.PIPER_SPEED || TTS_SPEED),
  },
  // Acoustic analysis (bpm/key/intro) — runs librosa, which deliberately does
  // NOT live in the controller image. Two backends, resolved in music/
  // analyzer.ts: an analysis sidecar (production) or a local Python venv
  // (offline/dev — set ANALYZE_PYTHON to a venv with librosa installed). When
  // neither is reachable the analysis phase skips cleanly.
  analyzer: {
    // Ordered candidate base URLs for the analysis sidecar. ANALYZE_URL (the
    // dedicated `--profile analyzer` image) is tried first; TTS_HEAVY_URL second
    // so existing `--profile tts-heavy` installs (whose image still carries the
    // analyze worker) keep working with zero config. analyzer.ts probes each
    // /health in order and uses the first that reports the 'analyze' engine.
    urls: [process.env.ANALYZE_URL, process.env.TTS_HEAVY_URL].filter((u): u is string => !!u),
    python: process.env.ANALYZE_PYTHON || '',   // empty → no local backend
    workerScript: process.env.ANALYZE_WORKER || '/app/scripts/analyze_worker.py',
    // 60s is enough for stable BPM (beat_track) / key (chroma); intro
    // detection only needs the first ~20-30s. Env-overridable.
    seconds: parseFloat(process.env.ANALYZE_SECONDS || '60'),
    requestTimeoutMs: parseInt(process.env.ANALYZE_REQUEST_TIMEOUT_MS || '120000', 10),
  },
  kokoro: {
    python: process.env.KOKORO_PYTHON || '/opt/kokoro/venv/bin/python',
    workerScript: process.env.KOKORO_WORKER || '/app/scripts/kokoro_worker.py',
    model: process.env.KOKORO_MODEL || '/opt/kokoro/models/kokoro-v1.0.onnx',
    voices: process.env.KOKORO_VOICES || '/opt/kokoro/models/voices-v1.0.bin',
    voice: process.env.KOKORO_VOICE || 'bf_isabella',   // British female, BBC-ish
    lang: process.env.KOKORO_LANG || 'en-gb',
    speed: parseFloat(process.env.KOKORO_SPEED || TTS_SPEED),
  },
  // Chatterbox is opt-in: the default controller image does not bundle the
  // runtime. Build with `--build-arg WITH_CHATTERBOX=1` (see
  // docker/Dockerfile.controller) to create the venv + model at these paths.
  // chatterbox.isAvailable() does an existsSync on `python`, so when the image
  // was built without the arg the venv is absent and the dispatcher falls back
  // to Piper. The defaults below are the in-image locations; env vars override
  // them for non-default layouts (e.g. a host venv during native dev).
  chatterbox: {
    python: process.env.CHATTERBOX_PYTHON || '/opt/chatterbox/venv/bin/python',
    workerScript: process.env.CHATTERBOX_WORKER || '/app/scripts/chatterbox_worker.py',
    // 'cpu' or 'cuda'. CPU works but is slow; CUDA needs a GPU-enabled image.
    device: process.env.CHATTERBOX_DEVICE || 'cpu',
    // Directory where the operator drops per-persona reference WAVs. Each
    // persona stores a filename (relative to here) in its `tts.voice` field.
    // Shared with PocketTTS — see `voices` below.
    voiceDir: VOICES_DIR,
    // Global fallback reference WAV used when a persona has no voice set.
    // Empty → use Chatterbox's built-in default voice.
    referenceWav: process.env.CHATTERBOX_REFERENCE_WAV || '',
  },
  // PocketTTS is opt-in alongside Chatterbox — build with
  // `--build-arg WITH_POCKETTTS=1` (see docker/Dockerfile.controller) to
  // create the venv + warm the model at these paths. pocketTts.isAvailable()
  // does an existsSync on `python`, so an image built without the arg reports
  // unavailable and the dispatcher falls back to Piper. The 100M-param model
  // is small (~CPU-only) but the runtime drag of torch is the reason it's
  // opt-in rather than baked into the default image.
  pocketTts: {
    python: process.env.POCKET_TTS_PYTHON || '/opt/pocket-tts/venv/bin/python',
    workerScript: process.env.POCKET_TTS_WORKER || '/app/scripts/pocket_tts_worker.py',
    // Built-in voice id. Settings layer constrains the UI to a curated list
    // (POCKET_TTS_VOICES); anything else still passes through to the worker,
    // which falls back to the default when an id isn't recognised.
    defaultVoice: process.env.POCKET_TTS_VOICE || 'alba',
    // Shared with Chatterbox — see `voices` below. When a persona's voice
    // value matches a .wav filename in here, the worker switches to
    // reference-WAV cloning mode; built-in voice ids stay as-is.
    voiceDir: VOICES_DIR,
  },
  // Shared reference-WAV folder for Chatterbox + PocketTTS zero-shot cloning.
  // Operators drop .wav files into `dir`; both engines read it via
  // listReferenceVoices(). `legacyDir` is the pre-#213 chatterbox-only path
  // and is still scanned (with `dir` winning on filename clash) so existing
  // installs don't need a manual move.
  voices: {
    dir: VOICES_DIR,
    legacyDir: LEGACY_VOICES_DIR,
  },
  // Optional sidecar that hosts Chatterbox + PocketTTS over HTTP. Set
  // TTS_HEAVY_URL in the controller's environment and add the `tts-heavy`
  // profile to compose to enable it. Both audio/chatterbox.ts and
  // audio/pocketTts.ts prefer the sidecar when the URL is set, falling back
  // to the in-process WITH_*=1 build path when it isn't. See
  // docker/Dockerfile.tts-heavy + docker/tts-heavy/server.py for the service.
  ttsHeavy: {
    url: process.env.TTS_HEAVY_URL || '',
    // isAvailable() in remote mode caches the result of a /health probe and
    // re-runs it on this interval so a sidecar that comes up after the
    // controller is reflected without a restart, and one that goes down
    // flips to unavailable within ~30s (dispatcher then falls back to Piper).
    probeIntervalMs: parseInt(process.env.TTS_HEAVY_PROBE_MS || '30000', 10),
    // Per-request HTTP timeout. Inference itself is bounded by the engine
    // modules' own request timeouts (CHATTERBOX_REQUEST_TIMEOUT_MS,
    // POCKET_TTS_REQUEST_TIMEOUT_MS); this is the network/connect ceiling.
    requestTimeoutMs: parseInt(process.env.TTS_HEAVY_TIMEOUT_MS || '180000', 10),
  },
  icecast: {
    // Public status JSON — listener counts + per-mount metadata. No auth.
    // Icecast lives inside the merged `broadcast` container; its hostname on
    // the compose network is the service name.
    statusUrl: process.env.ICECAST_STATUS_URL || 'http://broadcast:7702/status-json.xsl',
    // Admin listclients endpoint — per-connection detail (IP, user-agent,
    // connected-for). Basic-auth gated; credentials resolved at call time from
    // ICECAST_ADMIN_PASSWORD or state/icecast-secrets.env (see listeners.ts).
    adminUrl: process.env.ICECAST_ADMIN_URL || 'http://broadcast:7702/admin/listclients',
    adminUser: process.env.ICECAST_ADMIN_USER || 'admin',
  },
  liquidsoap: {
    queueFile: `${STATE_DIR}/next.txt`,
    sayFile: `${STATE_DIR}/say.txt`,
    // Separate channel for talk-over voice (auto-links, anything that should
    // play OVER a track that's already started with light ducking instead of
    // heavy ducking the music to 25%). Read by a second poll thread in radio.liq.
    introFile: `${STATE_DIR}/intro.txt`,
    // On-demand sound-effect channel. The controller writes the path of a
    // pre-rendered SFX clip here; radio.liq's sfx_queue mixes it UNDER the
    // DJ voice (see broadcast/sfx.js + broadcast/queue.js playSfx).
    sfxFile: `${STATE_DIR}/sfx.txt`,
    autoPlaylist: `${STATE_DIR}/auto.m3u`,
    nowPlayingFile: `${STATE_DIR}/now-playing.json`,
  },
  session: {
    // The live DJ session — a chat-history JSON the controller rewrites as
    // tracks play and the DJ talks. Archived sessions land in `dir` on roll.
    currentFile: `${STATE_DIR}/session.json`,
    dir: `${STATE_DIR}/sessions`,
  },
  queue: {
    // The playback queue (upcoming/current/history) snapshotted to disk so a
    // controller restart doesn't lose tracks already handed to Liquidsoap.
    file: `${STATE_DIR}/queue.json`,
    // Rolling 24h log of (id, artist, endedAt) for each track that aired.
    // Read by the picker to block tracks/artists played in the last N hours —
    // queue.history is capped at 50 (~3h) and only lives in-memory, which is
    // why we keep a separate, longer-lived store.
    recentPlaysFile: `${STATE_DIR}/recent-plays.json`,
    recentPlaysMax: 300,
    // Count-based hard no-repeat guard: the picker (both pool and agent paths)
    // never re-airs any of the last N DISTINCT plays. Unlike the time-window
    // guard (recencyWindowsForLibrary) this is non-relaxable — it survives the
    // filterPickerCandidates starvation cascade, closing the hole where a
    // thin/over-visited mood cluster let the cascade drop the recent-track guard
    // and re-serve a just-played song. Clamped to library size at use
    // (effectiveNoRepeatWindow) so a small catalogue never fully blocks; 0
    // disables. Seeds settings.llm.noRepeatWindow — the live, admin-tunable
    // value; env wins. Listener requests stay exempt (request path is untouched).
    noRepeatWindow: parseInt(process.env.NO_REPEAT_WINDOW || '100', 10),
  },
  curiosity: {
    // Durable dedup ledger for the `curiosity` segment capability. Holds every
    // "on this day" item surfaced to the agent and every curiosity line aired,
    // so a controller restart no longer wipes the in-memory dedup set and
    // re-airs the same fact (issue #577). Pruned to `maxAgeDays` on load.
    seenFile: `${STATE_DIR}/seen-curiosity.json`,
    maxAgeDays: 7,
    // Hard cap on persisted entries — a belt to the 7-day prune.
    maxEntries: 400,
  },
  weather: {
    // Punjab (Chandigarh) — your home location
    lat: 30.7333,
    lng: 76.7794,
    locationName: 'Punjab',
    // 'metric' → Celsius, 'imperial' → Fahrenheit. Drives Open-Meteo's
    // temperature_unit query param and what unit the DJ announces on air.
    units: 'metric' as 'metric' | 'imperial',
  },
  news: {
    feedUrl: process.env.NEWS_FEED_URL || 'http://feeds.bbci.co.uk/news/rss.xml',
    maxItems: parseInt(process.env.NEWS_MAX_ITEMS || '10', 10),
  },
  search: {
    // Tavily API key for the web-search skill. Blank → the skill stays inert.
    apiKey: process.env.SEARCH_API_KEY || '',
  },
  server: {
    port: parseInt(process.env.PORT || '7701', 10),
  },
  show: {
    autoQueueRefreshMinutes: parseInt(process.env.AUTO_QUEUE_REFRESH_MINUTES || '60', 10),
  },
  tts: {
    // Speech-rate multiplier for the cloud engine (OpenAI / ElevenLabs).
    // 1.0 = normal, lower = slower. speech.js clamps it to each provider's
    // supported range before the request.
    cloudSpeed: parseFloat(process.env.CLOUD_TTS_SPEED || TTS_SPEED),
  },
};

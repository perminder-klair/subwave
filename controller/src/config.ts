// Centralised config — reads from env, with sensible defaults

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { resolveActiveStationDir } from './stations/resolve.js';
import { envEnum, envFloat, envInt, envStr, envUrl } from './util/env.js';

// Shared state ROOT. Compose passes STATE_DIR=/var/sub-wave; native dev falls
// back to the repo-local state/ dir.
export const STATE_ROOT = process.env.STATE_DIR
  || resolve(dirname(fileURLToPath(import.meta.url)), '../../state');

// The ACTIVE station's state dir — every file-based IPC channel lives here.
// Single-station installs resolve to the root. Resolved once per boot: switching
// stations restarts this process.
export const STATE_DIR = resolveActiveStationDir(STATE_ROOT);

// Relocated stem-cache root, as a CONTAINER path (the operator's STEMS_DIR is a
// HOST path and means nothing in here). Empty = no relocation; music/stem-cache.ts
// then resolves the cache under STATE_DIR.
export const STEMS_DIR = envStr('SUBWAVE_STEMS_DIR', '');

// Repo-bundled static audio (studio bed, emergency clip, default SFX). Compose
// passes SOUNDS_DIR=/sounds; native dev falls back to the repo-local sounds/ dir.
export const SOUNDS_DIR = process.env.SOUNDS_DIR
  || resolve(dirname(fileURLToPath(import.meta.url)), '../../sounds');

// TTS speech-rate multiplier: 1.0 = normal, lower = slower. Cross-engine default;
// each engine has its own var. piper.js inverts it (Piper uses length_scale).
const TTS_SPEED = envFloat('TTS_SPEED', 1.0, { min: 0.1 });

// Operator-uploaded reference WAVs, shared by Chatterbox + PocketTTS.
// CHATTERBOX_VOICE_DIR is honoured for back-compat; the legacy folder is still
// read at list/resolve time.
const VOICES_DIR = envStr('TTS_VOICE_DIR', envStr('CHATTERBOX_VOICE_DIR', `${STATE_DIR}/voices`));
const LEGACY_VOICES_DIR = `${STATE_DIR}/chatterbox-voices`;

export const config = {
  stateDir: STATE_DIR,
  // Install-level state root (stations/, icecast-secrets.env live here).
  stateRoot: STATE_ROOT,
  // Container path of a relocated stem cache; '' = under stateDir.
  stemsDir: STEMS_DIR,
  soundsDir: SOUNDS_DIR,
  navidrome: {
    url: envUrl('NAVIDROME_URL', 'http://navidrome:4533'),
    user: envStr('NAVIDROME_USER', ''),
    password: process.env.NAVIDROME_PASS || '',
    apiVersion: '1.16.1',
    clientName: 'sub-wave',
    // Per-request cap on Subsonic calls; without one a hung Navidrome stacks up
    // admin routes behind pending fetches (#786).
    timeoutMs: envInt('NAVIDROME_TIMEOUT_MS', 30_000),
  },
  ollama: {
    // Default-when-blank. The admin Settings UI (`llm.ollamaUrl` / `llm.model`)
    // is the only override — there are no OLLAMA_URL/OLLAMA_MODEL env vars.
    url: 'http://localhost:11434',
    model: 'nemotron-3-super:cloud',
  },
  piper: {
    binary: envStr('PIPER_BIN', '/usr/local/bin/piper'),
    voice: envStr('PIPER_VOICE', '/opt/piper/voices/en_GB-alan-medium.onnx'),
    voiceConfig: envStr('PIPER_VOICE_CONFIG', '/opt/piper/voices/en_GB-alan-medium.onnx.json'),
    outDir: envStr('PIPER_OUT', `${STATE_DIR}/voice`),
    speed: envFloat('PIPER_SPEED', TTS_SPEED, { min: 0.1 }),
  },
  // Acoustic analysis (bpm/key/intro). Two backends resolved in music/analyzer.ts:
  // the analysis sidecar, or a local Python venv (ANALYZE_PYTHON). Neither
  // reachable → the analysis phase skips cleanly.
  analyzer: {
    // Sidecar base URL; analyzer.ts probes /health for the 'analyze' engine.
    // Defaults to the compose service name, like navidrome.url above: a
    // controller whose compose file predates the ANALYZE_URL line then still
    // finds the default-on sidecar instead of silently disabling analysis
    // (#1636). A host that does not resolve is an ordinary probe miss.
    urls: [envUrl('ANALYZE_URL', 'http://analyzer:8080')].filter((u): u is string => !!u),
    python: envStr('ANALYZE_PYTHON', ''),   // empty → no local backend
    workerScript: envStr('ANALYZE_WORKER', '/app/scripts/analyze_worker.py'),
    // Analysis window, seconds. Demucs cost scales linearly with it. Keep in
    // sync with analyze_worker.py and docker/analyzer/server.py.
    seconds: envFloat('ANALYZE_SECONDS', 40, { min: 1 }),
    // In-flight analysis jobs for a sidecar backend. Local stdio analysis stays
    // single-flight (one line-protocol worker cannot multiplex).
    concurrency: envInt('ANALYZE_CONCURRENCY', 1, { min: 1, max: 8 }),
    requestTimeoutMs: envInt('ANALYZE_REQUEST_TIMEOUT_MS', 120_000),
    // Shorter deadline for transition renders: they run inside the pair-drain
    // window and must lose the race to the drain's fallback crossfade.
    renderTimeoutMs: envInt('ANALYZE_RENDER_TIMEOUT_MS', 60_000),
    // How long a "no backend at all" answer is cached before re-probing. Only
    // the MISS is timed; a backend that answered is remembered for the process
    // lifetime. 0 disables the caching.
    missProbeIntervalMs: envInt('ANALYZE_PROBE_MS', 60_000, { min: 0 }),
  },
  kokoro: {
    python: envStr('KOKORO_PYTHON', '/opt/kokoro/venv/bin/python'),
    workerScript: envStr('KOKORO_WORKER', '/app/scripts/kokoro_worker.py'),
    model: envStr('KOKORO_MODEL', '/opt/kokoro/models/kokoro-v1.0.onnx'),
    voices: envStr('KOKORO_VOICES', '/opt/kokoro/models/voices-v1.0.bin'),
    voice: envStr('KOKORO_VOICE', 'bf_isabella'),   // British female, BBC-ish
    lang: envStr('KOKORO_LANG', ''),
    speed: envFloat('KOKORO_SPEED', TTS_SPEED, { min: 0.1 }),
  },
  // Chatterbox is opt-in (`--build-arg WITH_CHATTERBOX=1`). isAvailable() does an
  // existsSync on `python`, so an image built without it falls back to Piper.
  chatterbox: {
    python: envStr('CHATTERBOX_PYTHON', '/opt/chatterbox/venv/bin/python'),
    workerScript: envStr('CHATTERBOX_WORKER', '/app/scripts/chatterbox_worker.py'),
    // 'cpu' or 'cuda'. CPU works but is slow; CUDA needs a GPU-enabled image.
    device: envEnum('CHATTERBOX_DEVICE', ['cpu', 'cuda'] as const, 'cpu'),
    // Per-persona reference WAVs; a persona's `tts.voice` is a filename in here.
    voiceDir: VOICES_DIR,
    // Fallback reference WAV when a persona has no voice. Empty → built-in voice.
    referenceWav: envStr('CHATTERBOX_REFERENCE_WAV', ''),
  },
  // PocketTTS is opt-in the same way (`--build-arg WITH_POCKETTTS=1`); absent
  // venv → unavailable, dispatcher falls back to Piper.
  pocketTts: {
    python: envStr('POCKET_TTS_PYTHON', '/opt/pocket-tts/venv/bin/python'),
    workerScript: envStr('POCKET_TTS_WORKER', '/app/scripts/pocket_tts_worker.py'),
    // Built-in voice id; an unrecognised id falls back to the worker's default.
    defaultVoice: envStr('POCKET_TTS_VOICE', 'alba'),
    // Shared with Chatterbox: a persona voice matching a .wav filename in here
    // switches the worker to reference-WAV cloning.
    voiceDir: VOICES_DIR,
  },
  // Shared reference-WAV folder for zero-shot cloning. `legacyDir` (pre-#213) is
  // still scanned, with `dir` winning on a filename clash.
  voices: {
    dir: VOICES_DIR,
    legacyDir: LEGACY_VOICES_DIR,
  },
  // Optional sidecar hosting Chatterbox + PocketTTS over HTTP (`tts-heavy`
  // profile). Both engine modules prefer it when the URL is set, else the
  // in-process WITH_*=1 build path.
  ttsHeavy: {
    url: envUrl('TTS_HEAVY_URL', ''),
    // isAvailable() caches a /health probe and re-runs it on this interval, so a
    // sidecar coming up or going down is picked up without a restart.
    probeIntervalMs: envInt('TTS_HEAVY_PROBE_MS', 30_000),
    // Network/connect ceiling only — inference is bounded by the engine modules'
    // own request timeouts.
    requestTimeoutMs: envInt('TTS_HEAVY_TIMEOUT_MS', 180_000),
  },
  icecast: {
    // Public status JSON — listener counts + per-mount metadata. No auth.
    statusUrl: envUrl('ICECAST_STATUS_URL', 'http://broadcast:7702/status-json.xsl'),
    // Per-connection detail. Basic-auth gated; credentials resolved at call time
    // from ICECAST_ADMIN_PASSWORD or state/icecast-secrets.env (listeners.ts).
    adminUrl: envUrl('ICECAST_ADMIN_URL', 'http://broadcast:7702/admin/listclients'),
    adminUser: envStr('ICECAST_ADMIN_USER', 'admin'),
  },
  // Offline GeoIP DB (MaxMind MMDB) for the listener-country rollup — the last,
  // opt-in link of the header chain. Empty = no lookup. Env wins over
  // settings.stream.geoipDbPath.
  geoip: {
    dbPath: envStr('GEOIP_DB_PATH', ''),
  },
  liquidsoap: {
    queueFile: `${STATE_DIR}/next.txt`,
    // Priority handoff for an operator-triggered jingle. Separate from next.txt so
    // Liquidsoap can choose it before an already-filled dj_queue.
    jingleFile: `${STATE_DIR}/jingle-now.txt`,
    sayFile: `${STATE_DIR}/say.txt`,
    // Talk-over voice channel (auto-links): plays OVER a started track with LIGHT
    // ducking, unlike sayFile's heavy duck. Read by its own poll in radio.liq.
    introFile: `${STATE_DIR}/intro.txt`,
    // On-demand SFX channel; radio.liq's sfx_queue mixes it UNDER the DJ voice.
    sfxFile: `${STATE_DIR}/sfx.txt`,
    autoPlaylist: `${STATE_DIR}/auto.m3u`,
    nowPlayingFile: `${STATE_DIR}/now-playing.json`,
    // Written by radio.liq when a jingle starts (#997). Jingles play outside the
    // voice serialiser, so airVoice reads this to hold spoken segments until the
    // clip clears. TWO writers (rotate playlist + jingle_now_queue), both
    // playlist/queue hooks rather than branches of on_meta; both stamp
    // `durationSec` so the collision guard can measure any container.
    jinglePlayingFile: `${STATE_DIR}/jingle-playing.json`,
    // Written by radio.liq when a `subwave_kind="bed"` track starts. A bed carries
    // no title/artist, so on_meta writes this instead of now-playing.json — and it
    // is how the controller learns to air the link OVER the bed.
    bedPlayingFile: `${STATE_DIR}/bed-playing.json`,
    // Written by radio.liq when a `subwave_kind="pause-talk"` silence item
    // starts. It is the boundary signal that releases the real speech through
    // say.txt, preserving the normal mic chain and voice-playing marker.
    pauseTalkPlayingFile: `${STATE_DIR}/pause-talk-playing.json`,
    // Durable two-phase acknowledgement for pause-and-talk speech. poll_voice
    // writes accepted only after voice_queue.push returns; voice_marker writes
    // started when the first spoken sample feeds. Separate files keep one
    // writer per marker and let a restarted controller avoid republishing.
    pauseVoiceAcceptedFile: `${STATE_DIR}/pause-talk-voice-accepted.json`,
    pauseVoiceStartedFile: `${STATE_DIR}/pause-talk-voice-started.json`,
    // Written by radio.liq when voice_queue/intro_queue starts a spoken clip:
    // {voiceId, channel, filename, startedAt}. `voiceId` matches the id airVoice
    // stamped into the clip's `annotate:` URI (the silent lead-in carries none and
    // is skipped). The ONLY signal that the words are on the stream (#1382).
    voicePlayingFile: `${STATE_DIR}/voice-playing.json`,
    // radio.liq's starve guard (#1300 bug 7): {starved, since, at}, unix SECONDS.
    // `at` is a heartbeat refreshed every tick while starved, so a stale marker is
    // detectable. Read via broadcast/music-starve.ts.
    musicStarvedFile: `${STATE_DIR}/music-starved.json`,
    // Written on every icecast render by docker/broadcast-entrypoint.sh and the AIO
    // supervisor, NOT by radio.liq (#1613): {count, source, proxies, dropped, at}.
    // Lets admin → Listeners say why it is showing the edge's address. Absent (an
    // older broadcast image) is UNKNOWN and surfaces nothing.
    trustedProxiesFile: `${STATE_DIR}/trusted-proxies.json`,
  },
  session: {
    // The live DJ session (chat-history JSON); archived into `dir` on roll.
    currentFile: `${STATE_DIR}/session.json`,
    dir: `${STATE_DIR}/sessions`,
  },
  queue: {
    // Playback queue snapshotted to disk so a restart doesn't lose tracks already
    // handed to Liquidsoap.
    file: `${STATE_DIR}/queue.json`,
    // Rolling log of (id, artist, endedAt) per aired track, read by the picker's
    // anti-repeat windows. queue.history is in-memory and capped at 50 (~3h),
    // hence a separate longer-lived store.
    recentPlaysFile: `${STATE_DIR}/recent-plays.json`,
    // Play-log cap. ~550 plays/day at the 3-min cap, so 2500 keeps four days —
    // enough to honestly supply the 36h recency boost and a maxed no-repeat
    // window. ~300KB of JSON, rewritten once per play.
    recentPlaysMax: 2500,
    // Anti-repeat recap fed to every DJ script prompt (queue.getDjRecap): how
    // many aired lines, how far back, and chars kept per line. Minutes cap at
    // 240 because the session hard-rolls at 4h, so older lines don't exist.
    recapLimit: envInt('DJ_RECAP_LIMIT', 10, { min: 1, max: 50 }),
    recapMinutes: envInt('DJ_RECAP_MINUTES', 120, { min: 1, max: 240 }),
    recapChars: envInt('DJ_RECAP_CHARS', 140, { min: 40, max: 1000 }),
    // Count-based hard no-repeat guard: neither pick path re-airs any of the last
    // N DISTINCT plays. Non-relaxable — it survives the filterPickerCandidates
    // starvation cascade. Clamped to library size at use (37.5% ceiling), so a
    // small catalogue never fully blocks; 0 disables. Seeds the admin-tunable
    // settings.llm.noRepeatWindow (env wins); listener requests stay exempt.
    noRepeatWindow: envInt('NO_REPEAT_WINDOW', 250, { min: 0 }),
  },
  curiosity: {
    // Durable dedup ledger for the `curiosity` capability, so a restart doesn't
    // re-air the same fact (#577). Pruned to `maxAgeDays` on load.
    seenFile: `${STATE_DIR}/seen-curiosity.json`,
    maxAgeDays: 7,
    // Hard cap on persisted entries, a belt to the 7-day prune.
    maxEntries: 400,
  },
  weather: {
    lat: 30.7333,
    lng: 76.7794,
    locationName: 'Punjab',
    // Broader place the DJ names on air, mirrored from settings.weather; blank
    // falls back to locationName. Settings-layer, so no env override here.
    onAirLocation: '',
    // Drives Open-Meteo's temperature_unit and what the DJ announces.
    units: 'metric' as 'metric' | 'imperial',
  },
  news: {
    feedUrl: envUrl('NEWS_FEED_URL', 'http://feeds.bbci.co.uk/news/rss.xml'),
    maxItems: envInt('NEWS_MAX_ITEMS', 10),
  },
  search: {
    // Tavily API key for the web-search skill. Blank → the skill stays inert.
    apiKey: envStr('SEARCH_API_KEY', ''),
  },
  // Community catalog (skills / personas / shows / stations), fetched live — see
  // community/registry.ts. Override to point at a fork, mirror or CDN.
  community: {
    catalogUrl: envUrl(
      'COMMUNITY_CATALOG_URL',
      'https://raw.githubusercontent.com/getsubwave/community/main/catalog.json',
    ),
    // In-memory TTL before a browse refetches; POST /community/refresh busts it.
    ttlMs: envInt('COMMUNITY_CATALOG_TTL_MS', 30 * 60 * 1000),
  },
  server: {
    port: envInt('PORT', 7701, { min: 1, max: 65_535 }),
  },
  show: {
    autoQueueRefreshMinutes: envInt('AUTO_QUEUE_REFRESH_MINUTES', 60),
  },
  tts: {
    // Cloud-engine speech rate; speech.js clamps it to each provider's range.
    cloudSpeed: envFloat('CLOUD_TTS_SPEED', TTS_SPEED, { min: 0.1 }),
  },
};

'use client';

// The settings surface described once, so three things can read it instead of
// re-deriving it: the grouped nav rail, the per-section dirty dot + sticky save
// bar, and the search box that jumps to a field.
//
// Only the SHAPE lives here — labels, which section owns which slice of the
// form, which paths cost a mixer restart. The controls themselves stay in their
// section components; this file never renders anything.

import {
  Radio, Palette, Cpu, Mic, Library, Search,
  Activity, Archive, Save, AlertTriangle, Heart, Music2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * The four rail clusters, in rail order.
 *
 * Grouping is editorial, not structural: "the station" is what the operator
 * sets up once, "the dj" is what talks, "listeners" is what the audience
 * touches, "operations" is what can interrupt the broadcast.
 */
export const SECTION_GROUPS = ['the station', 'the dj', 'listeners', 'operations'] as const;

export type SectionGroup = (typeof SECTION_GROUPS)[number];

export interface SectionSpec {
  id: string;
  group: SectionGroup;
  label: string;
  hint: string;
  icon: LucideIcon;
  /**
   * Top-level FormState keys this section owns. The sticky save bar and the
   * rail's unsaved dot both diff these against the saved baseline, so a section
   * whose state does NOT ride FormState (music: Navidrome creds live in
   * setup-config.json; theme: every control saves on click) lists none and
   * reports its own dirtiness through SaveBar's `dirty` prop instead.
   */
  formKeys: readonly string[];
}

// `satisfies`, never a `readonly SectionSpec[]` annotation: the annotation
// widens every `id` back to `string` and takes `SectionId` — and with it every
// typo guard on SETTINGS_INDEX, ADVANCED_CARDS and `activeSection` — down with
// it. A bad id then compiles clean and dies quietly at runtime (`sectionById`
// → undefined → no formKeys → no dirty tracking, no save bar).
export const SECTIONS = [
  {
    id: 'station', group: 'the station', label: 'Station',
    hint: 'name · location · privacy', icon: Radio,
    formKeys: ['station', 'stationDescription', 'timezone', 'locale', 'weather', 'privacy', 'requests'],
  },
  {
    id: 'music', group: 'the station', label: 'Music source',
    hint: 'navidrome · subsonic', icon: Music2,
    formKeys: [],
  },
  {
    id: 'theme', group: 'the station', label: 'Skin & Themes',
    hint: 'player skin · palette', icon: Palette,
    formKeys: [],
  },
  {
    id: 'llm', group: 'the dj', label: 'LLM provider',
    hint: 'model routing', icon: Cpu,
    formKeys: ['llm'],
  },
  {
    id: 'tts', group: 'the dj', label: 'TTS voice',
    hint: 'default engine', icon: Mic,
    formKeys: ['tts', 'kokoroLang'],
  },
  {
    id: 'library', group: 'the dj', label: 'Library tagger',
    hint: 'embedding · propagation', icon: Library,
    formKeys: ['embedding'],
  },
  {
    id: 'search', group: 'the dj', label: 'Web search',
    hint: 'live-facts backend', icon: Search,
    formKeys: ['search'],
  },
  {
    id: 'likes', group: 'listeners', label: 'Likes',
    hint: 'heart button · stars', icon: Heart,
    formKeys: ['likes'],
  },
  {
    id: 'scrobble', group: 'listeners', label: 'Scrobbling',
    hint: 'last.fm · listenbrainz', icon: Activity,
    formKeys: ['scrobble'],
  },
  {
    id: 'archives', group: 'operations', label: 'Archives',
    hint: 'hourly recordings', icon: Archive,
    formKeys: ['archive'],
  },
  {
    id: 'backup', group: 'operations', label: 'Backup',
    hint: 'export · restore', icon: Save,
    formKeys: [],
  },
  {
    id: 'danger', group: 'operations', label: 'Danger zone',
    hint: 'mixer · broadcast', icon: AlertTriangle,
    formKeys: ['crossfadeDuration', 'maxTrackSeconds', 'silenceTrim', 'transitions', 'stream', 'loudness'],
  },
] as const satisfies readonly SectionSpec[];

export type SectionId = (typeof SECTIONS)[number]['id'];

export const sectionById = (id: string) => SECTIONS.find(s => s.id === id);

/**
 * Dotted FormState paths whose change costs a mixer restart.
 *
 * Mirrors the `restart = true` branches in `controller/src/settings.ts` — the
 * controller stays the authority (it answers `requiresRestart` on the save and
 * the existing banner reacts to that). This list only decides whether the save
 * bar warns BEFORE the operator commits, so a stale entry costs a missing or
 * spurious warning, never a wrong save.
 */
export const RESTART_PATHS: readonly string[] = [
  'station',
  'privacy.listenerAuth',
  'crossfadeDuration',
  'archive.enabled',
  'archive.bitrate',
  'stream.opusEnabled',
  'stream.opusBitrate',
  'stream.flacEnabled',
  'stream.oggIcyMetadata',
  'stream.aacEnabled',
  'stream.aacBitrate',
  'stream.bitrate',
  'stream.bufferSeconds',
  'stream.maxListeners',
];

/**
 * Card titles that sit behind each section's Advanced disclosure.
 *
 * Keyed by section id → the anchors (see `cardAnchor`) of the cards to defer.
 * A section renders its own <Advanced> wrapper; this table exists so the search
 * index can say "adv" on a result and open the disclosure when it jumps there.
 */
export const ADVANCED_CARDS: Partial<Record<SectionId, readonly string[]>> = {
  station: ['listener-requests', 'public-api'],
  llm: ['fallback', 'reasoning', 'next-track-picker', 'idle-behaviour', 'daily-token-budget'],
  tts: ['fallback-voice'],
  library: ['seed-phase', 'propagation', 'enrichment'],
  likes: ['ai-dj-influence'],
  danger: [
    'crossfade', 'stem-transitions', 'max-track-length', 'dead-air-trim',
    'loudness-levelling', 'opus-stream', 'flac-stream', 'ogg-metadata',
    'aac-stream', 'stream-mp3-bitrate', 'listener-buffer', 'max-listeners',
  ],
};

export const isAdvancedCard = (section: SectionId, anchor: string) =>
  (ADVANCED_CARDS[section] || []).includes(anchor);

export interface IndexEntry {
  /** The control's own label, as the operator reads it on screen. */
  label: string;
  section: SectionId;
  /** Card title, shown as the result's trail and used as the scroll anchor. */
  card: string;
  /** Extra words that should match but are not in the label. */
  keywords?: string;
}

/** Every setting the operator can search for, in rail order. */
export const SETTINGS_INDEX: readonly IndexEntry[] = [
  // ── station ────────────────────────────────────────────────────────────────
  { label: 'Station name', section: 'station', card: 'Station identity', keywords: 'call sign title dj prompt' },
  { label: 'Share description', section: 'station', card: 'Station identity', keywords: 'blurb og meta social' },
  { label: 'Location', section: 'station', card: 'Station location', keywords: 'weather forecast open-meteo latitude longitude' },
  { label: 'On-air location', section: 'station', card: 'Station location', keywords: 'spoken public place' },
  { label: 'Weather units', section: 'station', card: 'Station location', keywords: 'metric imperial celsius fahrenheit' },
  { label: 'Station timezone', section: 'station', card: 'Timezone', keywords: 'clock time zone schedule slots' },
  { label: 'Station locale', section: 'station', card: 'Localization', keywords: 'language 24h am pm date format' },
  { label: 'Private player', section: 'station', card: 'Privacy', keywords: 'password gate hide lock' },
  { label: 'Stream password', section: 'station', card: 'Privacy', keywords: 'listener auth icecast lock restart' },
  { label: 'Station password', section: 'station', card: 'Privacy', keywords: 'secret shared passphrase' },
  { label: 'Accept requests', section: 'station', card: 'Listener requests', keywords: 'request line open closed' },
  { label: 'Max queued requests', section: 'station', card: 'Listener requests', keywords: 'pending queue limit' },
  { label: 'Seconds between requests', section: 'station', card: 'Listener requests', keywords: 'cooldown rate limit' },
  { label: 'Per-listener hourly cap', section: 'station', card: 'Listener requests', keywords: 'ip rate limit hour' },
  { label: 'Station hourly cap', section: 'station', card: 'Listener requests', keywords: 'global rate limit hour' },
  { label: 'Repeat cooldown', section: 'station', card: 'Listener requests', keywords: 'same track again minutes' },
  { label: 'One request per listener at a time', section: 'station', card: 'Listener requests', keywords: 'ip pending single' },
  { label: 'Publish persona souls', section: 'station', card: 'Public API', keywords: 'system prompt schedule personas public json' },

  // ── music source ───────────────────────────────────────────────────────────
  { label: 'Server URL', section: 'music', card: 'Navidrome server', keywords: 'navidrome subsonic host url' },
  { label: 'Username', section: 'music', card: 'Navidrome server', keywords: 'navidrome subsonic login user' },
  { label: 'Password', section: 'music', card: 'Navidrome server', keywords: 'navidrome subsonic secret salt token' },

  // ── skin & themes ──────────────────────────────────────────────────────────
  { label: 'Station skin', section: 'theme', card: 'Player skin', keywords: 'classic unit platter drift subamp tty listen face' },
  { label: 'Active theme', section: 'theme', card: 'Themes', keywords: 'palette colours colors newsprint nightshift dark light' },
  { label: 'Show the tune-in overlay', section: 'theme', card: 'Tune-in overlay', keywords: 'gate tap to listen splash' },
  { label: 'Show the Booth Sprite', section: 'theme', card: 'Booth Buddy', keywords: 'mascot sprite request box' },

  // ── llm provider ───────────────────────────────────────────────────────────
  { label: 'Provider', section: 'llm', card: 'Provider', keywords: 'ollama anthropic openai google deepseek openrouter requesty gateway compatible' },
  { label: 'Ollama server URL', section: 'llm', card: 'Provider', keywords: 'host docker internal 11434 local' },
  { label: 'API key', section: 'llm', card: 'Provider', keywords: 'token secret credential sk-' },
  { label: 'Model', section: 'llm', card: 'Provider', keywords: 'llama claude gpt gemini model id' },
  { label: 'Forced tool calls', section: 'llm', card: 'Provider', keywords: 'tool choice required auto' },
  { label: 'Context window (num_ctx)', section: 'llm', card: 'Provider', keywords: 'tokens history numctx' },
  { label: 'Repetition penalty (repeat_penalty)', section: 'llm', card: 'Provider', keywords: 'repeat penalty phrasing' },
  { label: 'Max response size (tokens)', section: 'llm', card: 'Reasoning', keywords: 'max output tokens' },
  { label: 'Reasoning', section: 'llm', card: 'Reasoning', keywords: 'thinking trace chain of thought' },
  { label: 'Backup provider', section: 'llm', card: 'Fallback', keywords: 'fallback secondary offline' },
  { label: 'Backup model', section: 'llm', card: 'Fallback', keywords: 'fallback secondary model id' },
  { label: 'Agent deadline', section: 'llm', card: 'Next-track picker', keywords: 'timeout seconds give up pool picker' },
  { label: 'Discovery rounds per pick', section: 'llm', card: 'Next-track picker', keywords: 'steps tool loops' },
  { label: 'No-repeat window (tracks)', section: 'llm', card: 'Next-track picker', keywords: 'repeat history variety' },
  { label: 'Artist spacing (slots)', section: 'llm', card: 'Next-track picker', keywords: 'artist variety window' },
  { label: 'Daily token cap', section: 'llm', card: 'Daily token budget', keywords: 'budget spend limit cost' },
  { label: 'Soft threshold', section: 'llm', card: 'Daily token budget', keywords: 'warning percent budget dash' },
  { label: 'Pause the DJ when nobody is listening', section: 'llm', card: 'Idle behaviour', keywords: 'idle empty room quiet' },

  // ── tts voice ──────────────────────────────────────────────────────────────
  { label: 'DJ speech', section: 'tts', card: 'Station voice', keywords: 'on air music only mute silent' },
  { label: 'Engine', section: 'tts', card: 'Voice engine', keywords: 'piper kokoro chatterbox pocket-tts cloud remote' },
  { label: 'Voice', section: 'tts', card: 'Voice engine', keywords: 'speaker accent alba amy' },
  { label: 'Voice level (dB)', section: 'tts', card: 'Voice engine', keywords: 'gain trim loudness decibel' },
  { label: 'Speech speed', section: 'tts', card: 'Voice engine', keywords: 'rate tempo faster slower' },
  { label: 'API key', section: 'tts', card: 'Voice engine', keywords: 'openai elevenlabs fish audio cloud token' },
  { label: 'Model', section: 'tts', card: 'Voice engine', keywords: 'cloud speech model gpt-4o-mini-tts' },
  { label: 'Latency mode', section: 'tts', card: 'Voice engine', keywords: 'fish audio low normal balanced' },
  { label: 'Server URL', section: 'tts', card: 'Voice engine', keywords: 'remote http endpoint' },
  { label: 'Fallback engine', section: 'tts', card: 'Fallback voice', keywords: 'rescue voice slot backup' },

  // ── library tagger ─────────────────────────────────────────────────────────
  { label: 'Tagger', section: 'library', card: 'Tagger', keywords: 'enabled tagging runs moods genres' },
  { label: 'LLM batch size', section: 'library', card: 'Tagger', keywords: 'batch tracks per call seed' },
  { label: 'Provider', section: 'library', card: 'Embedding server', keywords: 'embedding ollama openai google inherit' },
  { label: 'Model', section: 'library', card: 'Embedding server', keywords: 'nomic-embed-text embedding model reindex' },
  { label: 'Embedding server URL', section: 'library', card: 'Embedding server', keywords: 'base url host' },
  { label: 'Bearer token', section: 'library', card: 'Embedding server', keywords: 'embedding api key auth' },
  { label: 'Seed count', section: 'library', card: 'Seed phase', keywords: 'seed tracks auto size' },
  { label: 'KNN neighbours', section: 'library', card: 'Propagation', keywords: 'neighbours vote knn similarity' },
  { label: 'Mood vote threshold', section: 'library', card: 'Propagation', keywords: 'mood share vote stick' },
  { label: 'Confidence threshold', section: 'library', card: 'Propagation', keywords: 'confidence active learning' },
  { label: 'Audio fusion weight', section: 'library', card: 'Propagation', keywords: 'clap audio text fusion analyzer' },
  { label: 'Active-learning rounds', section: 'library', card: 'Propagation', keywords: 'rounds least confident passes' },
  { label: 'Last.fm tags', section: 'library', card: 'Enrichment', keywords: 'crowd tags embed text' },
  { label: 'Lyrics', section: 'library', card: 'Enrichment', keywords: 'lyrics embed text' },

  // ── web search ─────────────────────────────────────────────────────────────
  { label: 'Provider', section: 'search', card: 'Provider', keywords: 'duckduckgo tavily brave searxng live facts' },
  { label: 'API key', section: 'search', card: 'Provider', keywords: 'tavily brave token search_api_key' },
  { label: 'SearXNG URL', section: 'search', card: 'Provider', keywords: 'self hosted meta search json' },

  // ── likes ──────────────────────────────────────────────────────────────────
  { label: 'Enabled', section: 'likes', card: 'Heart button', keywords: 'heart like listener tap' },
  { label: 'Star in Navidrome', section: 'likes', card: 'Heart button', keywords: 'subsonic starred favourites' },
  { label: 'Use likes to influence picks', section: 'likes', card: 'AI DJ influence', keywords: 'taste preference signal picker' },
  { label: 'Tracks included', section: 'likes', card: 'AI DJ influence', keywords: 'top liked count' },
  { label: 'Time window (days)', section: 'likes', card: 'AI DJ influence', keywords: 'window days all time' },

  // ── scrobbling ─────────────────────────────────────────────────────────────
  { label: 'Enabled', section: 'scrobble', card: 'Last.fm', keywords: 'lastfm scrobble spins' },
  { label: 'API key', section: 'scrobble', card: 'Last.fm', keywords: 'lastfm credential' },
  { label: 'API secret', section: 'scrobble', card: 'Last.fm', keywords: 'lastfm shared secret handshake' },
  { label: 'Session key', section: 'scrobble', card: 'Last.fm', keywords: 'authorize session token' },
  { label: 'Username (display)', section: 'scrobble', card: 'Last.fm', keywords: 'lastfm user dash' },
  { label: 'Enabled', section: 'scrobble', card: 'ListenBrainz', keywords: 'listenbrainz scrobble spins' },
  { label: 'User token', section: 'scrobble', card: 'ListenBrainz', keywords: 'listenbrainz profile token' },
  { label: 'API base URL', section: 'scrobble', card: 'ListenBrainz', keywords: 'self hosted instance endpoint' },
  { label: 'Username (display)', section: 'scrobble', card: 'ListenBrainz', keywords: 'listenbrainz user dash' },

  // ── archives ───────────────────────────────────────────────────────────────
  { label: 'Record the broadcast to disk', section: 'archives', card: 'Hourly archive', keywords: 'archive recording mp3 tapes restart' },
  { label: 'Archive bitrate', section: 'archives', card: 'Hourly archive', keywords: 'kbps encoder cpu restart' },
  { label: 'Keep recordings for', section: 'archives', card: 'Hourly archive', keywords: 'retention days disk cleanup' },

  // ── danger zone ────────────────────────────────────────────────────────────
  { label: 'Stop stream', section: 'danger', card: 'Broadcast', keywords: 'off air disconnect icecast mount' },
  { label: 'Pause when the room is empty', section: 'danger', card: 'Idle pause', keywords: 'idle empty listeners resume' },
  { label: 'Crossfade duration', section: 'danger', card: 'Crossfade', keywords: 'overlap seams transition restart' },
  { label: 'Pair-aware transitions', section: 'danger', card: 'Stem transitions', keywords: 'pair drain successor crossfade' },
  { label: 'Stem cache', section: 'danger', card: 'Stem transitions', keywords: 'demucs drums bass vocals disk' },
  { label: 'Stem cache budget', section: 'danger', card: 'Stem transitions', keywords: 'gb evict oldest' },
  { label: 'Stem-blend seams', section: 'danger', card: 'Stem transitions', keywords: 'drums carry under intro blend' },
  { label: 'Maximum track length', section: 'danger', card: 'Max track length', keywords: 'cap cut long tracks seconds' },
  { label: 'Trim silent edges', section: 'danger', card: 'Dead-air trim', keywords: 'silence cue in cue out dead air' },
  { label: 'Shortest gap worth cutting', section: 'danger', card: 'Dead-air trim', keywords: 'min gap ms silence' },
  { label: 'Loudness source', section: 'danger', card: 'Loudness levelling', keywords: 'replaygain measured lufs' },
  { label: 'Target loudness', section: 'danger', card: 'Loudness levelling', keywords: 'lufs normalisation level' },
  { label: 'Max boost', section: 'danger', card: 'Loudness levelling', keywords: 'db cap gain ceiling' },
  { label: 'Serve the secondary Opus mount', section: 'danger', card: 'Opus stream', keywords: 'opus ogg mount restart' },
  { label: 'Bitrate', section: 'danger', card: 'Opus stream', keywords: 'opus kbps restart' },
  { label: 'Serve the lossless FLAC mount', section: 'danger', card: 'FLAC stream', keywords: 'flac lossless ogg mount restart' },
  { label: 'Push ICY track titles on the Ogg mounts', section: 'danger', card: 'Ogg metadata', keywords: 'icy metadata ogg titles' },
  { label: 'Serve the AAC mount', section: 'danger', card: 'AAC stream', keywords: 'aac adts mount restart' },
  { label: 'Bitrate', section: 'danger', card: 'AAC stream', keywords: 'aac kbps restart' },
  { label: 'Bitrate', section: 'danger', card: 'Stream MP3 bitrate', keywords: 'mp3 kbps stream restart' },
  { label: 'Listener buffer', section: 'danger', card: 'Listener buffer', keywords: 'burst size seconds behind live edge restart' },
  { label: 'Max listeners', section: 'danger', card: 'Max listeners', keywords: 'icecast max clients concurrent connections capacity limit licensing fees restart' },
  { label: 'Restart mixer', section: 'danger', card: 'Mixer', keywords: 'restart liquidsoap apply pending' },
];

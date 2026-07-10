// The Connect catalog — the single, hand-curated source of truth for the
// admin "Connect" page (API explorer + playground), the OpenAPI export, and
// the integration recipes. It documents the *integration subset* of the HTTP
// API: the ~50 endpoints a listener, hardware player, agent, or home-automation
// hub would actually call — not every internal onboarding/backup/doctor route.
//
// Three exports:
//   ENDPOINTS      — the documented HTTP endpoints, grouped for display.
//   MCP_TOOLS      — the tools the subwave-mcp server exposes (mirrors
//                    mcp-subwave/src/index.ts + docs/mcp-server.md).
//   STREAM_MOUNTS  — the Icecast stream mounts, keyed to their settings flag.
//
// Paths are written WITHOUT the `/api` prefix, matching how the web layer's
// adminFetch and the controller's own routers mount them. The route layer
// (routes/connect.ts) resolves the absolute origin at request time.
//
// A drift guard (scripts/connect-catalog.test.ts) asserts every ENDPOINT path
// here still exists in a real Express router, so a renamed/removed route can
// never leave a dead entry in the explorer.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface ParamDoc {
  name: string;
  required?: boolean;
  description: string;
  example?: string | number | boolean;
}

export interface EndpointDoc {
  method: HttpMethod;
  // As mounted on the router, no `/api` prefix. `:id`-style path params.
  path: string;
  // Short imperative label for the list row.
  summary: string;
  // Longer prose for the expanded card.
  description: string;
  auth: 'none' | 'admin';
  // True when calling it changes the live broadcast (speaks, queues, skips).
  // Drives the playground's confirm step and an "on-air" badge.
  mutatesAir?: boolean;
  pathParams?: ParamDoc[];
  queryParams?: ParamDoc[];
  // Pre-fills the playground's JSON body; also the OpenAPI requestBody example.
  bodyExample?: Record<string, unknown>;
  // Hand-written 200-response sample. Illustrative, not exhaustive.
  responseExample: unknown;
}

export interface EndpointGroup {
  id: string;
  label: string;
  blurb: string;
  endpoints: EndpointDoc[];
}

export interface McpToolDoc {
  name: string;
  title: string;
  description: string;
  // The controller endpoint(s) it wraps, for the "what does this call" column.
  endpoint: string;
  auth: 'none' | 'admin';
  mutatesAir?: boolean;
}

export interface StreamMountDoc {
  mount: string;
  format: string;
  codec: string;
  description: string;
  // Which settings.stream flag gates it. `null` for the always-served floor.
  settingFlag: 'opusEnabled' | 'flacEnabled' | 'aacEnabled' | null;
  alwaysOn: boolean;
}

// ---------------------------------------------------------------------------
// HTTP endpoints
// ---------------------------------------------------------------------------

export const ENDPOINT_GROUPS: EndpointGroup[] = [
  {
    id: 'station',
    label: 'Station & Now Playing',
    blurb:
      'Public, unauthenticated reads. What is on air right now, the queue and ' +
      'history, the DJ persona, the weekly schedule, and the live Booth feed. ' +
      'This is what a listener client, a dashboard card, or a home-automation ' +
      'sensor polls.',
    endpoints: [
      {
        method: 'GET',
        path: '/health',
        summary: 'Liveness probe',
        description:
          'Cheap liveness check. Returns as soon as the controller is up. Use it ' +
          'for uptime monitors and readiness gates.',
        auth: 'none',
        responseExample: { status: 'on-air' },
      },
      {
        method: 'GET',
        path: '/now-playing',
        summary: 'Current track + station context',
        description:
          'The live track (title/artist/album, cover-art id, genre/BPM/key/mood ' +
          'when the track is analysed), station context (time, weather, dominant ' +
          'mood), the on-air DJ persona and any active show, live listener count, ' +
          'and a structured `stream` descriptor listing which mounts are live. ' +
          'This is the primary feed for now-playing displays and metadata sensors.',
        auth: 'none',
        responseExample: {
          nowPlaying: {
            title: 'Midnight City',
            artist: 'M83',
            album: 'Hurry Up, We\'re Dreaming',
            subsonic_id: 'a1b2c3',
            genre: 'Synthpop',
            bpm: 105,
            musicalKey: 'F#m',
            moods: ['nocturnal', 'euphoric'],
          },
          context: { time: 'evening', weather: 'clear', dominantMood: 'nocturnal' },
          dj: { name: 'Frequency', tagline: 'after-dark selector', station: 'SUB/WAVE' },
          activeShow: null,
          listeners: 3,
          streamOnline: true,
          stream: { mount: '/stream.mp3', format: 'mp3', bitrate: 128, opusEnabled: false, flacEnabled: false, aacEnabled: false },
          llmTokens: 184213,
          timezone: 'Europe/London',
        },
      },
      {
        method: 'GET',
        path: '/state',
        summary: 'Queue, history & DJ log',
        description:
          'The upcoming queue, recent play history, and the DJ booth log (last 50 ' +
          'entries), plus the active theme id and station timezone. Polled by the ' +
          'web player every 5s alongside /now-playing.',
        auth: 'none',
        responseExample: {
          current: { title: 'Midnight City', artist: 'M83', source: 'auto', startedAt: 1720000000000 },
          upcoming: [{ title: 'Open Eye Signal', artist: 'Jon Hopkins', requestedBy: 'auto' }],
          history: [{ title: 'Nightcall', artist: 'Kavinsky' }],
          djLog: [{ t: 1720000000000, kind: 'pick', text: 'picked Open Eye Signal' }],
          autoPick: true,
          autoLink: true,
          theme: { active: 'midnight' },
          timezone: 'Europe/London',
        },
      },
      {
        method: 'GET',
        path: '/dj',
        summary: 'On-air DJ persona',
        description:
          'The effective DJ persona right now — name, tagline, soul blurb, talk ' +
          'frequency, DJ-mode flag, avatar URL, and station name. Reflects the ' +
          'active show\'s persona when a show is on air.',
        auth: 'none',
        responseExample: {
          name: 'Frequency',
          tagline: 'after-dark selector',
          soul: 'warm, unhurried, knows the deep cuts',
          frequency: 'moderate',
          djMode: true,
          station: 'SUB/WAVE',
          location: 'London',
        },
      },
      {
        method: 'GET',
        path: '/schedule',
        summary: 'Weekly show schedule',
        description:
          'The listener-facing week view: show definitions, the 7×24 grid, and a ' +
          'persona index (id/name/avatar), painted in the station\'s timezone. No ' +
          'admin-only fields.',
        auth: 'none',
        responseExample: {
          personas: [{ id: 'frequency', name: 'Frequency', avatar: '/persona-avatar/frequency' }],
          shows: [{ id: 'late-shift', name: 'The Late Shift', topic: 'after-hours', mood: 'nocturnal', personaId: 'frequency' }],
          schedule: { mon: [], tue: [] },
          timezone: 'Europe/London',
        },
      },
      {
        method: 'GET',
        path: '/session',
        summary: 'Live DJ session feed',
        description:
          'The current DJ session header plus a bounded tail (last 120) of its ' +
          'chat-history turns ({ t, role, kind, text }). Powers the player Booth ' +
          'feed. Returns nulls when no session is live.',
        auth: 'none',
        responseExample: {
          session: { id: 'auto:evening:nocturnal:1720000000', kind: 'auto', startedAt: 1720000000000, show: null },
          messages: [{ t: 1720000000000, role: 'assistant', kind: 'link', text: 'Two from the after-dark shelf...' }],
        },
      },
      {
        method: 'GET',
        path: '/cover/:id',
        summary: 'Cover-art proxy',
        description:
          'Proxies Subsonic cover art for a track id (from now-playing\'s ' +
          '`subsonic_id`) so clients get artwork without the Navidrome ' +
          'credentials. Heavily cached. Returns an image, not JSON.',
        auth: 'none',
        pathParams: [{ name: 'id', required: true, description: 'Subsonic track/cover id', example: 'a1b2c3' }],
        responseExample: '<binary image/jpeg>',
      },
      {
        method: 'GET',
        path: '/listen.pls',
        summary: 'PLS tune-in file',
        description:
          'A one-paste .pls playlist for hardware/software players (Sonos, VLC, ' +
          'car receivers). Wraps the always-served MP3 mount first, appending any ' +
          'enabled optional mounts. Returns audio/x-scpls text.',
        auth: 'none',
        responseExample: '[playlist]\nNumberOfEntries=1\nFile1=https://radio.example.com/stream.mp3\nTitle1=SUB/WAVE\n',
      },
      {
        method: 'GET',
        path: '/listen.m3u',
        summary: 'M3U tune-in file',
        description:
          'The M3U counterpart to /listen.pls — the same mount list as an .m3u ' +
          'playlist for players that prefer it.',
        auth: 'none',
        responseExample: '#EXTM3U\n#EXTINF:-1,SUB/WAVE\nhttps://radio.example.com/stream.mp3\n',
      },
    ],
  },
  {
    id: 'requests',
    label: 'Listener Requests',
    blurb:
      'The public request path — the same endpoint the listener request drawer ' +
      'hits. Submit a free-text request; the booth interprets it, picks a track, ' +
      'and you poll for the outcome. Rate-limited per IP.',
    endpoints: [
      {
        method: 'POST',
        path: '/request',
        summary: 'Submit a song request',
        description:
          'Submit a free-text request ("something slower", "play some Bowie"). ' +
          'Returns a 202 receipt with a requestId immediately; the booth resolves ' +
          'it asynchronously. Poll GET /request/:id for the result. Rate-limited ' +
          'and paused when nobody is listening.',
        auth: 'none',
        mutatesAir: true,
        bodyExample: { text: 'something slower than this', name: 'alex' },
        responseExample: { success: true, requestId: '4f3c…', status: 'pending' },
      },
      {
        method: 'GET',
        path: '/request/:id',
        summary: 'Poll a request outcome',
        description:
          'Poll the outcome of a submitted request. Status walks pending → ' +
          'resolved | rejected | failed. When resolved, carries the matched track ' +
          'and its queue position. 404 (status "unknown") means stop polling.',
        auth: 'none',
        pathParams: [{ name: 'id', required: true, description: 'requestId from POST /request', example: '4f3c…' }],
        responseExample: {
          status: 'resolved',
          success: true,
          ack: 'Cooling it down — here\'s Jon Hopkins.',
          track: { title: 'Open Eye Signal', artist: 'Jon Hopkins' },
          queuePosition: 1,
          message: null,
        },
      },
    ],
  },
  {
    id: 'dj-control',
    label: 'DJ Control',
    blurb:
      'Admin-gated operator actions that drive the live broadcast: make the DJ ' +
      'speak, fire a segment or skill, queue an exact track, skip, or rebuild the ' +
      'fallback playlist. These are the surface the MCP server wraps.',
    endpoints: [
      {
        method: 'POST',
        path: '/dj/say',
        summary: 'Make the DJ speak',
        description:
          'Speak text on air now. mode "raw" reads it verbatim; mode "styled" runs ' +
          'it through the DJ voice first. Optional `sfx` plays a stinger under the ' +
          'voice. Heavy-ducked over the music.',
        auth: 'admin',
        mutatesAir: true,
        bodyExample: { text: 'Locked in on the frequency — more after this.', mode: 'raw', kind: 'dj-speak' },
        responseExample: { ok: true, mode: 'raw', kind: 'dj-speak', spoken: 'Locked in on the frequency — more after this.', sfx: null },
      },
      {
        method: 'POST',
        path: '/dj/segment',
        summary: 'Fire a voice segment',
        description:
          'Trigger a canned segment on demand: station-id, hourly, link, banter, ' +
          'or the programme-intro/feature/outro beats. Show-bound segments need ' +
          'the matching show on air. Bypasses the frequency/budget gates — an ' +
          'explicit operator press always fires.',
        auth: 'admin',
        mutatesAir: true,
        bodyExample: { type: 'station-id' },
        responseExample: { ok: true, type: 'station-id', spoken: 'You\'re locked into SUB/WAVE.' },
      },
      {
        method: 'POST',
        path: '/dj/skill',
        summary: 'Run a skill segment',
        description:
          'Run a named between-track skill (weather, news, curiosity, a custom ' +
          'skill, …) on demand. The segment director gathers real data and the DJ ' +
          'reads it on air.',
        auth: 'admin',
        mutatesAir: true,
        bodyExample: { name: 'weather' },
        responseExample: { ok: true, name: 'weather', spoken: 'Clear and cool over London tonight...' },
      },
      {
        method: 'POST',
        path: '/dj/skip',
        summary: 'Skip the current track',
        description:
          'Force-end the current track (operator override). There is no ' +
          'listener-facing skip by design — this is admin-only.',
        auth: 'admin',
        mutatesAir: true,
        responseExample: { ok: true },
      },
      {
        method: 'POST',
        path: '/dj/queue-track',
        summary: 'Queue an exact track',
        description:
          'Push a specific track (an id + title from /dj/search or /dj/recent) to ' +
          'the queue. No DJ intro is generated. Bypasses the dedup guard, so a ' +
          'deliberate manual queue always fires.',
        auth: 'admin',
        mutatesAir: true,
        bodyExample: { id: 'a1b2c3', title: 'Open Eye Signal', artist: 'Jon Hopkins', album: 'Immunity' },
        responseExample: { ok: true, queuePosition: 2, track: { title: 'Open Eye Signal', artist: 'Jon Hopkins' } },
      },
      {
        method: 'POST',
        path: '/dj/refresh-playlist',
        summary: 'Rebuild fallback playlist',
        description:
          'Rebuild the Liquidsoap fallback auto-playlist for the current mood now, ' +
          'instead of waiting for the scheduled refresh. Does not interrupt the ' +
          'current track.',
        auth: 'admin',
        responseExample: { ok: true },
      },
      {
        method: 'GET',
        path: '/dj/search',
        summary: 'Search the library',
        description:
          'Search the music library by title/artist/album terms. Returns up to 12 ' +
          'queue-ready tracks (id, title, artist, album, year, genre, duration, ' +
          'stored moods/energy). Feed the results into /dj/queue-track.',
        auth: 'admin',
        queryParams: [{ name: 'q', required: true, description: 'Search terms', example: 'jon hopkins' }],
        responseExample: {
          results: [
            { id: 'a1b2c3', title: 'Open Eye Signal', artist: 'Jon Hopkins', album: 'Immunity', year: 2013, genre: 'Electronic', duration: 468, moods: ['hypnotic'], energy: 0.6 },
          ],
        },
      },
      {
        method: 'GET',
        path: '/dj/recent',
        summary: 'Recently added tracks',
        description:
          'The most recently added tracks, expanded from the newest albums and ' +
          'flattened into queue-ready /dj/search-shaped objects.',
        auth: 'admin',
        queryParams: [{ name: 'limit', description: 'How many tracks (1–50, default 20)', example: 20 }],
        responseExample: {
          results: [{ id: 'd4e5f6', title: 'Tape Loop', artist: 'Morcheeba', album: 'Big Calm', year: 1998 }],
        },
      },
      {
        method: 'GET',
        path: '/dj/playlists',
        summary: 'Navidrome playlists',
        description:
          'The operator\'s Navidrome playlists (id, name, songCount) — used by the ' +
          'show editor\'s playlist-anchor picker.',
        auth: 'admin',
        responseExample: { results: [{ id: 'pl-42', name: 'Late Night', songCount: 84 }] },
      },
    ],
  },
  {
    id: 'skills-sfx',
    label: 'Skills & Sound Effects',
    blurb:
      'List the DJ\'s skill segments and sound-effect stingers, and trigger a ' +
      'stinger on air. Admin-gated.',
    endpoints: [
      {
        method: 'GET',
        path: '/dj/skills',
        summary: 'List skill segments',
        description:
          'The DJ\'s between-track skill catalogue — the built-ins (weather, news, ' +
          'traffic, curiosity, …) plus any custom skills, with their labels and ' +
          'cooldowns. Names feed POST /dj/skill.',
        auth: 'admin',
        responseExample: { skills: [{ kind: 'weather', label: 'Weather', cooldownMin: 60 }, { kind: 'news', label: 'News', cooldownMin: 90 }] },
      },
      {
        method: 'GET',
        path: '/sfx',
        summary: 'List sound effects',
        description:
          'The sound-effect stinger library (name + description) plus whether the ' +
          'generator (ElevenLabs) is configured. Names feed POST /sfx/:name/play.',
        auth: 'admin',
        responseExample: { sfx: [{ name: 'whoosh', description: 'transition whoosh' }], generatorReady: true },
      },
      {
        method: 'POST',
        path: '/sfx/:name/play',
        summary: 'Play a sound effect',
        description:
          'Play a named stinger on air now, ducked under any voice. 400 if the ' +
          'name is unknown.',
        auth: 'admin',
        mutatesAir: true,
        pathParams: [{ name: 'name', required: true, description: 'Sound-effect name from GET /sfx', example: 'whoosh' }],
        responseExample: { ok: true },
      },
    ],
  },
  {
    id: 'insight',
    label: 'Stats & Listeners',
    blurb:
      'Admin-gated operational reads: LLM/TTS/request rollups and live listener ' +
      'detail. Useful for monitoring dashboards and automations.',
    endpoints: [
      {
        method: 'GET',
        path: '/stats',
        summary: 'Station stats rollup',
        description:
          'LLM call summary (provider, model, latency, daily token budget), TTS ' +
          'summary, DJ-log rollup, and request stats. The data behind the admin ' +
          'Dash and Stats pages.',
        auth: 'admin',
        responseExample: {
          t: '2026-07-07T20:00:00.000Z',
          llm: { provider: 'ollama', activeModel: 'llama3.1:8b', calls: 42, budget: { enabled: false } },
          tts: { calls: 88, engine: 'piper' },
          requests: { total: 12, resolved: 9 },
        },
      },
      {
        method: 'GET',
        path: '/listeners',
        summary: 'Listener history',
        description:
          'Current listener count plus a time-series of samples over the requested ' +
          'window (sinceMinutes, capped at one week) and total bytes served. Powers ' +
          'the listener sparkline.',
        auth: 'admin',
        queryParams: [{ name: 'sinceMinutes', description: 'Window in minutes (5 … 10080, default 1440)', example: 1440 }],
        responseExample: {
          current: 3,
          sinceMinutes: 1440,
          bytes: 1048576,
          samples: [{ t: 1720000000000, listeners: 2 }],
        },
      },
      {
        method: 'GET',
        path: '/listeners/connections',
        summary: 'Live listener connections',
        description:
          'Per-listener detail (IP, mount, user-agent, connected-for) read from ' +
          'Icecast\'s admin interface, deduped by IP+UA. 502 if Icecast admin is ' +
          'unreachable.',
        auth: 'admin',
        responseExample: {
          count: 1,
          connections: [{ ip: '203.0.113.7', mount: '/stream.mp3', userAgent: 'Sonos', connectedFor: 3600 }],
        },
      },
    ],
  },
];

export const ENDPOINTS: EndpointDoc[] = ENDPOINT_GROUPS.flatMap(g => g.endpoints);

// ---------------------------------------------------------------------------
// MCP tools — mirrors mcp-subwave/src/index.ts. Kept here so the Connect page's
// MCP tab renders from the same source as the endpoint docs.
// ---------------------------------------------------------------------------

export const MCP_TOOLS: McpToolDoc[] = [
  { name: 'subwave_health', title: 'Liveness', description: 'Is the station up?', endpoint: 'GET /health', auth: 'none' },
  { name: 'subwave_now_playing', title: 'Now playing', description: 'Current track, station context, listener count.', endpoint: 'GET /now-playing', auth: 'none' },
  { name: 'subwave_station_state', title: 'Queue & history', description: 'Upcoming queue, recent history, DJ booth log.', endpoint: 'GET /state', auth: 'none' },
  { name: 'subwave_schedule', title: 'Schedule', description: 'Personas, shows, and the weekly grid.', endpoint: 'GET /schedule', auth: 'none' },
  { name: 'subwave_session', title: 'DJ session', description: 'Live session identity and recent transcript turns.', endpoint: 'GET /session', auth: 'none' },
  { name: 'subwave_request_song', title: 'Request a song', description: 'Submit a free-text request and poll for the outcome.', endpoint: 'POST /request + GET /request/:id', auth: 'none', mutatesAir: true },
  { name: 'subwave_request_status', title: 'Check a request', description: 'Poll a submitted request by id.', endpoint: 'GET /request/:id', auth: 'none' },
  { name: 'subwave_search_library', title: 'Search library', description: 'Search the music library for queue-ready tracks.', endpoint: 'GET /dj/search', auth: 'admin' },
  { name: 'subwave_queue_track', title: 'Queue an exact track', description: 'Push a specific track to the queue.', endpoint: 'POST /dj/queue-track', auth: 'admin', mutatesAir: true },
  { name: 'subwave_skip_track', title: 'Skip the track', description: 'Force-end the current track.', endpoint: 'POST /dj/skip', auth: 'admin', mutatesAir: true },
  { name: 'subwave_dj_announce', title: 'DJ announce', description: 'Make the DJ speak text on air.', endpoint: 'POST /dj/say', auth: 'admin', mutatesAir: true },
  { name: 'subwave_dj_segment', title: 'DJ segment', description: 'Fire a canned voice segment.', endpoint: 'POST /dj/segment', auth: 'admin', mutatesAir: true },
  { name: 'subwave_list_skills', title: 'List skills', description: 'The DJ\'s skill-segment catalogue.', endpoint: 'GET /dj/skills', auth: 'admin' },
  { name: 'subwave_run_skill', title: 'Run a skill', description: 'Run a named skill segment on air.', endpoint: 'POST /dj/skill', auth: 'admin', mutatesAir: true },
  { name: 'subwave_list_sfx', title: 'List sound effects', description: 'The sound-effect stinger library.', endpoint: 'GET /sfx', auth: 'admin' },
  { name: 'subwave_play_sfx', title: 'Play a sound effect', description: 'Play a stinger on air now.', endpoint: 'POST /sfx/:name/play', auth: 'admin', mutatesAir: true },
  { name: 'subwave_refresh_playlist', title: 'Refresh playlist', description: 'Rebuild the fallback auto-playlist.', endpoint: 'POST /dj/refresh-playlist', auth: 'admin' },
];

// ---------------------------------------------------------------------------
// Stream mounts — static descriptors. Live enabled state is resolved from
// settings in routes/connect.ts (the flags here name which setting gates each).
// ---------------------------------------------------------------------------

export const STREAM_MOUNTS: StreamMountDoc[] = [
  {
    mount: '/stream.mp3',
    format: 'MP3',
    codec: 'mp3',
    description:
      'The universal floor — always served. Every player can decode it: Sonos, ' +
      'hardware radios, car receivers, browsers. Point any client here first.',
    settingFlag: null,
    alwaysOn: true,
  },
  {
    mount: '/stream.opus',
    format: 'Ogg Opus',
    codec: 'opus',
    description:
      'Low-bitrate, high-quality Opus at 48kHz. Enable in Settings → Streams. ' +
      'Chromium-based browsers upgrade to it automatically; iOS/Firefox stay on MP3.',
    settingFlag: 'opusEnabled',
    alwaysOn: false,
  },
  {
    mount: '/stream.flac',
    format: 'Ogg FLAC',
    codec: 'flac',
    description:
      'Lossless capture of the processed bus at 44.1kHz. Enable in Settings → ' +
      'Streams. For external players — the web/native players do not auto-select it.',
    settingFlag: 'flacEnabled',
    alwaysOn: false,
  },
  {
    mount: '/stream.aac',
    format: 'AAC (ADTS)',
    codec: 'aac',
    description:
      'AAC-LC at 44.1kHz, served as audio/aac. Enable in Settings → Streams. For ' +
      'external players that prefer AAC.',
    settingFlag: 'aacEnabled',
    alwaysOn: false,
  },
];

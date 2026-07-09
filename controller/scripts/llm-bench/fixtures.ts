// Shared synthetic fixtures for the llm-bench harness — everything external
// to the model call is faked here (library, candidates, context, personas,
// segment data, sfx catalogue, tools) so runs are deterministic and touch
// neither Navidrome nor the live station. The prompts and schemas themselves
// are NEVER faked — kind modules import the live builders from src/.

import { z } from 'zod';
import { tool } from 'ai';

// --- Synthetic library (same 20 songs as picker-test.mjs) ------------------

export const LIBRARY = [
  { id: 'aaaa1111bbbb2222cccc01', title: 'Late Drive', artist: 'Tegi Pannu', album: 'Drive', year: 2024, genre: 'punjabi' },
  { id: 'aaaa1111bbbb2222cccc02', title: 'Cold Start', artist: 'Sidhu Moose Wala', album: 'Moosetape', year: 2023, genre: 'punjabi' },
  { id: 'aaaa1111bbbb2222cccc03', title: 'Slow Lane', artist: 'AP Dhillon', album: 'Two Hearts', year: 2025, genre: 'punjabi' },
  { id: 'aaaa1111bbbb2222cccc04', title: 'Night Tape', artist: 'Karan Aujla', album: 'Making Memories', year: 2024, genre: 'punjabi' },
  { id: 'aaaa1111bbbb2222cccc05', title: 'Glow Up', artist: 'Diljit Dosanjh', album: 'Ghost', year: 2024, genre: 'punjabi' },
  { id: 'aaaa1111bbbb2222cccc06', title: 'After Hours', artist: 'DIVINE', album: 'Punya Paap', year: 2024, genre: 'hip-hop' },
  { id: 'aaaa1111bbbb2222cccc07', title: 'Static', artist: 'Prabh Deep', album: 'KSHMR', year: 2023, genre: 'hip-hop' },
  { id: 'aaaa1111bbbb2222cccc08', title: 'Low Tide', artist: 'Talwiinder', album: 'Romantic', year: 2024, genre: 'r&b' },
  { id: 'aaaa1111bbbb2222cccc09', title: 'Soft Open', artist: 'Hanumankind', album: 'Big Dawgs', year: 2025, genre: 'hip-hop' },
  { id: 'aaaa1111bbbb2222cccc10', title: 'Slow Cuts', artist: 'Seedhe Maut', album: 'Lunch Break', year: 2024, genre: 'hip-hop' },
  { id: 'aaaa1111bbbb2222cccc11', title: 'Window Down', artist: 'Yo Yo Honey Singh', album: 'GLORY', year: 2025, genre: 'pop' },
  { id: 'aaaa1111bbbb2222cccc12', title: 'Long Way', artist: 'Manni Sandhu', album: 'Productions', year: 2024, genre: 'punjabi' },
  { id: 'aaaa1111bbbb2222cccc13', title: 'Inside Voice', artist: 'Sikander Kahlon', album: 'Sik World', year: 2024, genre: 'hip-hop' },
  { id: 'aaaa1111bbbb2222cccc14', title: 'Easy Wins', artist: 'Bohemia', album: 'Pesa Nasha Pyar', year: 2023, genre: 'hip-hop' },
  { id: 'aaaa1111bbbb2222cccc15', title: 'Mid-Set', artist: 'Fateh', album: 'Bring it Home', year: 2024, genre: 'hip-hop' },
  { id: 'aaaa1111bbbb2222cccc16', title: 'Open Mic', artist: 'Raja Kumari', album: 'The Bridge', year: 2024, genre: 'hip-hop' },
  { id: 'aaaa1111bbbb2222cccc17', title: 'Trim', artist: 'Mohitveer', album: 'Single', year: 2025, genre: 'punjabi' },
  { id: 'aaaa1111bbbb2222cccc18', title: 'Dust Road', artist: 'Arjan Dhillon', album: 'Saroor', year: 2024, genre: 'punjabi' },
  { id: 'aaaa1111bbbb2222cccc19', title: 'Quiet Room', artist: 'Hustinder', album: 'Karam', year: 2024, genre: 'punjabi' },
  { id: 'aaaa1111bbbb2222cccc20', title: 'Held Note', artist: 'Bir Singh', album: 'Live Sessions', year: 2024, genre: 'punjabi' },
];

// --- Context / cast / show --------------------------------------------------

export function benchContext(overrides: any = {}) {
  return {
    date: { dayLabel: 'Thursday', dayOfMonth: 9, monthLabel: 'July', season: 'summer' },
    clock: { hhmm: '16:30', isDark: false, isWeekend: false, isLateNight: false, isCommute: false },
    time: { period: 'afternoon', vibe: 'sustained energy' },
    weather: { location: 'Punjab', condition: 'rainy', temp: 33, tempUnit: 'C' },
    festival: null,
    dominantMood: 'driving',
    listeners: { count: 2 },
    ...overrides,
  };
}

export const HOST = {
  id: 'p_bench_host', name: 'Jagga',
  soul: 'the gravel-voiced road-philosopher; calm, weathered, a little mythic; lets the low end do half the talking',
  scriptLength: 'standard',
};

export const GUESTS = [
  { id: 'p_bench_g1', name: 'Jazz', soul: 'sarcastic vinyl obsessive with Opinions; gatekeeper-funny, never mean' },
  { id: 'p_bench_g2', name: 'Saaya', soul: 'low, hypnotic, unhurried; the voice that walks the station into the dark' },
];

export const SHOW = {
  name: 'The Long Road',
  topic: 'Drive-time at dusk — downtempo, bass and headlights, motorway tall tales for the hour the traffic thins out.',
  moods: ['driving'],
};

// --- Candidate sets for the pool picker -------------------------------------

const CAMELOT = ['8A', '9A', '10A', '8B', '7A', '9B', '6A', '11A', '5A', '10B'];

export function candidateSet(shape: 'baseline' | 'analysed' | 'same-artist-trap' | 'big') {
  const src = (s: any, source: string, extra: any = {}) => ({ ...s, moods: ['driving'], energy: 'medium', source, ...extra });
  if (shape === 'baseline') {
    return LIBRARY.slice(0, 10).map((s, i) => src(s, i < 5 ? 'similar' : 'mood-library'));
  }
  if (shape === 'analysed') {
    return LIBRARY.slice(0, 10).map((s, i) => src(s, 'audio-similar', {
      bpm: 88 + i * 4, key: CAMELOT[i], pace: 0.3 + i * 0.05,
      sections: 3 + (i % 4), instrumental: i % 5 === 0, similarity: 0.9 - i * 0.04,
    }));
  }
  if (shape === 'same-artist-trap') {
    // 9 candidates by the artist who just played twice, 1 by someone else —
    // measures whether the model follows the VARIETY criterion under pressure.
    const trap = LIBRARY.slice(0, 9).map((s, i) => src({ ...s, artist: 'Sidhu Moose Wala' }, 'similar'));
    return [...trap, src(LIBRARY[10], 'random')];
  }
  // big — the full pool-cap of 18
  return LIBRARY.slice(0, 18).map((s, i) => src(s, ['similar', 'mood-library', 'recent', 'frequent', 'starred', 'random'][i % 6]));
}

export const TRAP_ARTIST = 'Sidhu Moose Wala';

export function recentPlays() {
  return [
    { title: 'Wass Good', artist: 'Pawan Dhanda', moods: ['driving'], energy: 'high' },
    { title: '295', artist: TRAP_ARTIST, moods: ['driving'], energy: 'medium' },
    { title: 'The Last Ride', artist: TRAP_ARTIST, moods: ['night'], energy: 'medium' },
  ];
}

export const TRANSITIONS = ['normal', 'blend', 'sweep', 'washout', 'dissolve', 'chop', 'loop'];

// --- Synthetic discovery tools for the agent paths (picker-test port) -------

export function pickerToolsSynthetic() {
  const seen = new Map<string, any>();
  const wrap = (songs: any[]) => {
    for (const s of songs) seen.set(s.id, s);
    return songs.map(s => ({ id: s.id, title: s.title, artist: s.artist, album: s.album, year: s.year, genre: s.genre }));
  };
  const tools: any = {
    searchLibrary: tool({
      description: 'Search the music library by artist name, song title, or real genre (e.g. "jazz", "punjabi"). Returns matching songs.',
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }: any) => {
        const q = String(query || '').toLowerCase();
        const hits = LIBRARY.filter(s =>
          s.title.toLowerCase().includes(q) || s.artist.toLowerCase().includes(q) || s.genre.toLowerCase().includes(q));
        return wrap(hits.length ? hits.slice(0, 6) : LIBRARY.slice(0, 6));
      },
    }),
    similarSongs: tool({
      description: 'Find songs similar to a given song id. Pass the currently-playing song id to keep the flow going.',
      inputSchema: z.object({ songId: z.string() }),
      execute: async () => wrap(LIBRARY.slice(5, 11)),
    }),
    topSongsByArtist: tool({
      description: 'Top songs for a named artist.',
      inputSchema: z.object({ artist: z.string() }),
      execute: async ({ artist }: any) => {
        const q = String(artist || '').toLowerCase();
        const hits = LIBRARY.filter(s => s.artist.toLowerCase().includes(q));
        return wrap(hits.length ? hits : LIBRARY.slice(8, 13));
      },
    }),
    tracksByMood: tool({
      description: 'Songs tagged with a mood: energetic, calm, reflective, celebratory, romantic, spiritual, focus, workout, driving, cooking, rainy, sunny, night, morning, evening, festival, cultural.',
      inputSchema: z.object({ mood: z.string() }),
      execute: async () => wrap(LIBRARY.slice(2, 9)),
    }),
    recentlyAdded: tool({
      description: 'A sample of tracks from recently-added albums.',
      inputSchema: z.object({}),
      execute: async () => wrap(LIBRARY.slice(12, 18)),
    }),
    starredSongs: tool({
      description: "The operator's starred / favourite songs — always a safe pick.",
      inputSchema: z.object({}),
      execute: async () => wrap(LIBRARY.slice(0, 5)),
    }),
    randomSongs: tool({
      description: 'A random sample of songs from the library.',
      inputSchema: z.object({}),
      execute: async () => wrap(LIBRARY.slice(7, 14)),
    }),
  };
  return { tools, seen };
}

// Sterile short pick context and the long-session shape, both ported from
// picker-test.mjs so djAgentPick results stay comparable with historical runs.
export function pickMessagesShort() {
  return [
    { role: 'user', content: '▶ "Sona" by Manni Sandhu & Bakshi Billa' },
    { role: 'assistant', content: 'Sona, flowing from Tegi Pannu — kept the after-hours register, different artist.' },
    { role: 'user', content: '▶ "Hanju" by Amrinder Gill\nNow playing "Hanju" by Amrinder Gill (after "Sona" by Manni Sandhu). Pick the track to play next. Stay silent — no link this time.' },
  ];
}

export function pickMessagesLong() {
  return [
    {
      role: 'user',
      content: 'Now playing "Hanju" by Amrinder Gill (after "Long Way — Manni Sandhu"). Pick the track to play next. Stay silent — no link this time.',
    },
  ];
}

export function requestMessages(requestText: string, requester = 'bench') {
  return [
    { role: 'user', content: '▶ "Hanju" by Amrinder Gill' },
    { role: 'assistant', content: 'Easing through the afternoon with Amrinder Gill.' },
    {
      role: 'user',
      content: `The request to resolve now — listener "${requester}" asks: "${requestText}" (currently playing "Hanju" by Amrinder Gill [id: aaaa1111bbbb2222cccc12])`,
    },
  ];
}

// --- Segment fixtures --------------------------------------------------------

export const WEATHER_FRESH = {
  available: true, location: 'Punjab', condition: 'rainy', temp: 33, tempUnit: 'C', changedSinceLastMention: true,
};
export const WEATHER_DULL = {
  available: true, location: 'Punjab', condition: 'clear', temp: 31, tempUnit: 'C', changedSinceLastMention: false,
};
export const NEWS_DATA = {
  feed: 'BBC World',
  items: [
    { title: 'Monsoon arrives early across north India', summary: 'Heavy rain a week ahead of schedule.' },
    { title: 'Vinyl sales outpace CDs for the third year', summary: 'Independent stores drive the growth.' },
    { title: 'New motorway section opens near Ludhiana', summary: 'Cuts the bypass commute by twenty minutes.' },
  ],
};

export const SFX_CATALOG = [
  { name: 'record-scratch', durationSec: 1.5, description: 'abrupt vinyl record scratch — punctuates a hard cut or a joke' },
  { name: 'whoosh', durationSec: 1.2, description: 'a quick transitional whoosh' },
  { name: 'drum-roll', durationSec: 2.5, description: 'a short drum roll — builds anticipation before a reveal' },
];

// Capability fixtures shaped like skills/loader.js caps — toolFn returns the
// canned payload so both the tool-loop director and fetchSegmentData see the
// same data a real skill would produce.
export function weatherCap(data: any = WEATHER_FRESH) {
  return {
    kind: 'weather', skill: 'weather', label: 'Weather', cooldownMs: 0, seeded: true,
    desc: 'A short weather check, in character — one or two sentences. Only worth airing when conditions have genuinely changed.',
    contextFields: ['date', 'clock', 'time', 'weather'],
    toolName: 'getWeather', toolDesc: 'Current weather conditions for the station location.',
    toolFn: async () => data,
    config: {},
  };
}

export function newsCap(data: any = NEWS_DATA) {
  return {
    kind: 'news', skill: 'news', label: 'News', cooldownMs: 0, seeded: true,
    desc: 'One story from the feed worth a listener\'s attention, retold in the DJ voice in a sentence or two — never read headlines verbatim, never do a bulletin.',
    contextFields: ['date', 'clock', 'time'],
    toolName: 'getNews', toolDesc: 'Latest headlines from the configured feed.',
    toolFn: async () => data,
    config: {},
  };
}

export function freshSegmentState() {
  return {
    seenHeadlines: new Set<string>(),
    lastWeatherCondition: null,
    lastSearchedArtist: null,
    lastAnySegment: 0,
  };
}

// --- Misc --------------------------------------------------------------------

export const RECENT_OPENERS = [
  "Sky's finally breaking over Punjab, thirty-three degrees",
  'Saaya on SUB/WAVE, a small steady halo',
  'The road empties out about now',
];

export const CURRENT_TRACK = { title: 'Hanju', artist: 'Amrinder Gill', album: 'Judaa 3', year: 2021 };
export const PREVIOUS_TRACK = { title: 'Long Way', artist: 'Manni Sandhu', album: 'Productions', year: 2024 };

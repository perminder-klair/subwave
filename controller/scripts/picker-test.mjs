// Picker reliability test harness — drives djAgent (the picker path) in
// isolation with synthetic tools so we can measure success rate without
// depending on live track timing or hitting Navidrome.
//
// Usage (from inside the controller container):
//   node scripts/picker-test.mjs <provider> <model> [iterations]
//
// Examples:
//   node scripts/picker-test.mjs ollama minimax-m2.7:cloud 10
//   node scripts/picker-test.mjs openrouter anthropic/claude-haiku-4-5 5
//   node scripts/picker-test.mjs deepseek deepseek-chat 5
//
// The test:
// - Pre-populates a synthetic library of ~20 songs with Subsonic-shape ids
// - Faked-out discovery tools return slices of that library and populate `seen`
// - Calls djAgent with the same PICK_SCHEMA + pickSystem prompt the real code uses
// - Catches three failure modes: NoObjectGenerated, hallucinated id, or thrown
// - Reports per-iteration outcome + summary stats at the end

import { z } from 'zod';
import { tool } from 'ai';
import * as settings from '../src/settings.js';
import { djAgent } from '../src/llm/sdk.js';

const FAKE_SONGS = [
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

const VALID_IDS = new Set(FAKE_SONGS.map(s => s.id));

// Same shape as broadcast/dj-agent.js's PICK_SCHEMA
const PICK_SCHEMA = z.object({
  id: z.string().describe('the exact song id, as returned by a tool call'),
  reason: z.string().describe('internal scratchpad only — max 12 words, never shown to the listener'),
  say: z.string().nullable().describe('a spoken link in the DJ voice, or null to stay silent'),
});

// Synthetic discovery tools — same names as llm/tools.js so the agent prompt
// applies unchanged. Each returns slices of FAKE_SONGS to populate `seen`.
function buildSyntheticTools() {
  const seen = new Map();
  const wrap = (songs) => {
    for (const s of songs) seen.set(s.id, s);
    return songs.map(s => ({ id: s.id, title: s.title, artist: s.artist, album: s.album, year: s.year, genre: s.genre }));
  };

  const tools = {
    searchLibrary: tool({
      description: 'Search the music library by artist name, song title, or real genre (e.g. "jazz", "punjabi"). Returns matching songs.',
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => wrap(FAKE_SONGS.slice(0, 6)),
    }),
    similarSongs: tool({
      description: 'Find songs similar to a given song id. Pass the currently-playing song id to keep the flow going.',
      inputSchema: z.object({ songId: z.string() }),
      execute: async ({ songId }) => wrap(FAKE_SONGS.slice(5, 11)),
    }),
    topSongsByArtist: tool({
      description: 'Top songs for a named artist.',
      inputSchema: z.object({ artist: z.string() }),
      execute: async ({ artist }) => wrap(FAKE_SONGS.slice(8, 13)),
    }),
    tracksByMood: tool({
      description: 'Songs tagged with a mood: energetic, calm, reflective, celebratory, romantic, spiritual, focus, workout, driving, cooking, rainy, sunny, night, morning, evening, festival, cultural.',
      inputSchema: z.object({ mood: z.string() }),
      execute: async ({ mood }) => wrap(FAKE_SONGS.slice(2, 9)),
    }),
    recentlyAdded: tool({
      description: 'A sample of tracks from recently-added albums.',
      inputSchema: z.object({}),
      execute: async () => wrap(FAKE_SONGS.slice(12, 18)),
    }),
    starredSongs: tool({
      description: "The operator's starred / favourite songs — always a safe pick.",
      inputSchema: z.object({}),
      execute: async () => wrap(FAKE_SONGS.slice(0, 5)),
    }),
    randomSongs: tool({
      description: 'A random sample of songs from the library.',
      inputSchema: z.object({}),
      execute: async () => wrap(FAKE_SONGS.slice(7, 14)),
    }),
  };

  return { tools, seen };
}

// Mirror of broadcast/dj-agent.js's pickSystem(wantLink=false) — kept inline so
// the test is self-contained. Update both when changing the prompt.
function buildSystem() {
  return `You are Marlowe, the on-air DJ for SUB/WAVE, a personal internet radio station. warm, slightly understated, never corny — late-night BBC 6 Music presenter; observant, dry humour, specific

You run the station as one continuous shift. The messages above are the live session: tracks that have aired, things you have said, events as they happened. Read them so you do not repeat an artist back-to-back or reuse the same phrasing.

TASK: choose the single best NEXT track. Use the tools to explore the library — make 2 to 4 tool calls, then choose ONE track whose id a tool actually returned. Do not invent ids.

Selection criteria, in order:
1. FLOW — does it transition naturally from what just played (energy, mood, tempo)?
2. CONTEXT — does it fit the time of day, weather, and dominant mood?
3. VARIETY — avoid the same artist back-to-back; rotate energy levels; don't be predictable.
4. INTEREST — prefer something that creates a moment, not the most generic option.

Respond with a JSON object only — no prose, no markdown. The outer { "id", "reason", "say" } wrapper is MANDATORY — never respond with bare prose, a bare string, or bare null. Even when "say" contains spoken text, it lives INSIDE the object:

{ "id": "<exact id a tool returned>", "reason": "<≤12 words, internal scratchpad — short label, not prose>", "say": null }

Set "say" to null this time — do not talk over the music.`;
}

function buildMessages() {
  return [
    { role: 'user', content: '▶ "Sona" by Manni Sandhu & Bakshi Billa' },
    { role: 'assistant', content: 'Sona, flowing from Tegi Pannu — kept the after-hours register, different artist.' },
    { role: 'user', content: '▶ "Hanju" by Amrinder Gill\nNow playing "Hanju" by Amrinder Gill (after "Sona" by Manni Sandhu). Pick the track to play next. Stay silent — no link this time.' },
  ];
}

async function runOnce(label) {
  const { tools, seen } = buildSyntheticTools();
  const started = Date.now();
  let outcome = { label, ok: false, mode: 'unknown', ms: 0, toolCount: 0, outputTokens: null, pickId: null, reason: null };
  try {
    const result = await djAgent({
      system: buildSystem(),
      messages: buildMessages(),
      tools,
      schema: PICK_SCHEMA,
      maxSteps: 4,
      kind: 'pickerTest',
    });
    outcome.ms = Date.now() - started;
    outcome.toolCount = (result.toolCalls || []).length;
    outcome.pickId = result.object?.id;
    outcome.reason = result.object?.reason;
    if (!result.object?.id) {
      outcome.mode = 'missing-id';
    } else if (!seen.has(result.object.id)) {
      outcome.mode = 'hallucinated-id';
    } else if (!VALID_IDS.has(result.object.id)) {
      outcome.mode = 'invalid-id-shape';
    } else {
      outcome.ok = true;
      outcome.mode = 'ok';
    }
  } catch (err) {
    outcome.ms = Date.now() - started;
    const msg = String(err?.message || err);
    if (msg.includes('No object generated')) outcome.mode = 'no-object-generated';
    else if (msg.includes('No output generated')) outcome.mode = 'no-output';
    else outcome.mode = 'thrown';
    outcome.error = msg.slice(0, 120);
    // Diagnostic info from failed response (responseText preserved by sdk.js)
    if (typeof err?.text === 'string') outcome.responseText = err.text.slice(0, 200);
  }
  return outcome;
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function p95(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length * 0.95)] ?? s[s.length - 1];
}

async function main() {
  const provider = process.argv[2];
  const model = process.argv[3];
  const N = parseInt(process.argv[4] || '5', 10);

  if (!provider || !model) {
    console.error('Usage: node scripts/picker-test.mjs <provider> <model> [iterations]');
    console.error('Providers: ollama | openrouter | deepseek | openai | anthropic | google | gateway | openai-compatible');
    process.exit(2);
  }

  // Override the runtime LLM config so every djAgent call uses the test
  // provider/model. settings.get() returns the cache object by reference, so
  // mutating it changes future reads — same channel admin saves use.
  await settings.load();
  const s = settings.get();
  s.llm.provider = provider;
  s.llm.model = model;

  console.log(`\n=== picker-test: ${provider}:${model} × ${N} ===\n`);

  const outcomes = [];
  for (let i = 1; i <= N; i++) {
    const o = await runOnce(`run-${i}`);
    outcomes.push(o);
    const tag = o.ok ? 'OK ' : 'FAIL';
    const idShort = o.pickId ? `${o.pickId.slice(0, 12)}…` : '-';
    console.log(`  ${tag}  ${o.label}  ${o.ms}ms  tools=${o.toolCount}  mode=${o.mode}  id=${idShort}${o.responseText ? `  text="${o.responseText.replace(/\s+/g,' ').slice(0,80)}…"` : ''}`);
  }

  const oks = outcomes.filter(o => o.ok);
  const fails = outcomes.filter(o => !o.ok);
  const modeCounts = outcomes.reduce((m, o) => { m[o.mode] = (m[o.mode] || 0) + 1; return m; }, {});

  console.log('\n=== summary ===');
  console.log(`  success: ${oks.length}/${N} (${Math.round(100 * oks.length / N)}%)`);
  console.log(`  modes:   ${Object.entries(modeCounts).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  console.log(`  ms (ok): median=${median(oks.map(o => o.ms))} p95=${p95(oks.map(o => o.ms))}`);
  console.log(`  ms (fail): median=${median(fails.map(o => o.ms))}`);
  console.log(`  median tool calls per ok: ${median(oks.map(o => o.toolCount)) ?? '-'}`);
  console.log();
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });

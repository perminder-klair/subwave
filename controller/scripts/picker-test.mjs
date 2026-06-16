// Picker reliability test harness — drives djAgent (the picker path) in
// isolation with synthetic tools so we can measure success rate without
// depending on live track timing or hitting Navidrome.
//
// Usage (from inside the controller container):
//   node scripts/picker-test.mjs <provider> <model> [iterations] [messages]
//
// `messages` (optional): short | long  — default short
//   short → 3 clean turns (sterile baseline)
//   long  → ~30 realistic session turns (matches what session.windowMessages
//           produces in live; useful for catching long-context regressions)
//
// Examples:
//   node scripts/picker-test.mjs ollama minimax-m2.7:cloud 10
//   node scripts/picker-test.mjs google gemini-3.5-flash 5 long
//   node scripts/picker-test.mjs deepseek deepseek-chat 5 long
//
// The test:
// - Pre-populates a synthetic library of ~20 songs with Subsonic-shape ids
// - Faked-out discovery tools return slices of that library and populate `seen`
// - Uses the LIVE pickSystem + PICK_SCHEMA imported from dj-agent.js (so the
//   test stays in sync with whatever prompt cleanups land there)
// - Catches three failure modes: NoObjectGenerated, hallucinated id, or thrown
// - Reports per-iteration outcome + summary stats at the end

import { z } from 'zod';
import { tool } from 'ai';
import * as settings from '../src/settings.js';
import { djAgent } from '../src/llm/sdk.js';
import { pickSystem, PICK_SCHEMA, pickerAgent } from '../src/broadcast/dj-agent.js';

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

// PICK_SCHEMA is imported from dj-agent.js — we use the live one verbatim so
// schema description changes there flow into the test automatically.

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

// Sterile baseline — 3 clean turns. Useful for measuring "best-case" model
// behaviour without long-context distractions.
function buildMessagesShort() {
  return [
    { role: 'user', content: '▶ "Sona" by Manni Sandhu & Bakshi Billa' },
    { role: 'assistant', content: 'Sona, flowing from Tegi Pannu — kept the after-hours register, different artist.' },
    { role: 'user', content: '▶ "Hanju" by Amrinder Gill\nNow playing "Hanju" by Amrinder Gill (after "Sona" by Manni Sandhu). Pick the track to play next. Stay silent — no link this time.' },
  ];
}

// Realistic long context — exactly what session.windowMessages() produces in
// live AFTER all the filters land (scenario / play / old-pick-event drop)
// AND the leading-non-user shift. For a long-running session the agent
// actually receives JUST the current pick event as a single user message —
// older DJ reasons are kept in raw but coalesced into a leading assistant
// turn that the shift then drops (Anthropic requires user-first messages).
// This is what live picks see now; LONG ≈ SHORT after the fix lands.
function buildMessagesLong() {
  return [
    {
      role: 'user',
      content: 'Now playing "Hanju" by Amrinder Gill (after "Long Way — Manni Sandhu"). Pick the track to play next. Stay silent — no link this time.',
    },
  ];
}

// maxSteps / timeoutMs default to the live picker agent's spec so a tuning
// change in dj-agent.ts flows here automatically. Override per-run via
// argv[6] / argv[7].
const TEST_MAX_STEPS = parseInt(process.argv[6] || String(pickerAgent.maxSteps), 10);
const TEST_TIMEOUT_MS = parseInt(process.argv[7] || String(pickerAgent.timeoutMs), 10);

async function runOnce(label, messagesMode) {
  const { tools, seen } = buildSyntheticTools();
  const messages = messagesMode === 'long' ? buildMessagesLong() : buildMessagesShort();
  const started = Date.now();
  let outcome = { label, ok: false, mode: 'unknown', ms: 0, toolCount: 0, outputTokens: null, pickId: null, reason: null };
  try {
    const result = await djAgent({
      system: pickSystem(),  // live prompt, imported from dj-agent.js
      messages,
      tools,
      schema: PICK_SCHEMA,
      // Mirror the live picker call site (dj-agent.js pickViaAgent).
      // maxSteps/timeoutMs overridable via argv for tuning runs.
      maxSteps: TEST_MAX_STEPS,
      timeoutMs: TEST_TIMEOUT_MS,
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
  const messagesMode = (process.argv[5] || 'short').toLowerCase();

  if (!provider || !model || !['short', 'long'].includes(messagesMode)) {
    console.error('Usage: node scripts/picker-test.mjs <provider> <model> [iterations] [short|long]');
    console.error('Providers: ollama | openrouter | deepseek | openai | anthropic | google | gateway | openai-compatible');
    console.error('Messages:  short (3 clean turns) | long (~25 realistic session turns)');
    process.exit(2);
  }

  // Override the runtime LLM config so every djAgent call uses the test
  // provider/model. settings.get() returns the cache object by reference, so
  // mutating it changes future reads — same channel admin saves use.
  await settings.load();
  const s = settings.get();
  s.llm.provider = provider;
  s.llm.model = model;
  // Allow OLLAMA_URL to override the persisted ollamaUrl — running on the host
  // (the only place this harness works, since the container ships compiled
  // dist) the settings value may be a Docker-internal name like
  // host.docker.internal that doesn't resolve off-container.
  if (process.env.OLLAMA_URL) s.llm.ollamaUrl = process.env.OLLAMA_URL;

  console.log(`\n=== picker-test: ${provider}:${model} × ${N} (messages=${messagesMode}) ===\n`);

  const outcomes = [];
  for (let i = 1; i <= N; i++) {
    const o = await runOnce(`run-${i}`, messagesMode);
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

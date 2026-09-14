// Regression coverage for pool/handover clock-policy wiring.
// Runs the exported track-event entrypoint through the real pool picker, real
// temporary library DB, real isolated link writer and real provider adapter.
// Only external Navidrome/model HTTP is faked; no station or paid API is used.
// Run: npm test -- clock-policy-wiring

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-clock-policy-wiring-'));

const settings = await import('../src/settings.js');
const library = await import('../src/music/library.js');
const session = await import('../src/broadcast/session.js');
const { showHandoverContext } = await import('../src/context.js');
const { runTrackEvent } = await import('../src/broadcast/dj-agent.js');

await settings.update({
  djSpeakClock: false,
  llm: {
    provider: 'openai-compatible',
    model: 'fixture-model',
    baseUrl: 'http://127.0.0.1:9/v1',
    pickerAgent: false,
    fallback: { enabled: false },
  },
});

await library.load();
for (let i = 1; i <= 3; i++) {
  library.set(`candidate-${i}`, {
    title: `Candidate ${i}`,
    artist: `Fixture Artist ${i}`,
    album: `Fixture Album ${i}`,
    duration: 240,
    moods: ['calm'],
    energy: 'medium',
  });
}

interface ModelRequest {
  tools?: unknown[];
  messages?: unknown[];
}

const realFetch = globalThis.fetch;
const modelRequests: ModelRequest[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith('http://127.0.0.1:9/')) {
    return new Response(JSON.stringify({ error: 'isolated Navidrome fixture is offline' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }

  const body = JSON.parse(String(init?.body || '{}')) as ModelRequest;
  modelRequests.push(body);
  const toolCall = Array.isArray(body.tools) && body.tools.length > 0;
  const message = toolCall
    ? {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_fixture_pick',
          type: 'function',
          function: {
            name: 'emit',
            arguments: JSON.stringify({ id: 'candidate-1', reason: 'fixture pool pick' }),
          },
        }],
      }
    : { role: 'assistant', content: 'A deterministic fixture link without a spoken time.' };
  return new Response(JSON.stringify({
    id: `chatcmpl-${modelRequests.length}`,
    object: 'chat.completion',
    created: 1,
    model: 'fixture-model',
    choices: [{ index: 0, message, finish_reason: toolCall ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

after(() => {
  globalThis.fetch = realFetch;
  library.shutdown();
});

const now = new Date();
const boundary = new Date(now.getTime() + 10 * 60_000);
const currentShow = {
  id: 'show-current',
  name: 'The Scenic Route',
  persona: { name: 'Marlowe' },
  moods: [], genres: [], eras: [], energies: [], vocals: '',
  playlistIds: [], excludedPlaylistIds: [],
};
const nextShow = {
  id: 'show-next',
  name: 'Lunchtime Rocks',
  persona: { name: 'Wren' },
  moods: [], genres: [], eras: [], energies: [], vocals: '',
  playlistIds: [], excludedPlaylistIds: [],
};
const resolveShow = (at: Date) => at.getTime() < boundary.getTime() ? currentShow : nextShow;
const handover = showHandoverContext(now, resolveShow, [boundary.getTime()]);
assert.ok(handover, 'fixture must resolve an actual final-quarter handover fact');

const queued: Array<Record<string, unknown>> = [];
const logs: unknown[][] = [];
const queue = {
  current: { track: { title: 'On Air Now', artist: '' } },
  history: [],
  log: (...args: unknown[]) => logs.push(args),
  recentlyPlayed: () => ({ ids: new Set<string>(), keys: new Set<string>() }),
  recentlyPlayedByCount: () => ({ ids: new Set<string>(), keys: new Set<string>() }),
  recentArtistsSince: () => new Set<string>(),
  recentAlbumKeys: () => new Set<string>(),
  recentTransitionChoices: () => [],
  getDjRecap: () => null,
  getRecentTracks: () => [],
  getRecentOpeners: () => [],
  getLastLinkText: () => null,
  push: async (item: Record<string, unknown>) => {
    queued.push(item);
    return 0;
  },
};

session.start({
  at: now.toISOString(),
  activeShow: null,
  dominantMood: 'calm',
  time: { period: 'daytime', vibe: 'steady' },
} as Parameters<typeof session.start>[0]);

await runTrackEvent(queue, {
  at: now.toISOString(),
  dominantMood: 'calm',
  date: { iso: now.toISOString().slice(0, 10), dayLabel: 'Thursday' },
  clock: { hhmm: '10:50', display: '10:50 am' },
  time: { period: 'daytime', vibe: 'steady' },
  activeShow: currentShow,
  showHandover: handover,
}, {
  wantLink: true,
  // linkAirDate subtracts the two-minute show-attribution pad; five minutes
  // leaves a valid three-minute runway, above LINK_CLOCK_MIN_RUNWAY_SEC.
  showAt: new Date(Date.now() + 5 * 60_000),
});

const linkRequest = modelRequests.find((body) => !Array.isArray(body.tools) || body.tools.length === 0);
assert.ok(linkRequest, `expected picker + link model requests, got ${modelRequests.length}`);
const linkWire = JSON.stringify(linkRequest.messages ?? []);

test('the real pool path with clock speech disabled does not offer an approximate air time', () => {
  assert.doesNotMatch(linkWire, /Approximate air time:/);
  assert.equal(queued.length, 1, `expected one queued pick; logs=${JSON.stringify(logs)}`);
  assert.equal(queued[0].linkClockAt, null,
    'the existing drift stamp correctly records that clock speech was disabled');
});

test('the real pool handover packet keeps show identity but withholds its start time when clock speech is disabled', () => {
  assert.match(linkWire, /Following show: \\"Lunchtime Rocks\\" with Wren/);
  assert.doesNotMatch(linkWire, new RegExp(String(handover!.nextShow.startsAt).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

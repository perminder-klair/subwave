// Issue #1911: the changeover pick says which show its track airs in.
//
// Under the look-ahead clock the incoming show's first track is picked while
// the live session — and so the whole pick window — still belongs to the
// outgoing show; after #1911 that window even names the outgoing show as "now
// on air". The system prompt carries the incoming brief, but nothing in the
// event turn said this track airs in it. The pick event now
// does, as its last clause, whenever the show the pick is FOR differs from the
// live session's — and stays as it was otherwise.
//
// Drives the real runTrackEvent with the agent stubbed to capture its prompt.
// Run: `npm test -- changeover-pick-clause`.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

const stateRoot = mkdtempSync(join(tmpdir(), 'subwave-changeover-pick-'));
process.env.STATE_DIR = stateRoot;
process.env.NAVIDROME_URL = 'http://changeover-library.invalid';

const settings = await import('../src/settings.js');
const library = await import('../src/music/library.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const { pickerAgent, runTrackEvent } = await import('../src/broadcast/dj-agent.js');
const { slim } = await import('../src/llm/internal/tools/picker/slim.js');
const { getTimeContext, getClockContext, getDateContext } = await import('../src/context.js');

const onAir = { id: 'on-air', title: 'Last Song', artist: 'Outgoing Act', duration: 300 };
const pick = { id: 'first-pick', title: 'First Song', artist: 'Incoming Act', duration: 300 };
const show = { id: 's_incoming', name: 'Quiet Hours', topic: 'hushed late-night records', personaId: '' };
const realFetch = globalThis.fetch;
const realRun = pickerAgent.run;
const now = Date.now();

before(async () => {
  await settings.load();
  show.personaId = settings.get().personas[0].id;
  await settings.update({
    shows: [show],
    // Takeover window: the show is on air from a minute ago for ten minutes,
    // and the base schedule is empty on either side of it.
    scheduleOverride: { showId: show.id, startedAt: now - 60_000, expiresAt: now + 600_000 },
    tts: { enabled: false },
    llm: {
      trackSelection: 'agentic', dailyTokenCap: 0, artistVarietyWindow: 0, noRepeatWindow: 0,
      provider: 'openai-compatible', model: 'changeover-test',
      baseUrl: 'http://changeover-model.invalid/v1', apiKey: 'test', fallback: { enabled: false },
    },
  });
  await library.load();
  globalThis.fetch = async () => new Response('not found', { status: 404 });
});

after(() => {
  globalThis.fetch = realFetch;
  pickerAgent.run = realRun;
  if (queue._persistTimer) clearTimeout(queue._persistTimer);
  if (queue._recentPlaysTimer) clearTimeout(queue._recentPlaysTimer);
  library.shutdown();
  rmSync(stateRoot, { recursive: true, force: true });
});

function context(activeShow: typeof show | null) {
  return {
    at: new Date(now).toISOString(), activeShow, clock: getClockContext(),
    time: getTimeContext(), date: getDateContext(), dominantMood: null,
    weather: null, festival: null, showHandover: null, listeners: { count: null }, episodeEditorial: '',
  };
}

async function pickEvent(liveShow: typeof show | null, showAt: Date): Promise<string> {
  queue.current = { track: onAir, source: 'ai' };
  queue.upcoming = [];
  queue.history = [];
  queue.djLog = [];
  queue.senderBusy = true;
  session.start(context(liveShow));
  let eventPrompt = '';
  pickerAgent.run = async (args) => {
    eventPrompt = String(args.messages.at(-1)?.content);
    return {
      object: { id: pick.id, reason: 'Synthetic pick', say: null, transition: null },
      steps: 1, toolCalls: [],
      extras: { seen: new Map([[pick.id, slim(pick)]]) },
    };
  };
  try {
    await runTrackEvent(queue, context(settings.resolveActiveShow(showAt) as never), { wantLink: false, showAt });
  } finally {
    pickerAgent.run = realRun;
    queue.senderBusy = false;
  }
  assert.ok(eventPrompt, 'the agent was asked');
  return eventPrompt;
}

test('a pick made for an incoming show names that show, last', async () => {
  const prompt = await pickEvent(null, new Date(now + 60_000));
  assert.match(prompt, /This track airs in the show "Quiet Hours", which follows what is on air now: pick it for that show's brief, not for what is ending\.$/);
});

test('a pick made for the block after a show names that block', async () => {
  const prompt = await pickEvent(show, new Date(now + 3_600_000));
  assert.match(prompt, /This track airs in the autonomous block, which follows what is on air now: pick it for that block, not for what is ending\.$/);
});

test('a pick inside the live session\'s own show carries no changeover clause', async () => {
  assert.doesNotMatch(await pickEvent(show, new Date(now + 60_000)), /This track airs in/);
  assert.doesNotMatch(await pickEvent(null, new Date(now + 3_600_000)), /This track airs in/);
});

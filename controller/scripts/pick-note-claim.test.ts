// A pick's note must describe the track it queued (#1978).
// Run: `npm test -- pick-note-claim`.
//
// Live: a pick searched the library for one track by an artist and returned
// the id of a different track by that artist. validateObject only asks that the
// id is one a tool surfaced, and searchLibrary surfaces several tracks per
// artist, so the note could describe the neighbour of the id it returned — in
// the Booth under the queued track, and in the next pick's memory of what
// aired. Two halves, as in request-claim.test.ts: the rule
// (util/request-claim.ts misnamedPickNote) over a probe-shaped table, and each
// route's remedy — its own plain copy, no model call — driven through the real
// pick paths with only HTTP synthetic. The spoken link is pinned too: it is
// written by a separate call that is handed only the queued track.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatCompletionResponse } from './test-utils/llm.js';

const stateRoot = mkdtempSync(join(tmpdir(), 'subwave-pick-note-claim-'));
process.env.STATE_DIR = stateRoot;
process.env.NAVIDROME_URL = 'http://pick-note-library.invalid';

const { misnamedClaims, misnamedPickNote } = await import('../src/util/request-claim.js');
const settings = await import('../src/settings.js');
const library = await import('../src/music/library.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const { pickerAgent, runTrackEvent } = await import('../src/broadcast/dj-agent.js');
const { pickViaPool, clearPoolCache } = await import('../src/music/picker.js');
const { clearPickerSourceCache } = await import('../src/llm/tools.js');
const { slim } = await import('../src/llm/internal/tools/picker/slim.js');
const { getTimeContext, getClockContext, getDateContext } = await import('../src/context.js');

const PORCELAIN = { id: 'moby-porcelain', title: 'Porcelain', artist: 'Moby', album: 'Play', duration: 241 };
const NATURAL = { id: 'moby-natural', title: 'Natural Blues', artist: 'Moby', album: 'Play', duration: 252 };
const ANGEL = { id: 'ma-angel', title: 'Angel', artist: 'Massive Attack', album: 'Mezzanine', duration: 379 };
const TEARDROP = { id: 'ma-teardrop', title: 'Teardrop', artist: 'Massive Attack', album: 'Mezzanine', duration: 330 };
const SYMPATHY = { id: 'ma-sympathy', title: 'Unfinished Sympathy', artist: 'Massive Attack', album: 'Blue Lines', duration: 308 };
const GLORY = { id: 'ph-glory', title: 'Glory Box', artist: 'Portishead', album: 'Dummy', duration: 306 };
const SMOOTH = { id: 'santana-smooth', title: 'Smooth', artist: 'Santana feat. Rob Thomas', album: 'Supernatural', duration: 295 };

// The incident's shape: on air Moby, a search for one Massive Attack track,
// another Massive Attack id returned.
const ctx = {
  track: ANGEL,
  others: [TEARDROP, SYMPATHY, GLORY, SMOOTH],
  stationNames: ['Marlowe', 'SUB/WAVE'],
  references: [PORCELAIN.title, PORCELAIN.artist, 'Night Shift'],
};

// --- the rule ---------------------------------------------------------------

test('a note describing another candidate is caught, however it names it', () => {
  const lies: Array<[string, string]> = [
    ["Teardrop's hush deepens the late-night mood", 'Teardrop'],
    ["Unfinished Sympathy's strings lift the energy", 'Unfinished Sympathy'],
    ["keeps the trip-hop going with Glory Box's slink", 'Glory Box'],
    ["'Teardrop' — fragile, slow, late-night", 'Teardrop'],
    ["Massive Attack's Teardrop keeps the hush", 'Teardrop'],
    ["Portishead's slow-burn melancholy", 'Portishead'],
    ['its fragile Teardrop vocal floats over the late-night hush', 'Teardrop'],
  ];
  for (const [note, named] of lies) {
    assert.deepEqual(misnamedPickNote(note, ctx).map((c) => c.text), [named], note);
  }
});

test('honest notes pass: the queued track, the track it follows, comparisons, adjectives', () => {
  for (const note of [
    // The incident's own note names nothing — vague, not wrong.
    'energy step from a pop hook into anthemic rock, same decade',
    "Angel's heavy bassline deepens the late-night mood",
    'Massive Attack brings a slower, brooding Bristol pulse',
    "Darker trip-hop step after Moby's ambient hush",
    "after Porcelain's hush, a heavier, more menacing groove",
    'Mezzanine-era menace after the ambient run',
    // Naming the queued title owns the comparison.
    'searched Teardrop; Angel keeps the Mezzanine darkness',
    // Naming another act to compare says the pick is not that act.
    'A Portishead-like gloom, but heavier drums',
    'slower and darker than Portishead',
    // A lone capital at a sentence start stays ambiguous: these are a
    // candidate's whole title and still an adjective here.
    'Smooth handoff into brooding trip-hop',
    // The station's and the show's own names.
    'Night Shift territory: slower and heavier',
    "Marlowe's late-night thread, heavier now",
  ]) assert.deepEqual(misnamedPickNote(note, ctx), [], note);
});

test("the measured price of reading a note's opening possessive", () => {
  // A common-word title among the candidates under a note opening on that
  // word as a possessive. Plain copy, never a model call or a changed track.
  assert.deepEqual(
    misnamedPickNote("Tonight's mood: hazy and hypnotic", { ...ctx, others: [{ title: 'Tonight', artist: 'Kool & the Gang' }] })
      .map((c) => c.text),
    ['Tonight'],
  );
  // And the accepted miss on the other side: a bare sentence-initial title.
  assert.deepEqual(misnamedPickNote('Teardrop keeps the hush going', ctx), []);
  // An opening contraction is not a possessive, even when a candidate shares
  // its word.
  const contracted = { ...ctx, others: [...ctx.others, { title: 'Here', artist: 'Alessia Cara' }, { title: 'Something', artist: 'The Beatles' }] };
  for (const note of ["Here's a darker turn after Porcelain", 'Something’s heavier underneath the hush']) {
    assert.deepEqual(misnamedPickNote(note, contracted), [], note);
  }
});

test('request lines keep the #1918 rules', () => {
  const request = { track: ANGEL, others: [TEARDROP, GLORY], requestText: 'something dark please', requester: 'Jen' };
  // No opening-possessive reading…
  assert.deepEqual(misnamedClaims("Teardrop's hush for you, Jen.", request), []);
  // …and a comparison still owes the listener the queued track's name.
  assert.deepEqual(misnamedClaims('A Portishead-like gloom for you, Jen.', request).map((c) => c.text), ['Portishead']);
});

// --- the routes ---------------------------------------------------------------

type Llm = { body: any; tools: boolean };
const llmCalls: Llm[] = [];
let librarySongs: any[] = [];
let answer: (body: any) => Record<string, unknown> = () => ({});
const LINK_TEXT = "Here's Massive Attack with Angel, low and slow.";
const realFetch = globalThis.fetch;
const realRun = pickerAgent.run;

before(async () => {
  await settings.load();
  await settings.update({
    tts: { enabled: true },
    llm: {
      trackSelection: 'agentic', dailyTokenCap: 0, artistVarietyWindow: 0, noRepeatWindow: 0, shortlistPasses: 1,
      provider: 'openai-compatible', model: 'pick-note-test', compatibleMode: 'local',
      baseUrl: 'http://pick-note-model.invalid/v1', apiKey: 'test', fallback: { enabled: false },
    },
  } as never);
  await library.load();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === 'pick-note-library.invalid') {
      const endpoint = url.pathname.split('/').at(-1);
      const songs = librarySongs;
      const data = endpoint === 'getRandomSongs' ? { randomSongs: { song: songs } }
        : endpoint === 'getStarred2' ? { starred2: { song: songs } }
          : endpoint === 'getSimilarSongs2' ? { similarSongs2: { song: songs } }
            : endpoint === 'getAlbumList2' ? { albumList2: { album: [{ id: 'album' }] } }
              : endpoint === 'getAlbum' ? { album: { song: songs } }
                : endpoint === 'getSong' ? { song: songs.find((s) => s.id === url.searchParams.get('id')) } : {};
      return Response.json({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...data } });
    }
    if (url.hostname !== 'pick-note-model.invalid' || !url.pathname.endsWith('/chat/completions')) {
      return new Response('not here', { status: 404 });
    }
    const body = JSON.parse(String(init?.body ?? '{}'));
    const tools = Array.isArray(body.tools) ? body.tools : [];
    llmCalls.push({ body, tools: tools.length > 0 });
    if (!tools.length) return chatCompletionResponse({ message: { role: 'assistant', content: LINK_TEXT } });
    return chatCompletionResponse({
      message: {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: tools[0].function.name, arguments: JSON.stringify(answer(body)) } }],
      },
    });
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  pickerAgent.run = realRun;
  if (queue._persistTimer) clearTimeout(queue._persistTimer);
  if (queue._recentPlaysTimer) clearTimeout(queue._recentPlaysTimer);
  library.shutdown();
  rmSync(stateRoot, { recursive: true, force: true });
});

function context() {
  return {
    at: new Date().toISOString(), activeShow: null, clock: getClockContext(),
    time: getTimeContext(), date: getDateContext(), dominantMood: null,
    weather: null, festival: null, showHandover: null, listeners: { count: null }, episodeEditorial: '',
  };
}

function freshQueue(onAir: any) {
  const q = Object.create(queue);
  q.current = onAir ? { track: onAir, source: 'ai' } : null;
  q.upcoming = []; q.history = []; q.djLog = []; q._recentPlays = []; q.senderBusy = true;
  const logs: string[] = [];
  q.log = (_kind: string, line: string) => { logs.push(line); };
  return { q, logs };
}

function lastPickTurn() {
  return session.getSession()?.messages.filter((m: any) => m.role === 'dj' && m.kind === 'pick').at(-1);
}

// The Agentic run, stubbed at its answer: everything after it — the claim
// check, the guards, the link writer, the enqueue — is the real path.
async function agenticPick(object: Record<string, unknown>, seen: any[], { onAir = PORCELAIN } = {}) {
  llmCalls.length = 0;
  await settings.update({ llm: { trackSelection: 'agentic' } } as never);
  session.start(context() as any);
  const { q, logs } = freshQueue(onAir);
  pickerAgent.run = (async () => ({
    object: { transition: null, ...object }, steps: 2,
    toolCalls: [{ name: 'searchLibrary', args: { query: 'Massive Attack Teardrop' }, result: [], round: 1 }],
    extras: { seen: new Map(seen.map((s) => [s.id, slim(s)])) },
  })) as any;
  try {
    await runTrackEvent(q, context(), { wantLink: true });
  } finally {
    pickerAgent.run = realRun;
    if (q._persistTimer) clearTimeout(q._persistTimer);
  }
  return { q, logs };
}

const linkPrompts = () => llmCalls.filter((c) => !c.tools).map((c) => JSON.stringify(c.body.messages));

test('#1978 end to end: a note naming the searched neighbour becomes plain copy, with no extra model call', async () => {
  const { q, logs } = await agenticPick(
    { id: ANGEL.id, reason: "Teardrop's hush deepens the late-night mood" },
    [TEARDROP, ANGEL, SYMPATHY],
  );
  const plain = '“Angel” by Massive Attack offers a strong musical fit with the current flow.';
  assert.equal(q.upcoming[0]?.track.id, ANGEL.id, 'the track stands');
  assert.equal(q.upcoming[0].intent, plain);
  assert.equal(lastPickTurn()?.text, plain, 'the Booth and the next pick read the plain note');
  assert.ok(logs.some((l) => /pick note named "Teardrop" over "Angel" by Massive Attack/.test(l)), logs.join('\n'));
  assert.equal(llmCalls.length, 1, 'the link is the only model call');
  // The spoken link never saw the note, the search or the other candidates.
  const [prompt] = linkPrompts();
  assert.match(prompt!, /Track on air:\\n- Angel by Massive Attack\./);
  assert.doesNotMatch(prompt!, /Teardrop|Unfinished Sympathy/);
  assert.equal(q.upcoming[0].introScript, LINK_TEXT);
});

test('an honest note costs nothing and keeps its words', async () => {
  const { q, logs } = await agenticPick(
    { id: ANGEL.id, reason: "after Porcelain's hush, a heavier, slower menace" },
    [TEARDROP, ANGEL, SYMPATHY],
  );
  const kept = "“Angel” by Massive Attack — after Porcelain's hush, a heavier, slower menace.";
  assert.equal(q.upcoming[0]?.intent, kept);
  assert.equal(lastPickTurn()?.text, kept);
  assert.ok(!logs.some((l) => /note named/.test(l)));
  assert.equal(llmCalls.length, 1);
});

test('a substring is not a name: a short queued title no longer grounds a note about another track', async () => {
  // Before, "angel" inside "angelic" read as naming the queued title, and the
  // note about Teardrop went out verbatim.
  const { q } = await agenticPick(
    { id: ANGEL.id, reason: 'Massive Attack’s Teardrop brings angelic, fragile vocals' },
    [TEARDROP, ANGEL],
  );
  assert.equal(q.upcoming[0]?.intent, '“Angel” by Massive Attack offers a strong musical fit with the current flow.');
});

test("a corrective re-pick's note is grounded too", async () => {
  // The pick repeats the on-air artist, so the artist guard re-picks from the
  // other-artist candidates; that answer's note describes the neighbour, and
  // only a substring of it ("angelic") ever looked like the queued title.
  answer = () => ({ id: ANGEL.id, reason: 'Massive Attack’s Teardrop brings angelic, fragile vocals', transition: null });
  const { q } = await agenticPick(
    { id: NATURAL.id, reason: 'more of the ambient Moby thread' },
    [NATURAL, ANGEL, TEARDROP],
  );
  assert.equal(q.upcoming[0]?.track.id, ANGEL.id);
  assert.equal(q.upcoming[0].intent, '“Angel” by Massive Attack offers a strong musical fit with the current flow.');
  assert.equal(llmCalls.filter((c) => c.tools).length, 1, 'the guard re-pick only');
  assert.doesNotMatch(linkPrompts()[0]!, /Teardrop|Natural Blues/);
});

test('Track Shortlist: a clause naming another candidate becomes the plain clause, with no extra model call', async () => {
  librarySongs = [TEARDROP, ANGEL, SYMPATHY, GLORY];
  await settings.update({ tts: { enabled: false }, llm: { trackSelection: 'shortlist' } } as never);
  try {
    for (const [musicalReason, expected] of [
      ['its fragile Teardrop vocal floats over the late-night hush', '“Angel” by Massive Attack — its musical character fits the surrounding sequence naturally.'],
      ['its heavy bassline deepens the late-night mood without breaking the hush', '“Angel” by Massive Attack — its heavy bassline deepens the late-night mood without breaking the hush.'],
    ] as const) {
      clearPickerSourceCache();
      llmCalls.length = 0;
      answer = () => ({ id: ANGEL.id, musicalReason, transition: null });
      session.start(context() as any);
      const { q } = freshQueue(null);
      try { await runTrackEvent(q, context(), { wantLink: false }); } finally { if (q._persistTimer) clearTimeout(q._persistTimer); }
      assert.equal(q.upcoming[0]?.track.id, ANGEL.id);
      assert.equal(q.upcoming[0].intent, expected, musicalReason);
      assert.equal(lastPickTurn()?.text, expected);
      assert.equal(llmCalls.length, 1, 'the one Shortlist call');
    }
  } finally {
    await settings.update({ tts: { enabled: true }, llm: { trackSelection: 'agentic' } } as never);
  }
});

test('the pool: a reason naming another candidate is dropped for the plain session note', async () => {
  librarySongs = [TEARDROP, ANGEL, SYMPATHY, GLORY];
  for (const [reason, expected] of [
    ["Teardrop's delicate vocal is a gentle step down in energy.", null],
    ["Angel's slow, heavy groove deepens the late-night mood after Porcelain.", "Angel's slow, heavy groove deepens the late-night mood after Porcelain."],
  ] as const) {
    clearPoolCache();
    clearPickerSourceCache();
    llmCalls.length = 0;
    answer = (body) => {
      const offered = JSON.parse(body.messages.find((m: any) => m.role === 'user').content.split('\n\n')[0]).candidates;
      assert.ok(offered.some((c: any) => c.id === TEARDROP.id), 'the neighbour was offered');
      return { id: ANGEL.id, reason };
    };
    const { q } = freshQueue(PORCELAIN);
    const result = await pickViaPool(q, context());
    assert.equal(result?.song.id, ANGEL.id);
    assert.equal(result?.reason, expected, reason);
    assert.equal(llmCalls.length, 1);
  }
});

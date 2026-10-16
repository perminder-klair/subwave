// A request line must describe the track that will actually air (#1918).
// Run: `npm test -- request-claim`.
//
// Live: "Michael Jackson please" → the request agent made one tracksLikeThis
// call on the queued Madonna track and returned a VALID candidate id (Madonna,
// "La Isla Bonita") under an ack and intro announcing Michael Jackson's "Billie
// Jean". The unknown-id re-pick never fired, so the lie aired. Two halves:
// util/request-claim.ts decides what a wrong name is (the pure table below),
// and runRequest's remedy — one corrective re-pick with the library lookup the
// agent skipped, else plain copy — is driven end to end further down.

import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir } from './test-utils/temp-dir.js';
import { chatCompletionResponse } from './test-utils/llm.js';

process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-request-claim-'));

const {
  claimLookupQuery, lineClaims, misnamedClaims, misnamedRequestLines, plainRequestAck, plainRequestIntro,
} = await import('../src/util/request-claim.js');
const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const { requestAgent } = await import('../src/broadcast/dj-agent/agents.js');
const { runRequest } = await import('../src/broadcast/dj-agent.js');

const ISLA = { id: 'madonna-isla', title: 'La Isla Bonita', artist: 'Madonna', album: 'True Blue', duration: 242 };
const HOLIDAY = { id: 'madonna-holiday', title: 'Holiday', artist: 'Madonna', album: 'Madonna', duration: 368 };
const GIRLS = { id: 'cyndi-girls', title: 'Girls Just Want to Have Fun', artist: 'Cyndi Lauper', album: "She's So Unusual", duration: 238 };
const BILLIE = { id: 'mj-billie', title: 'Billie Jean', artist: 'Michael Jackson', album: 'Thriller', duration: 294, isDir: false };

const INCIDENT_INTRO = "Alright Michael, here's Michael Jackson with 'Billie Jean' — keeping things smooth and steady for the afternoon.";
const INCIDENT_ACK = 'Got you, Michael — playing a Michael Jackson track now.';
const incident = { track: ISLA, requestText: 'Michael Jackson please', requester: 'Michael', others: [HOLIDAY, GIRLS] };

// --- the policy -----------------------------------------------------------------

test('the #1918 lines are caught: the asked-for artist and a quoted title, over a Madonna track', () => {
  assert.deepEqual(misnamedClaims(INCIDENT_INTRO, incident), [
    { source: 'request', text: 'Michael Jackson' },
    { source: 'quoted-title', text: 'Billie Jean' },
  ]);
  assert.deepEqual(misnamedClaims(INCIDENT_ACK, incident), [{ source: 'request', text: 'Michael Jackson' }]);
  assert.deepEqual(
    misnamedRequestLines({ intro: INCIDENT_INTRO, ack: INCIDENT_ACK }, incident).map((m) => m.field),
    ['intro', 'ack'],
  );
});

test('lines that name the queued track pass, including an owned substitution', () => {
  for (const line of [
    "Here's La Isla Bonita by Madonna, going out to Michael.",
    "No Michael Jackson in the crates tonight, Michael — so here's Madonna with 'La Isla Bonita'.",
    'Michael wanted the King of Pop; the closest we have is La Isla Bonita.',
    "Madonna's island classic, for Michael.",
  ]) assert.deepEqual(misnamedClaims(line, incident), [], line);
});

test('a line that names nothing at all is vague, not wrong', () => {
  for (const line of [
    'Got you, Michael — coming right up.',
    'Alright Michael, something smooth and steady for the afternoon.',
    'Smooth vibes for the afternoon, Michael.',
  ]) assert.deepEqual(misnamedClaims(line, incident), [], line);
});

test("the listener's own name is never a claim, even when it is half the artist", () => {
  assert.deepEqual(misnamedClaims('Got you, Michael!', incident), []);
  // …but the full asked-for name still is.
  assert.equal(misnamedClaims('Michael, here comes Michael Jackson.', incident)[0]?.text, 'Michael Jackson');
});

test('a name inside a longer phrase the line repeats is still read', () => {
  // Judged whole, each shared run failed nameLike on a lowercase word ("upbeat",
  // the possessive "s") and the lie went to air unflagged.
  const ctx = { track: ISLA, requester: 'Jen', others: [] };
  assert.deepEqual(
    misnamedClaims('Some upbeat Michael Jackson coming right up!', { ...ctx, requestText: 'some upbeat Michael Jackson' }).map((c) => c.text),
    ['Michael Jackson'],
  );
  assert.deepEqual(
    misnamedClaims('Got it — some old school Michael Jackson for you!', { ...ctx, requestText: 'some old school Michael Jackson please' }).map((c) => c.text),
    ['Michael Jackson'],
  );
  assert.deepEqual(
    misnamedClaims("Here's Michael Jackson's Thriller, Jen!", { ...ctx, requestText: "play Michael Jackson's Thriller" }).map((c) => c.text),
    ['Michael Jackson', 'Thriller'],
  );
  // Still a name only where the line capitalises it.
  assert.deepEqual(misnamedClaims('some upbeat michael jackson coming up', { ...ctx, requestText: 'some upbeat Michael Jackson' }), []);
});

test("a word in the run's own genre tags is a genre, not a name", () => {
  // The commonest request is a genre, a language or a season, read back
  // capitalised in an ack that names no track.
  const myGirl = { title: 'My Girl', artist: 'The Temptations', genre: 'Soul, Motown' };
  const motown = { track: myGirl, requestText: 'some motown please', requester: 'Sam', others: [] };
  assert.deepEqual(misnamedClaims('You got it, Sam — a little Motown magic coming up!', motown), []);
  assert.deepEqual(misnamedClaims('Some classic Hip Hop for you, Dee!', {
    track: { title: 'N.Y. State of Mind', artist: 'Nas', genre: 'Hip-Hop' }, requestText: 'hip hop please', requester: 'Dee',
  }), []);
  assert.deepEqual(misnamedClaims('Smooth R&B coming your way, Kim.', {
    track: { title: 'Crazy in Love', artist: 'Beyoncé', genre: 'R&B' }, requestText: 'play some r&b', requester: 'Kim',
  }), []);
  // Any candidate's tags count, word by word.
  assert.deepEqual(misnamedClaims('Got it, Raj — some Punjabi heat coming your way!', {
    track: { title: 'Softly', artist: 'Karan Aujla', genre: null }, requestText: 'punjabi songs please', requester: 'Raj',
    others: [{ title: 'Lover', artist: 'Diljit Dosanjh', genre: 'Punjabi Pop' }],
  }), []);
  // The tags are the evidence: untagged, the same word still reads as a name.
  assert.deepEqual(
    misnamedClaims('You got it, Sam — a little Motown magic coming up!', { ...motown, track: { ...myGirl, genre: 'Soul' } }).map((c) => c.text),
    ['Motown'],
  );
  // …and a genre word never hides the asked-for artist.
  assert.deepEqual(misnamedClaims("Here's Michael Jackson for you, Jen!", {
    ...incident, requester: 'Jen', track: { ...ISLA, genre: 'Pop' }, others: [{ ...HOLIDAY, genre: 'Pop, Dance' }],
  }).map((c) => c.text), ['Michael Jackson']);
});

test('a dedication in the request is excused once the line names the track', () => {
  const ctx = { track: ISLA, requestText: 'Madonna for my friend Sarah Jones please', requester: 'Tom', others: [] };
  assert.deepEqual(misnamedClaims('This one is for Sarah Jones, with love from Madonna.', ctx), []);
  assert.deepEqual(misnamedClaims('This one is for Sarah Jones — La Isla Bonita.', ctx), []);
});

test('"The" prefixes, diacritics and featured credits all ground the line', () => {
  const beatles = { title: 'Hey Jude', artist: 'The Beatles' };
  assert.deepEqual(misnamedClaims("Here's the Beatles for you.", { track: beatles, requestText: 'beatles please' }), []);
  assert.deepEqual(misnamedClaims('Beatles, as asked — enjoy.', { track: beatles, requestText: 'the beatles' }), []);

  const halo = { title: 'Halo', artist: 'Beyoncé' };
  assert.deepEqual(misnamedClaims("Here's Beyonce for you, Sam.", { track: halo, requestText: 'beyonce', requester: 'Sam' }), []);

  const umbrella = { title: 'Umbrella (feat. JAY-Z)', artist: 'Rihanna feat. Jay-Z' };
  const ctx = { track: umbrella, requestText: 'some Jay-Z please' };
  assert.deepEqual(misnamedClaims('Jay-Z and Rihanna, keeping you dry.', ctx), []);
  assert.equal(lineClaims('Here is Umbrella for you.', ctx).titleNamed, true, 'the title without its credit tail grounds it');
});

test('a cover is not a mismatch: naming the song grounds a line that credits its writer', () => {
  const cover = { title: 'Hallelujah', artist: 'Jeff Buckley' };
  const ctx = { track: cover, requestText: 'Hallelujah by Leonard Cohen please' };
  assert.deepEqual(misnamedClaims("Here's Leonard Cohen's Hallelujah, the way Jeff Buckley sang it.", ctx), []);
  assert.deepEqual(misnamedClaims("Leonard Cohen's Hallelujah, coming right up.", ctx), []);
});

test('a title tail never hides the queued track', () => {
  const remaster = { title: 'La Isla Bonita (Remastered 2009)', artist: 'Madonna' };
  assert.deepEqual(misnamedClaims("Here's 'La Isla Bonita' for Michael.", { ...incident, track: remaster }), []);
  const dash = { title: 'Billie Jean - Single Version', artist: 'Michael Jackson' };
  assert.deepEqual(misnamedClaims("Michael Jackson with 'Billie Jean'.", { ...incident, track: dash }), []);
});

test('another candidate named instead of the queued one is caught (id mix-up)', () => {
  assert.deepEqual(misnamedClaims("Here's Cyndi Lauper for you!", incident), [{ source: 'candidate-artist', text: 'Cyndi Lauper' }]);
  assert.deepEqual(misnamedClaims('Here is Girls Just Want to Have Fun!', incident), [{ source: 'candidate-title', text: 'Girls Just Want to Have Fun' }]);
  // Naming the queued artist excuses a comparison with another one.
  assert.deepEqual(misnamedClaims('If Cyndi Lauper is your thing, Madonna will do.', incident), []);
  // A lowercase common word is never a candidate's title.
  assert.deepEqual(misnamedClaims('A holiday feeling for the afternoon.', incident), []);
});

test('the right artist with a wrong quoted title is still wrong', () => {
  assert.deepEqual(misnamedClaims("Here's Madonna with 'Like a Prayer'.", incident), [{ source: 'quoted-title', text: 'Like a Prayer' }]);
  assert.deepEqual(misnamedClaims('Here\'s Madonna with "Like a Prayer".', incident), [{ source: 'quoted-title', text: 'Like a Prayer' }]);
  // The album may be quoted; so may a listener's lowercase phrase; apostrophes never open a quote.
  assert.deepEqual(misnamedClaims("From Madonna's 'True Blue' album, here she is.", incident), []);
  assert.deepEqual(misnamedClaims("You wanted 'something to dance to' — here's Madonna.", incident), []);
  assert.deepEqual(misnamedClaims("Here's Madonna's 'Don't Stop' mood, from the '80s.", { ...incident, others: [] }).map((c) => c.text), ["Don't Stop"]);
});

test('caseless scripts and lowercase lines never raise a claim', () => {
  const punjabi = { title: 'Softly', artist: 'Karan Aujla' };
  assert.deepEqual(misnamedClaims('ਦਿਲਜੀਤ ਦੋਸਾਂਝ ਦਾ ਗੀਤ', { track: punjabi, requestText: 'ਦਿਲਜੀਤ ਦੋਸਾਂਝ' }), []);
  assert.deepEqual(misnamedClaims('here is michael jackson for you', incident), []);
});

test('the lookup the agent skipped: the longest request claim, only when nothing was searched', () => {
  const misnamed = misnamedRequestLines({ intro: INCIDENT_INTRO, ack: INCIDENT_ACK }, incident);
  assert.equal(claimLookupQuery(misnamed, [{ name: 'tracksLikeThis' }]), 'Michael Jackson');
  assert.equal(claimLookupQuery(misnamed, []), 'Michael Jackson');
  assert.equal(claimLookupQuery(misnamed, [{ name: 'tracksLikeThis' }, { name: 'searchLibrary' }]), null);
  assert.equal(claimLookupQuery(misnamed, [{ name: 'topSongsByArtist' }]), null);
  // A mix-up between candidates is not a missed search.
  const mixUp = misnamedRequestLines({ intro: "Here's Cyndi Lauper!" }, incident);
  assert.equal(claimLookupQuery(mixUp, []), null);
});

test('plain copy names the queued track from metadata, and the listener only by a real name', () => {
  assert.equal(plainRequestIntro(ISLA, 'Michael'), "Here's La Isla Bonita by Madonna, for Michael.");
  assert.equal(plainRequestIntro(ISLA, 'anon'), "Here's La Isla Bonita by Madonna.");
  assert.equal(plainRequestAck(ISLA, 'Michael'), 'Coming up for you, Michael: La Isla Bonita by Madonna.');
  assert.equal(plainRequestAck({ title: 'Untitled' }, ''), 'Coming up for you: Untitled.');
  // Plain copy can never fail its own check.
  assert.deepEqual(misnamedRequestLines({ intro: plainRequestIntro(ISLA, 'Michael'), ack: plainRequestAck(ISLA, 'Michael') }, incident), []);
});

// --- the remedy, through runRequest ---------------------------------------------

type Scripted = { llm: Array<unknown | Error>; search?: any[] };
type Calls = { llm: any[]; search: string[] };

// Routes every fetch: the corrective re-pick's model call (openai-compatible
// fixture, answered in order from `llm`) and the music server's search3.
async function withNetwork<T>(script: Scripted, fn: (calls: Calls) => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  const calls: Calls = { llm: [], search: [] };
  const replies = [...script.llm];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // searchLibrary's vibe fallback asks the same base for an embedding on an
    // empty search3; only chat completions are scripted.
    if (url.startsWith('http://127.0.0.1:9/') && !url.includes('/chat/completions')) {
      return new Response('no embeddings here', { status: 404 });
    }
    if (url.startsWith('http://127.0.0.1:9/')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      calls.llm.push(body);
      const reply = replies.shift();
      if (reply === undefined || reply instanceof Error) return new Response('model down', { status: 400 });
      const tools = Array.isArray(body?.tools) ? body.tools : [];
      return chatCompletionResponse({
        message: tools.length
          ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: tools[0].function.name, arguments: JSON.stringify(reply) } }] }
          : { role: 'assistant', content: JSON.stringify(reply) },
      });
    }
    if (url.includes('/rest/search3')) {
      calls.search.push(new URL(url).searchParams.get('query') ?? '');
      return Response.json({ 'subsonic-response': { status: 'ok', version: '1.16.1', searchResult3: { song: script.search ?? [] } } });
    }
    return Response.json({ 'subsonic-response': { status: 'ok', version: '1.16.1' } });
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

const realRequestRun = requestAgent.run;

function agentAnswers(object: Record<string, unknown>, seen: any[], toolCalls: any[] = [{ name: 'tracksLikeThis', args: {}, result: [], round: 1 }]) {
  requestAgent.run = (async () => ({
    object, steps: 1, toolCalls, extras: { seen: new Map(seen.map((s) => [s.id, s])) },
  })) as any;
}

await settings.load();

beforeEach(async () => {
  requestAgent.run = realRequestRun;
  queue.senderBusy = true;
  queue.upcoming = [];
  queue.current = null;
  queue.history = [];
  queue.djLog = [];
  await settings.update({
    llm: {
      pickerAgent: true, requestMatching: 'agentic',
      provider: 'openai-compatible', model: 'fixture-model', compatibleMode: 'local',
      baseUrl: 'http://127.0.0.1:9/v1', fallback: { enabled: false },
    },
    tts: { enabled: true },
  } as never);
  session.start({
    at: new Date().toISOString(), time: { period: 'day', vibe: 'day', mood: 'calm' },
    weather: null, festival: null, dominantMood: 'calm', activeShow: null,
  } as any);
});

after(async () => {
  requestAgent.run = realRequestRun;
  queue.senderBusy = false;
  await new Promise((resolve) => setTimeout(resolve, 1_100));
});

test('#1918 end to end: the skipped lookup finds the artist, and the re-pick queues them with honest lines', async () => {
  agentAnswers({ kind: 'track', id: ISLA.id, ack: INCIDENT_ACK, intro: INCIDENT_INTRO }, [ISLA, HOLIDAY, GIRLS]);
  const result = await withNetwork({
    search: [BILLIE],
    llm: [{ id: BILLIE.id, ack: 'Got you, Michael — Billie Jean it is.', intro: "Michael, here's Michael Jackson with Billie Jean." }],
  }, async (calls) => {
    const out = await runRequest(queue, { requester: 'Michael', text: 'Michael Jackson please' });
    // searchLibrary may re-ask page 0 after a short random deep page; every
    // search3 is still the one lookup, for the name the lines claimed.
    assert.ok(calls.search.length >= 1);
    assert.ok(calls.search.every((q) => q === 'Michael Jackson'), calls.search.join(' | '));
    assert.equal(calls.llm.length, 1, 'exactly one corrective call');
    const prompt = JSON.stringify(calls.llm[0].messages);
    assert.match(prompt, /mj-billie/, 'the lookup hit is offered as a candidate');
    assert.match(prompt, /You chose \\"La Isla Bonita\\" by Madonna/);
    return out;
  });
  assert.equal(result?.track?.id, BILLIE.id);
  assert.equal(result?.guard, 'claim-repicked');
  assert.equal(queue.upcoming.length, 1);
  assert.equal(queue.upcoming[0].track.id, BILLIE.id);
  assert.equal(queue.upcoming[0].introScript, "Michael, here's Michael Jackson with Billie Jean.");
  assert.equal(result?.ack, 'Got you, Michael — Billie Jean it is.');
});

test('a re-pick that still misnames its track airs plain copy for that track', async () => {
  agentAnswers({ kind: 'track', id: ISLA.id, ack: INCIDENT_ACK, intro: INCIDENT_INTRO }, [ISLA, HOLIDAY, GIRLS]);
  const result = await withNetwork({
    search: [],
    llm: [{ id: HOLIDAY.id, ack: 'Got you, Michael — this one is fine.', intro: "Here's Michael Jackson, Michael!" }],
  }, () => runRequest(queue, { requester: 'Michael', text: 'Michael Jackson please' }));
  assert.equal(result?.track?.id, HOLIDAY.id, 'the corrected choice is kept');
  assert.equal(result?.guard, 'claim-plain');
  assert.equal(queue.upcoming[0].introScript, "Here's Holiday by Madonna, for Michael.");
  assert.equal(result?.ack, 'Got you, Michael — this one is fine.', 'a clean line is not replaced');
});

test('when the corrective call fails, the original pick airs with plain copy', async () => {
  agentAnswers({ kind: 'track', id: ISLA.id, ack: INCIDENT_ACK, intro: INCIDENT_INTRO }, [ISLA, HOLIDAY]);
  const result = await withNetwork({ search: [], llm: [new Error('down')] },
    () => runRequest(queue, { requester: 'Michael', text: 'Michael Jackson please' }));
  assert.equal(result?.track?.id, ISLA.id);
  assert.equal(result?.guard, 'claim-plain');
  assert.equal(queue.upcoming[0].track.id, ISLA.id);
  assert.equal(queue.upcoming[0].introScript, "Here's La Isla Bonita by Madonna, for Michael.");
  assert.equal(result?.ack, 'Coming up for you, Michael: La Isla Bonita by Madonna.');
});

test('a run that already searched gets no second lookup', async () => {
  agentAnswers({ kind: 'track', id: ISLA.id, ack: 'Coming up.', intro: INCIDENT_INTRO }, [ISLA, HOLIDAY],
    [{ name: 'searchLibrary', args: { query: 'Michael Jackson' }, result: [], round: 1 }]);
  await withNetwork({ search: [BILLIE], llm: [new Error('down')] }, async (calls) => {
    const result = await runRequest(queue, { requester: 'Michael', text: 'Michael Jackson please' });
    assert.deepEqual(calls.search, []);
    assert.equal(result?.ack, 'Coming up.', 'only the misnamed line is replaced');
    assert.equal(queue.upcoming[0].introScript, "Here's La Isla Bonita by Madonna, for Michael.");
  });
});

test('honest lines cost nothing: no lookup, no extra model call, words untouched', async () => {
  const intro = "No Michael Jackson in the crates, Michael — here's Madonna with 'La Isla Bonita' instead.";
  agentAnswers({ kind: 'track', id: ISLA.id, ack: 'Closest I have, Michael!', intro }, [ISLA, HOLIDAY, GIRLS]);
  await withNetwork({ search: [BILLIE], llm: [] }, async (calls) => {
    const result = await runRequest(queue, { requester: 'Michael', text: 'Michael Jackson please' });
    assert.equal(calls.llm.length, 0);
    assert.deepEqual(calls.search, []);
    assert.equal(result?.guard, null);
    assert.equal(queue.upcoming[0].introScript, intro);
  });
});

test("a genre ack over a track the run tagged with it costs nothing", async () => {
  const myGirl = { id: 'temptations-girl', title: 'My Girl', artist: 'The Temptations', genre: 'Soul, Motown', duration: 165 };
  const ack = 'You got it, Sam — a little Motown magic coming up!';
  agentAnswers({ kind: 'track', id: myGirl.id, ack, intro: 'Sunshine on a cloudy day, Sam.' }, [myGirl, HOLIDAY],
    [{ name: 'songsByGenre', args: { genre: 'motown' }, result: [], round: 1 }]);
  await withNetwork({ search: [], llm: [] }, async (calls) => {
    const result = await runRequest(queue, { requester: 'Sam', text: 'some motown please' });
    assert.equal(calls.llm.length, 0);
    assert.deepEqual(calls.search, []);
    assert.equal(result?.guard, null);
    assert.equal(result?.ack, ack);
  });
});

test('an unknown-id salvage already spent the one corrective call: straight to plain copy', async () => {
  agentAnswers({ kind: 'track', id: 'made-up-id-xyz', ack: 'Here we go.', intro: 'Here we go.' }, [ISLA, HOLIDAY]);
  const result = await withNetwork({
    search: [BILLIE],
    llm: [{ id: ISLA.id, ack: INCIDENT_ACK, intro: INCIDENT_INTRO }],
  }, async (calls) => {
    const out = await runRequest(queue, { requester: 'Michael', text: 'Michael Jackson please' });
    assert.equal(calls.llm.length, 1, 'the salvage call only');
    assert.deepEqual(calls.search, []);
    return out;
  });
  assert.equal(result?.track?.id, ISLA.id);
  assert.equal(result?.guard, 'claim-plain');
  assert.equal(queue.upcoming[0].introScript, "Here's La Isla Bonita by Madonna, for Michael.");
});

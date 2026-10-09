// Exercise the actual selection and link calls with synthetic HTTP only.
// Compact editorial context must reach initial/corrective choices, remain
// bounded for small models, and never enter the separate link-writing input.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'subwave-shortlist-guidance-'));
process.env.STATE_DIR = root;
process.env.NAVIDROME_URL = 'http://guidance-library.invalid';
process.env.LIQUIDSOAP_HOST = 'guidance-mixer.invalid';
const settings = await import('../src/settings.js');
const library = await import('../src/music/library.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const { runTrackEvent } = await import('../src/broadcast/dj-agent.js');
const { shortlistConversation, shortlistPickPrompt } = await import('../src/broadcast/dj-agent/shortlist-pick.js');
const { pickSystem } = await import('../src/broadcast/dj-agent/schemas.js');
const { shortlistSourceHint } = await import('../src/music/shortlist-presentation.js');
const { PICKER_TOOLS, clearPickerSourceCache } = await import('../src/llm/tools.js');

const songs = Array.from({ length: 6 }, (_, i) => ({ id: `guidance-${i}`, title: `Track ${i}`, artist: `Artist ${i}`, album: `Album ${i}`, duration: 240,
  ...(i === 0 ? { introMs: 12_000 } : {}),
}));
const realFetch = globalThis.fetch;
const realRandom = Math.random;
const pickInputs: any[] = [];
const linkInputs: any[] = [];
let incorrectFirstPick = false;
before(async () => {
  await settings.load();
  await settings.update({ tts: { enabled: true }, llm: {
    provider: 'openai-compatible', model: 'guidance-test', baseUrl: 'http://guidance-model.invalid/v1',
    apiKey: 'test', fallback: { enabled: false }, noRepeatWindow: 0,
    artistVarietyWindow: 0, trackSelection: 'shortlist', shortlistPasses: 1,
  } });
  await library.load();
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.open-meteo.com') return Response.json({ current: { temperature_2m: 15, weather_code: 0, is_day: 1 } });
    if (url.hostname === 'guidance-library.invalid') {
      const endpoint = url.pathname.split('/').at(-1);
      const data = endpoint === 'getRandomSongs' ? { randomSongs: { song: songs } }
        : endpoint === 'getStarred2' ? { starred2: { song: songs } }
          : endpoint === 'getAlbumList2' ? { albumList2: { album: [{ id: 'album' }] } }
            : endpoint === 'getAlbum' ? { album: { song: songs } }
              : endpoint === 'getSimilarSongs2' ? { similarSongs2: { song: songs } }
                : endpoint === 'getSong' ? { song: songs.find(song => song.id === url.searchParams.get('id')) } : {};
      return Response.json({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...data } });
    }
    assert.equal(url.hostname, 'guidance-model.invalid', 'no live requests');
    const body = JSON.parse(String(init?.body));
    if (body.tools?.length) {
      pickInputs.push(body);
      return Response.json({ id: 'pick', object: 'chat.completion', created: 0, model: 'guidance-test',
        choices: [{ index: 0, finish_reason: 'tool_calls', message: {
          role: 'assistant', content: null, tool_calls: [{ id: 'emit', type: 'function', function: {
            name: body.tools[0].function.name,
            arguments: JSON.stringify({
              id: incorrectFirstPick && pickInputs.length === 1 ? 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' : songs[0].id,
              musicalReason: 'its warm guitar carries the coastal thread through a patient groove', transition: null,
            }),
          } }],
        } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
    }
    linkInputs.push(body);
    return Response.json({ id: 'link', object: 'chat.completion', created: 0, model: 'guidance-test',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'A warm guitar and a patient groove.' } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
  };
});
after(() => {
  globalThis.fetch = realFetch;
  Math.random = realRandom;
  library.shutdown();
  rmSync(root, { recursive: true, force: true });
});

test('journeys and exploration have brief choice guidance, without competing during a run', () => {
  const candidates = [{ id: 'one', shortlistSources: ['tracksTowardJourney'] }, { id: 'two', unaired: true, shortlistSources: ['deepCuts'] }];
  const ordinary = shortlistPickPrompt(candidates);
  const journey = shortlistPickPrompt(candidates, { journeyActive: true });
  assert.match(journey, /prefer a fitting tracksTowardJourney track to advance the arc/);
  assert.match(shortlistPickPrompt(candidates, { explore: true }), /exploration pick: favour an unaired or long-unplayed deepCuts track when it fits/);
  assert.doesNotMatch(ordinary, /sonic journey is active|exploration pick/);
  assert.doesNotMatch(shortlistPickPrompt(candidates, { journeyActive: true, explore: true }), /This is an exploration pick/);
  assert.doesNotMatch(shortlistPickPrompt(candidates, { mixRun: { bpm: 120, key: '8A' }, explore: true }), /This is an exploration pick/);
  assert.ok(journey.length - ordinary.length < 200, 'guidance stays small');
});

test('conversation is distinct, recent, bounded and excludes routine announcements', () => {
  const now = Date.now();
  const remark = (message: string, kind = 'banter', age = 0) => ({ t: new Date(now - age).toISOString(), kind, message });
  const context = shortlistConversation([
    remark('routine link', 'link'), remark('routine ident', 'station-id'), remark('clock', 'hourly'),
    remark('handoff', 'handoff'), remark('too old', 'banter', 121 * 60_000),
    remark('future', 'banter', -1), remark('  Coastal\n guitars  '), remark('Coastal guitars'),
    remark('Guest: ' + 'a'.repeat(200)), remark('Third thread'), remark('Fourth thread'),
  ], now);
  assert.deepEqual(context.conversation?.map(text => text.length), [15, 140, 12]);
  assert.equal(context.conversation?.[0], 'Coastal guitars');
  assert.equal(context.conversation?.[1].startsWith('Guest: '), true);
  assert.deepEqual(shortlistConversation([], now), {});
});

test('only current-session aired remarks enter selection memory, not private or listener turns', () => {
  const ctx = { activeShow: null, dominantMood: 'calm', time: { period: 'morning' } } as any;
  session.start(ctx);
  session.appendTurn({ role: 'event', kind: 'request', text: 'RAW_LISTENER_TEXT' });
  session.appendTurn({ role: 'dj', kind: 'pick', text: 'PRIVATE_LEANINGS_REASON' });
  session.appendTurn({ role: 'segment', kind: 'banter', text: 'Aired coastal guitars' });
  assert.deepEqual(shortlistConversation(session.promptMemory()).conversation, ['Aired coastal guitars']);
  session.start({ ...ctx, activeShow: { id: 'incoming', name: 'Incoming' } });
  assert.deepEqual(shortlistConversation(session.promptMemory()), {}, 'a new show has no prior conversation');
});

test('Shortlist system describes compact input while Agentic retains its session instructions', () => {
  const shortlist = pickSystem(null, true, true, { host: null, guest: null, promptValue: null }, { name: 'DJ', djMode: true } as any);
  assert.match(shortlist, /compact context/);
  assert.match(shortlist, /supplied conversation cues/);
  assert.match(shortlist, /intro_ms is measured intro length in milliseconds; an absent value is unknown/);
  assert.match(shortlist, /When a link is planned, consider intro space as a soft preference between otherwise fitting tracks/);
  assert.match(shortlist, /Musical flow comes first; speech fitting is handled separately/);
  assert.doesNotMatch(shortlist, /messages above are the live session|Listener requests appear in the session above/);
  const agentic = pickSystem(null, true, false, { host: null, guest: null, promptValue: null });
  assert.match(agentic, /messages above are the live session/);
  assert.doesNotMatch(agentic, /intro_ms is measured intro length in milliseconds/);
});

test('every discovery tool has a readable source label; request resolution is excluded', () => {
  for (const { name: source } of PICKER_TOOLS.filter(tool => tool.name !== 'identifyRequestedTrack')) {
    assert.ok(shortlistSourceHint([source]), `missing label: ${source}`);
  }
  assert.equal(shortlistSourceHint(['unknown']), null);
});

async function livePick(corrective: boolean) {
  clearPickerSourceCache(); pickInputs.length = 0; linkInputs.length = 0;
  incorrectFirstPick = corrective;
  const ctx = { activeShow: null, dominantMood: null, time: { period: 'day' } };
  session.start(ctx as any);
  session.appendTurn({ role: 'segment', kind: 'banter', text: 'SELECTION_ONLY_COASTAL_THREAD' });
  const q = Object.create(queue);
  q.current = { track: { id: 'anchor', title: 'Anchor', artist: 'Anchor Artist', duration: 240 } };
  q.upcoming = []; q.history = []; q._recentPlays = []; q.senderBusy = true;
  q.log = () => {};
  q.getDjRecap = () => 'EXISTING_LINK_RECAP';
  q.getRecentTracks = () => [];
  q.getRecentOpeners = () => [];
  q.getLastLinkText = () => null;
  Math.random = () => 0; // Trigger exploration, and keep source rotation deterministic.
  try {
    await runTrackEvent(q, ctx, { wantLink: true });
  } finally {
    Math.random = realRandom;
    if (q._persistTimer) clearTimeout(q._persistTimer);
  }
  assert.equal(q.upcoming.length, 1);
  assert.equal(pickInputs.length, corrective ? 2 : 1);
  for (const body of pickInputs) {
    const prompt = body.messages.find((message: any) => message.role === 'user').content;
    const { context, shortlist } = JSON.parse(prompt.split('\n')[0]);
    assert.equal(context.explore, true);
    assert.equal(shortlist.find((track: any) => track.id === songs[0].id).intro_ms, 12_000,
      'measured intro length reaches both initial and corrective model requests');
    assert.equal('intro_ms' in shortlist.find((track: any) => track.id === songs[1].id), false);
    assert.match(context.link, /A separate safe link may air/);
    const system = body.messages.find((message: any) => message.role === 'system').content;
    assert.match(system, /When a link is planned, consider intro space as a soft preference/);
    assert.deepEqual(context.conversation, ['SELECTION_ONLY_COASTAL_THREAD']);
  }
  assert.equal(linkInputs.length, 1, 'separate link generation still runs');
  const linkInput = JSON.stringify(linkInputs[0]);
  assert.match(linkInput, /EXISTING_LINK_RECAP/);
  assert.doesNotMatch(linkInput, /SELECTION_ONLY_COASTAL_THREAD|exploration pick|coastal thread through|"conversation"|consider intro space as a soft preference/);
  assert.doesNotMatch(JSON.stringify(q.upcoming[0].track), /SELECTION_ONLY_COASTAL_THREAD|conversation/);
}

test('live initial selection gets compact continuity and exploration without changing link input', () => livePick(false));
test('a corrective selection retains that context without leaking into its link input', () => livePick(true));

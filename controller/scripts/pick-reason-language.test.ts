// Pick notes follow the on-air persona's language, for any language (Booth
// "pick" lines). Run: `npm test -- pick-reason-language`.
//
// Heard in the Booth: a Greek persona's links were Greek while every pick line
// was English — “The sea” by Morcheeba — low-energy, reflective, melancholic
// electronica, or the plain copy “End Of The Night” by The Doors offers a
// strong musical fit with the current flow. Nothing asked the pick models for
// the persona's language, and the controller's own wording around a note was
// English. The rule is broadcast/dj-agent/pick-reason-language.ts; English
// must stay byte-identical (the end-to-end English strings are pinned in
// pick-note-claim.test.ts as well).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatCompletionResponse } from './test-utils/llm.js';
import { removeTempDir } from './test-utils/temp-dir.js';

const stateRoot = mkdtempSync(join(tmpdir(), 'subwave-pick-reason-language-'));
process.env.STATE_DIR = stateRoot;
process.env.NAVIDROME_URL = 'http://pick-language-library.invalid';

const settings = await import('../src/settings.js');
const library = await import('../src/music/library.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const { pickerAgent, runTrackEvent } = await import('../src/broadcast/dj-agent.js');
const { pickViaPool, clearPoolCache } = await import('../src/music/picker.js');
const { clearPickerSourceCache } = await import('../src/llm/tools.js');
const { slim } = await import('../src/llm/internal/tools/picker/slim.js');
const { getTimeContext, getClockContext, getDateContext } = await import('../src/context.js');
const { pickSystem, agenticLeaningsReviewSystem } = await import('../src/broadcast/dj-agent/schemas.js');
const {
  agenticDiscoverySelectionReason, agenticLeaningsSelectionReason, agenticSelectionReason,
  plainAgenticSelectionReason, verifiedAgenticReason,
} = await import('../src/broadcast/dj-agent/leanings-review.js');
const { shortlistClauseSelectionReason, shortlistReasonForLeanings } = await import('../src/broadcast/dj-agent/shortlist-pick.js');

const SEA = { title: 'The sea', artist: 'Morcheeba' };
const KYRIAKI = { title: 'Συννεφιασμένη Κυριακή', artist: 'Βασίλης Τσιτσάνης' };
const NEUTRAL_SEA = '“The sea” — Morcheeba';
// Words the controller's English copy is made of. None may appear in a line it
// wrote around a non-English note.
const ENGLISH_COPY = /\b(?:by|offers?|strong|musical|fit|flow|selected|track|its|chose|reflecting|taste)\b/i;
const NO_LEANINGS = { host: null, guest: null, promptValue: null };

const template = () => settings.get().personas[0];
const persona = (language: unknown, id = `p_${String(language)}`) => ({ ...template(), id, name: 'Niki', language });

before(async () => {
  await settings.load();
});

// --- the policy, on the prompts ----------------------------------------------

test('English prompts carry no note-language clause, however English is spelt', () => {
  for (const language of [undefined, '', 'English', 'en', 'en-GB', 'English (UK)', ' english ']) {
    const p = persona(language, 'p_en');
    for (const shortlist of [false, true]) {
      assert.doesNotMatch(pickSystem(null, true, shortlist, NO_LEANINGS, p), /NOTE LANGUAGE/, `${language} ${shortlist}`);
    }
  }
  // The review's system instruction, byte for byte as it was.
  const before = 'Perform one private music-editor review. Keep the baseline by default. Musical Leanings are a soft tie-breaker: swap only for a supported preference advantage and comparable flow. Interpret descriptive preferences using supplied facts about BOTH tracks; literal tag matches are not required. A shared preference alone never justifies a swap. Host preferences are primary. A matching challenger never obliges a change. Never invent tracks, evidence or musical traits. Record interpreted comparisons as editorial judgement, not proven musical quality.';
  assert.equal(agenticLeaningsReviewSystem(), before);
  assert.equal(agenticLeaningsReviewSystem(null), before);
});

test('every other language is asked for by name, on the Agentic, Shortlist and review prompts', () => {
  for (const language of ['Greek', 'French', 'Japanese']) {
    const agentic = pickSystem(null, true, false, NO_LEANINGS, persona(language));
    const shortlist = pickSystem(null, true, true, NO_LEANINGS, persona(language));
    assert.match(agentic, new RegExp(`NOTE LANGUAGE[^\\n]*write the "reason" field in ${language}\\.`), language);
    assert.match(shortlist, new RegExp(`NOTE LANGUAGE[^\\n]*write "musicalReason" in ${language}\\.`), language);
    assert.match(agenticLeaningsReviewSystem(language), new RegExp(`write "musicalReason" in ${language}\\.`), language);
    // Titles and names are what the grounding checks match on.
    assert.match(agentic, /never translated or transliterated/);
    // Last, after the English field guidance it overrides.
    assert.ok(agentic.trimEnd().endsWith('never translated or transliterated.'), language);
  }
});

// --- the policy, on the notes --------------------------------------------------

test('a grounded Greek note is kept verbatim, in Greek script too', () => {
  const latin = 'Το “The sea” των Morcheeba κρατά τη μελαγχολική, χαμηλή ένταση της νύχτας.';
  assert.equal(agenticSelectionReason(SEA, latin, 'Greek'), latin);
  // A Greek-script track named in a Greek note: the English name check read
  // both as empty and threw the note away.
  const greek = 'Συννεφιασμένη Κυριακή, Βασίλης Τσιτσάνης: βαρύ, μελαγχολικό ρεμπέτικο για αργά το βράδυ.';
  assert.equal(agenticSelectionReason(KYRIAKI, greek, 'Greek'), greek);
  // Accents and the final sigma do not decide it.
  assert.equal(agenticSelectionReason(KYRIAKI, 'ΣΥΝΝΕΦΙΑΣΜΕΝΗ ΚΥΡΙΑΚΗ του ΒΑΣΙΛΗΣ ΤΣΙΤΣΑΝΗΣ, αργό και βαρύ.', 'Greek'),
    'ΣΥΝΝΕΦΙΑΣΜΕΝΗ ΚΥΡΙΑΚΗ του ΒΑΣΙΛΗΣ ΤΣΙΤΣΑΝΗΣ, αργό και βαρύ.');
});

test('an ungrounded Greek or French note falls back to the neutral credit, with no English words', () => {
  for (const [language, note] of [
    ['Greek', 'Μελαγχολική ηλεκτρονική για αργά το βράδυ.'],
    ['French', 'Une électronique mélancolique pour la fin de soirée.'],
    ['Greek', ''],
  ]) {
    const out = agenticSelectionReason(SEA, note, language);
    assert.equal(out, NEUTRAL_SEA, `${language}: ${note}`);
    assert.doesNotMatch(out, ENGLISH_COPY);
  }
  assert.equal(plainAgenticSelectionReason(SEA, 'Greek'), NEUTRAL_SEA);
  assert.equal(plainAgenticSelectionReason({ title: 'The sea' }, 'Greek'), '“The sea”');
  assert.equal(plainAgenticSelectionReason({ artist: 'Morcheeba' }, 'Greek'), 'Morcheeba');
  assert.equal(verifiedAgenticReason('', false, SEA, 'French'), NEUTRAL_SEA);
});

test('an artist-led French note is never rewritten with the English template', () => {
  // The English rewrite fires on an English verb after the artist; a model
  // that slipped one into a French note got "“The sea” by Morcheeba — …".
  const out = agenticSelectionReason(SEA, 'Morcheeba, carries une douceur mélancolique au cœur de la nuit', 'French');
  assert.equal(out, NEUTRAL_SEA);
  assert.doesNotMatch(out, / by /);
});

test('the Agentic note is credited in the neutral form: “Title” — Artist: note', () => {
  assert.equal(
    agenticDiscoverySelectionReason(SEA, 'Χαμηλή ένταση, στοχαστική και μελαγχολική ηλεκτρονική', [], 'Greek'),
    '“The sea” — Morcheeba: Χαμηλή ένταση, στοχαστική και μελαγχολική ηλεκτρονική.',
  );
  // A dense-script note is measured by its weight, and takes no Latin full stop.
  assert.equal(
    agenticDiscoverySelectionReason(SEA, '夜更けに合う、物憂げで穏やかな電子音', [], 'Japanese'),
    '“The sea” — Morcheeba: 夜更けに合う、物憂げで穏やかな電子音',
  );
});

test('English notes and fallbacks are unchanged', () => {
  assert.equal(agenticSelectionReason(SEA, 'vague'), '“The sea” by Morcheeba offers a strong musical fit with the current flow.');
  assert.equal(agenticSelectionReason(SEA, 'Morcheeba fits the late hush'), '“The sea” by Morcheeba — fits the late hush.');
  assert.equal(agenticDiscoverySelectionReason(SEA, 'low-energy, reflective, melancholic electronica'),
    '“The sea” by Morcheeba — low-energy, reflective, melancholic electronica.');
  assert.equal(shortlistClauseSelectionReason(SEA, '[musical reason unavailable]'),
    '“The sea” by Morcheeba — its musical character fits the surrounding sequence naturally.');
  assert.equal(shortlistClauseSelectionReason(SEA, 'I love its warm bassline under the fragile vocal'),
    '“The sea” by Morcheeba — its musical character fits the surrounding sequence naturally.');
});

test('the Shortlist clause keeps its language: no English floor, no lower-casing, no first-person scrub', () => {
  // "me" is a French pronoun, not an English first person.
  assert.equal(shortlistClauseSelectionReason(SEA, 'Une douceur mélancolique qui me ramène à la mer', 'French'),
    '“The sea” — Morcheeba: Une douceur mélancolique qui me ramène à la mer.');
  // Its own full stop stays single.
  assert.equal(shortlistClauseSelectionReason(SEA, 'ゆったりしたビートと憂いのある声が夜更けに合う。', 'Japanese'),
    '“The sea” — Morcheeba: ゆったりしたビートと憂いのある声が夜更けに合う。');
  for (const unusable of ['[musical reason unavailable]', 'κοντό', '', 'à suivre: next up for you']) {
    const out = shortlistClauseSelectionReason(SEA, unusable, 'Greek');
    assert.equal(out, NEUTRAL_SEA, unusable);
    assert.doesNotMatch(out, ENGLISH_COPY);
  }
  assert.equal(shortlistReasonForLeanings('', false, SEA, 'Greek'), NEUTRAL_SEA);
});

test('a Leanings replacement is worded without the English sentence', () => {
  const out = agenticLeaningsSelectionReason({
    replacement: SEA, djName: 'Niki', basis: 'trip-hop', language: 'Greek',
    musicalReason: 'Η ζεστή γραμμή του μπάσου κάτω από την εύθραυστη φωνή.',
  });
  assert.equal(out, '“The sea” — Morcheeba: Η ζεστή γραμμή του μπάσου κάτω από την εύθραυστη φωνή (trip-hop)');
  assert.equal(agenticLeaningsSelectionReason({ replacement: SEA, djName: 'Niki', basis: 'trip-hop', musicalReason: '', language: 'Greek' }),
    '“The sea” — Morcheeba (trip-hop)');
  // It still names the track, so the final grounding keeps it.
  assert.equal(verifiedAgenticReason(agenticSelectionReason(SEA, out, 'Greek'), true, SEA, 'Greek'), out);
});

// --- the routes, end to end -----------------------------------------------------

const PORCELAIN = { id: 'moby-porcelain', title: 'Porcelain', artist: 'Moby', album: 'Play', duration: 241 };
const ANGEL = { id: 'ma-angel', title: 'Angel', artist: 'Massive Attack', album: 'Mezzanine', duration: 379 };
const TEARDROP = { id: 'ma-teardrop', title: 'Teardrop', artist: 'Massive Attack', album: 'Mezzanine', duration: 330 };
const SYMPATHY = { id: 'ma-sympathy', title: 'Unfinished Sympathy', artist: 'Massive Attack', album: 'Blue Lines', duration: 308 };
const GLORY = { id: 'ph-glory', title: 'Glory Box', artist: 'Portishead', album: 'Dummy', duration: 306 };

type Llm = { body: any; tools: boolean };
const llmCalls: Llm[] = [];
let librarySongs: any[] = [];
let answer: (body: any) => Record<string, unknown> = () => ({});
const realFetch = globalThis.fetch;
const realRun = pickerAgent.run;

async function onAir(language: string) {
  const p = persona(language, 'p_on_air');
  await settings.update({ personas: [p], activePersonaId: p.id } as never);
}

before(async () => {
  await settings.update({
    tts: { enabled: false },
    llm: {
      trackSelection: 'agentic', dailyTokenCap: 0, artistVarietyWindow: 0, noRepeatWindow: 0, shortlistPasses: 1,
      provider: 'openai-compatible', model: 'pick-language-test', compatibleMode: 'local',
      baseUrl: 'http://pick-language-model.invalid/v1', apiKey: 'test', fallback: { enabled: false },
    },
  } as never);
  await library.load();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === 'pick-language-library.invalid') {
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
    if (url.hostname !== 'pick-language-model.invalid' || !url.pathname.endsWith('/chat/completions')) {
      return new Response('not here', { status: 404 });
    }
    const body = JSON.parse(String(init?.body ?? '{}'));
    const tools = Array.isArray(body.tools) ? body.tools : [];
    llmCalls.push({ body, tools: tools.length > 0 });
    if (!tools.length) return chatCompletionResponse({ message: { role: 'assistant', content: 'link' } });
    return chatCompletionResponse({
      message: {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: tools[0].function.name, arguments: JSON.stringify(answer(body)) } }],
      },
    });
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  pickerAgent.run = realRun;
  if (queue._persistTimer) clearTimeout(queue._persistTimer);
  if (queue._recentPlaysTimer) clearTimeout(queue._recentPlaysTimer);
  library.shutdown();
  await removeTempDir(stateRoot);
});

function context() {
  return {
    at: new Date().toISOString(), activeShow: null, clock: getClockContext(),
    time: getTimeContext(), date: getDateContext(), dominantMood: null,
    weather: null, festival: null, showHandover: null, listeners: { count: null }, episodeEditorial: '',
  };
}

function freshQueue(track: any) {
  const q = Object.create(queue);
  q.current = track ? { track, source: 'ai' } : null;
  q.upcoming = []; q.history = []; q.djLog = []; q._recentPlays = []; q.senderBusy = true;
  q.log = () => {};
  return q;
}

const systemOf = (call: Llm) => String(call.body.messages.find((m: any) => m.role === 'system')?.content ?? '');

test('Agentic route, Greek host: the Booth line is the Greek note under the neutral credit', async () => {
  await onAir('Greek');
  for (const [reason, expected] of [
    ['Βαριά, αργή απειλή μετά την ησυχία του Porcelain', '“Angel” — Massive Attack: Βαριά, αργή απειλή μετά την ησυχία του Porcelain.'],
    // Names another candidate: the plain copy, in no language at all.
    ['Η εύθραυστη φωνή του Teardrop βαθαίνει τη νύχτα', '“Angel” — Massive Attack'],
  ]) {
    await settings.update({ llm: { trackSelection: 'agentic' } } as never);
    session.start(context() as any);
    const q = freshQueue(PORCELAIN);
    pickerAgent.run = (async () => ({
      object: { transition: null, id: ANGEL.id, reason }, steps: 2,
      toolCalls: [{ name: 'searchLibrary', args: { query: 'Massive Attack' }, result: [], round: 1 }],
      extras: { seen: new Map([TEARDROP, ANGEL, SYMPATHY].map((s) => [s.id, slim(s)])) },
    })) as any;
    try {
      await runTrackEvent(q, context(), { wantLink: false });
    } finally {
      pickerAgent.run = realRun;
      if (q._persistTimer) clearTimeout(q._persistTimer);
    }
    assert.equal(q.upcoming[0]?.track.id, ANGEL.id);
    assert.equal(q.upcoming[0].intent, expected, reason);
    assert.doesNotMatch(q.upcoming[0].intent, ENGLISH_COPY);
    const turn = session.getSession()?.messages.filter((m: any) => m.role === 'dj' && m.kind === 'pick').at(-1);
    assert.equal(turn?.text, expected, 'the next pick reads the same note');
  }
});

test('Track Shortlist route, French host: the prompt asks for French and the clause is kept as written', async () => {
  await onAir('French');
  librarySongs = [TEARDROP, ANGEL, SYMPATHY, GLORY];
  await settings.update({ llm: { trackSelection: 'shortlist' } } as never);
  try {
    for (const [musicalReason, expected] of [
      ['Sa ligne de basse lourde me plonge dans la nuit sans briser le calme', '“Angel” — Massive Attack: Sa ligne de basse lourde me plonge dans la nuit sans briser le calme.'],
      ['[musical reason unavailable]', '“Angel” — Massive Attack'],
    ]) {
      clearPickerSourceCache();
      llmCalls.length = 0;
      answer = () => ({ id: ANGEL.id, musicalReason, transition: null });
      session.start(context() as any);
      const q = freshQueue(null);
      try { await runTrackEvent(q, context(), { wantLink: false }); } finally { if (q._persistTimer) clearTimeout(q._persistTimer); }
      assert.equal(q.upcoming[0]?.track.id, ANGEL.id);
      assert.equal(q.upcoming[0].intent, expected, musicalReason);
      assert.equal(llmCalls.length, 1, 'the one Shortlist call');
      assert.match(systemOf(llmCalls[0]!), /write "musicalReason" in French\./);
    }
  } finally {
    await settings.update({ llm: { trackSelection: 'agentic' } } as never);
  }
});

test('the pool, Japanese host: the one-shot prompt asks for Japanese; an English host\'s does not', async () => {
  librarySongs = [TEARDROP, ANGEL, SYMPATHY, GLORY];
  for (const [language, asked] of [['Japanese', true], ['English', false]] as const) {
    await onAir(language);
    clearPoolCache();
    clearPickerSourceCache();
    llmCalls.length = 0;
    const reason = language === 'Japanese' ? '重く遅いグルーヴが夜を深める' : 'A slow, heavy groove deepens the late-night mood.';
    answer = () => ({ id: ANGEL.id, reason });
    const result = await pickViaPool(freshQueue(PORCELAIN), context());
    assert.equal(result?.song.id, ANGEL.id);
    assert.equal(result?.reason, reason);
    assert.equal(llmCalls.length, 1);
    const system = systemOf(llmCalls[0]!);
    if (asked) assert.match(system, /write the "reason" field in Japanese\./);
    else assert.doesNotMatch(system, /NOTE LANGUAGE/);
  }
});

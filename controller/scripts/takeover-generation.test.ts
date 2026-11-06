// Real preview/activation flow with a tiny SQLite library and a stubbed LLM transport.
import assert from 'node:assert/strict';
import test, { beforeEach, afterEach, after, mock } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const root = createTempDir(join(tmpdir(), 'subwave-takeover-generation-'));
process.env.STATE_DIR = root;
process.env.NAVIDROME_URL = 'http://127.0.0.1:9';
process.env.NAVIDROME_USER = 'fixture';
process.env.NAVIDROME_PASS = 'fixture';
const settings = await import('../src/settings.js');
const library = await import('../src/music/library.js');
const db = await import('../src/music/library-db.js');
const { showSchema, SHOW_GENERATION_TEMPLATES } = await import('../src/schemas/show.js');
const { generateShowPlan } = await import('../src/broadcast/show-generation.js');
const { DJ_SOULS } = await import('../src/settings/vocab.js');
const { discoveryPalette } = await import('../src/broadcast/show-discovery-policy.js');
const { showPreparation, generateAcceptedShowPlan } = await import('../src/broadcast/show-preparation.js');
const { prepareTakeoverPreview, activateTakeoverPreview, takeoverPreviewRequestSchema } = await import('../src/broadcast/takeover-generation.js');
await settings.load();
await library.load();
const epoch = Date.parse('2026-10-26T08:00:00Z');
const persona = { ...settings.get().personas[0], id: 'p_fixture', name: 'Alex Vale', soul: 'Enjoys folk music.', musicLean: '' };
const request = () => takeoverPreviewRequestSchema.parse({ showId: null, template: 'dj-choice', until: 'fixed', minutes: 60 });
const plan = { name: 'Melody and Space', topic: 'A folk show exploring spare arrangements and memorable melodies.',
  talkingPoint: 'How does an arrangement leave space for a melody?', genres: ['Folk'], moods: [], eras: [], energies: [], filtersStrict: true, rationale: 'A familiar folk palette.' };
let modelCalls = 0;
let refuse = false;
let genresUnavailable = false;
let unavailableStage: 'concept' | 'compiler' | null = null;
let datedBrief = false;
let invalidRepair = false;
let repairCalls = 0;
let compilerPatch: Record<string, unknown> = {};
let planningTemplate: typeof SHOW_GENERATION_TEMPLATES[number] = 'dj-choice';
let conceptEras: Array<{ fromYear: number; toYear: number }> = [];
const guest = { ...persona, id: 'p_guest', name: 'Riley Stone' };
const editorial = { name: plan.name, topic: plan.topic, talkingPoint: plan.talkingPoint,
  moods: plan.moods, energies: plan.energies, rationale: plan.rationale };

beforeEach(async () => {
  mock.timers.enable({ apis: ['Date'], now: epoch });
  modelCalls = 0; refuse = false; genresUnavailable = false; unavailableStage = null;
  datedBrief = false; invalidRepair = false; repairCalls = 0;
  compilerPatch = {}; planningTemplate = 'dj-choice'; conceptEras = [];
  mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'http://127.0.0.1:9', 'No real service may be called');
    if (/\/getGenres(?:\.view)?$/.test(url.pathname)) {
      if (genresUnavailable) return new Response(JSON.stringify({ 'subsonic-response': { status: 'failed',
        error: { code: 0, message: 'Fixture genre lookup unavailable' } } }), { headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ 'subsonic-response': { status: 'ok', genres: {
        genre: [{ value: 'Folk', songCount: 40 }, { value: 'Other', songCount: 20 }],
      } } }), { headers: { 'content-type': 'application/json' } });
    }
    assert.match(String(input), /^http:\/\/127\.0\.0\.1:9\/v1\//, 'No real service may be called');
    modelCalls++;
    const body = JSON.parse(String(init?.body));
    const concept = body.messages.some((message: { content?: string }) => message.content?.includes('mandatory musical-readiness gate'));
    const repair = body.messages.some((message: { content?: string }) => message.content?.includes('Repair only the dated wording'));
    if (concept) assert.match(JSON.stringify(body.messages), /\[\d+ tracks; \d+ artists\]/, 'every concept gets indexed artist breadth');
    if (repair) {
      repairCalls++;
      assert.deepEqual(Object.keys(body.tools[0].function.parameters.properties).sort(), ['name', 'talkingPoint', 'topic']);
    }
    if (!concept && !repair && body.tools?.[0]) {
      assert.deepEqual(Object.keys(body.tools[0].function.parameters.properties).sort(),
        ['energies', 'moods', 'name', 'rationale', 'talkingPoint', 'topic']);
    }
    if (unavailableStage === (concept ? 'concept' : 'compiler')) {
      return new Response(JSON.stringify({ error: { message: 'Fixture provider unavailable', type: 'authentication_error', code: 'invalid_api_key' } }),
        { status: 401, headers: { 'content-type': 'application/json' } });
    }
    const output = concept ? {
      assessment: { problem: refuse ? 'library-fit' : 'none', reason: refuse ? 'No coherent musical fit.' : '',
        evidence: (planningTemplate === 'common-ground' ? [persona, guest] : [persona])
          .map(p => ({ personaId: p.id, source: 'soul', quote: settings.get().personas.find(current => current.id === p.id)?.soul ?? p.soul })) },
      proposal: refuse ? null : { name: plan.name, topic: planningTemplate === 'dj-choice' ? plan.topic
        : 'Alex Vale explores a coherent palette through spare arrangements and memorable melodies. The episode connects familiar musical interests to a focused listening idea, with room for differing perspectives on texture and rhythm.', intendedGenres: plan.genres, eras: conceptEras, talkingPoint: plan.talkingPoint,
        ...(planningTemplate === 'deep-discovery' ? { discoveryFocus: 'A smaller folk neighbourhood connected by spare arrangements.' } : {}),
        ...(planningTemplate === 'common-ground' ? { musicalConnection: { hostTaste: 'Folk songs', guestTaste: 'Folk arrangements', sharedThread: 'Melody and spare instrumentation' } } : {}),
        ...(planningTemplate === 'outside-comfort-zone' ? { departure: { familiarTerritory: 'Folk songs', destination: 'Other', bridge: 'Spare arrangements', whyOutside: 'A different destination from familiar folk' } } : {}),
        ...(planningTemplate === 'time-capsule' ? { period: { fromYear: 1980, toYear: 1984 }, musicalAngle: 'Folk melodies in a covered period' } : {}),
      },
    } : repair ? { name: plan.name, topic: invalidRepair ? 'Folk from the 1980s.' : plan.topic,
      talkingPoint: plan.talkingPoint, genres: ['Other'], eras: [{ fromYear: 1980, toYear: 1989 }] }
      : { ...editorial, ...(datedBrief ? { topic: 'Folk from the 1980s.' } : {}), ...compilerPatch };
    const toolName = body.tools?.[0]?.function?.name;
    const message = toolName
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'fixture', type: 'function', function: { name: toolName, arguments: JSON.stringify(output) } }] }
      : { role: 'assistant', content: JSON.stringify(output) };
    return new Response(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 1, model: 'fixture-model',
      choices: [{ index: 0, message, finish_reason: toolName ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }), { headers: { 'content-type': 'application/json' } });
  });
  await settings.update({ personas: [persona], shows: [], scheduleOverride: null, timezone: 'UTC',
    schedule: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, Array(24).fill(null)])),
    subShows: { eligibleHostPersonaIds: [persona.id], eligibleGuestPersonaIds: [] },
    llm: { artistVarietyWindow: 25, provider: 'openai-compatible', model: 'fixture-model', baseUrl: 'http://127.0.0.1:9/v1',
      compatibleMode: 'local', fallback: { enabled: false } },
  });
  for (const record of await showPreparation.generatedRecords()) await showPreparation.discardPreparedGenerated(record.occurrence.id);
  db.pruneMissingTracks(new Set());
  for (let index = 0; index < 40; index++) {
    const id = `fixture-${index}`;
    db.upsertTrackMeta(id, { title: `Song ${index}`, artist: `Artist ${index}`, genres: ['Folk'], duration: 240 });
    db.upsertTrackTags(id, { moods: ['reflective'], energy: 'low', source: 'llm' });
  }
  library.stats({ fresh: true });
});
afterEach(() => { mock.restoreAll(); mock.timers.reset(); });
after(() => { library.shutdown(); removeTempDir(root); });

function regular(id: string) {
  return { ...showSchema({ personaIds: [persona.id], moodNames: null, themeIds: null, minTrackSeconds: null })
    .parse({ name: 'Regular fixture', personaId: persona.id, genres: ['Folk'] }), id };
}

test('all templates validate zero and one guest with full strict-pool acceptance', async () => {
  await settings.update({ personas: [persona, guest] });
  for (let index = 0; index < 200; index++) {
    db.upsertTrackMeta(`other-${index}`, { title: `Other ${index}`, artist: `Other artist ${index}`, genres: ['Other'], year: 1982, duration: 240 });
    db.upsertTrackTags(`other-${index}`, { moods: ['reflective'], energy: 'low', source: 'llm' });
  }
  for (let index = 0; index < 40; index++) db.upsertTrackMeta(`fixture-${index}`, { year: 1982 });
  library.stats({ fresh: true });
  const customName = "Operator's Fixed Title";
  for (const template of SHOW_GENERATION_TEMPLATES) for (const guestCount of [0, 1]) {
    planningTemplate = template;
    compilerPatch = { name: customName };
    const before = modelCalls;
    const input = { template, planningPrompt: '', nameMode: 'custom' as const, customName,
      configuration: 'guest-matrix', minimumCoverage: null, artistSpacing: 25,
      show: { id: 'fixture' }, cast: { hostPersonaId: persona.id, guestPersonaIds: guestCount ? [guest.id] : [] },
      occurrence: { id: `compiler-${template}-${guestCount}`, showId: 'fixture', source: 'scheduled' as const,
        startsAt: epoch, endsAt: epoch + 3600_000 },
    };
    if ((template === 'common-ground' && guestCount === 0) || (template === 'outside-comfort-zone' && guestCount === 1)) {
      await assert.rejects(generateAcceptedShowPlan(input), /requires a host and exactly one distinct guest|requires a solo host/);
      assert.equal(modelCalls, before, 'unsupported casts fail before model calls');
      continue;
    }
    const generated = await generateAcceptedShowPlan(input);
    assert.equal(modelCalls - before, 2);
    assert.equal(generated.name, customName);
    assert.equal(generated.filtersStrict, true);
    assert.deepEqual(generated.genres, template === 'outside-comfort-zone' ? ['Other'] : ['Folk']);
    assert.deepEqual(generated.eras, template === 'time-capsule' ? [{ fromYear: 1980, toYear: 1984 }] : []);
    assert.match(generated.topic, /Talking point \(optional thread\):/);
  }
});

test('untouched default Souls need persistent actionable guidance before any model call', async () => {
  for (const soul of DJ_SOULS) {
    await settings.update({ personas: [{ ...persona, soul, musicLean: '' }] });
    await assert.rejects(prepareTakeoverPreview(request()), error => {
      assert.match(String(error), /More musical detail needed/);
      assert.match(String(error), /Soul or optional Musical Leanings/);
      assert.match(String(error), /https:\/\/github.com\/perminder-klair\/subwave\/discussions\/1817/);
      return true;
    });
  }
  assert.equal(modelCalls, 0);
  assert.deepEqual(settings.get().shows, []);
  assert.deepEqual(await showPreparation.generatedRecords(), []);
});

test('presentation-only Soul cannot pass readiness using a real but non-musical quotation', async () => {
  await settings.update({ personas: [{ ...persona, soul: 'A relaxed presenter with dry humour.', musicLean: '' }] });
  await assert.rejects(prepareTakeoverPreview(request()), /More musical detail needed/);
  assert.equal(modelCalls, 1);
  assert.equal(settings.get().scheduleOverride, null);
});

test('Common Ground checks musical evidence for the guest as well as the host', async () => {
  planningTemplate = 'common-ground';
  await settings.update({ personas: [persona, { ...guest, soul: 'A welcoming presenter with dry humour.', musicLean: '' }] });
  await assert.rejects(generateShowPlan({ template: 'common-ground', planningPrompt: '', show: { id: 'fixture' },
    cast: { hostPersonaId: persona.id, guestPersonaIds: [guest.id] },
    occurrence: { id: 'sparse-guest', startsAt: epoch, endsAt: epoch + 3600_000 },
  }), /More musical detail needed: Riley Stone/);
  assert.equal(modelCalls, 1);
  assert.deepEqual(await showPreparation.generatedRecords(), []);
});

test('musical Leanings alone support a first show without regular shows', async () => {
  await settings.update({ personas: [{ ...persona, soul: 'A relaxed presenter with dry humour.', musicLean: 'Loves Folk.' }] });
  const preview = await prepareTakeoverPreview(request());
  assert.deepEqual(preview.plan.genres, ['Folk']);
  assert.equal(modelCalls, 2);
  assert.deepEqual(settings.get().shows, []);
});

test('a uniform library cannot pretend to contain underrepresented genres', async () => {
  await assert.rejects(prepareTakeoverPreview({ ...request(), template: 'deep-discovery' }), /no smaller genre pools/);
  assert.equal(modelCalls, 0);
});

test('artist coverage follows zero, default and maximum spacing without relaxing filters', async () => {
  for (let index = 0; index < 40; index++) db.upsertTrackMeta(`fixture-${index}`, { artist: `Artist ${index % 6}` });
  library.stats({ fresh: true });
  for (const spacing of [0, 5, 25]) {
    await settings.update({ llm: { artistVarietyWindow: spacing } });
    const before = modelCalls;
    if (spacing === 25) {
      await assert.rejects(prepareTakeoverPreview(request()), /needs at least 26 distinct artists.*only 6/);
      assert.equal(modelCalls - before, 4);
    } else {
      const preview = await prepareTakeoverPreview(request());
      assert.deepEqual(preview.plan.genres, ['Folk']);
      assert.equal(preview.plan.filtersStrict, true);
      assert.equal(modelCalls - before, 2);
    }
  }
  assert.equal(settings.get().scheduleOverride, null);
});

test('a small diverse library fits a shorter slot but cannot fill twice an hour airtime', async () => {
  await settings.update({ llm: { artistVarietyWindow: 5 } });
  db.pruneMissingTracks(new Set(Array.from({ length: 20 }, (_, index) => `fixture-${index}`)));
  library.stats({ fresh: true });
  const preview = await prepareTakeoverPreview({ ...request(), minutes: 30 });
  assert.equal(preview.plan.filtersStrict, true);
  await assert.rejects(prepareTakeoverPreview(request()), /needs at least 30 eligible tracks.*only 20/);
  assert.equal(settings.get().scheduleOverride, null);
});

test('artist-aware core ranking retains viable rare styles without changing rarity classification', () => {
  const counts = { ...Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`Narrow style ${i}`, 30])), 'Wide style': 30, Mainstream: 10000 };
  const original = discoveryPalette(counts, 15);
  const ranked = discoveryPalette(counts, 15, [], () => 0, { counts: { 'Wide style': 30 }, minimum: 26 });
  assert.equal(original.choices.some(genre => genre.name === 'Wide style'), false);
  assert.equal(ranked.choices[0].name, 'Wide style');
  assert.equal(ranked.choices.some(genre => genre.name === 'Narrow style 0'), false);
  assert.deepEqual(ranked.core, original.core);
  assert.equal(ranked.ceiling, original.ceiling);
  assert.deepEqual(discoveryPalette(counts, 15, [], () => 0, { counts: {}, minimum: 26 }).choices, original.choices);
});

test('thirty-plus tracks from three artists fail the spacing-25 check after one correction', async () => {
  for (let index = 0; index < 40; index++) db.upsertTrackMeta(`fixture-${index}`, { artist: `Small pool artist ${index % 3}` });
  library.stats({ fresh: true });
  await assert.rejects(prepareTakeoverPreview(request()), /needs at least 26 distinct artists.*only 3/);
  assert.equal(modelCalls, 4);
  assert.equal(settings.get().scheduleOverride, null);
  assert.deepEqual(await showPreparation.generatedRecords(), []);
});

test('a single-destination template cannot offer genres already too small for artist spacing', async () => {
  for (let index = 0; index < 40; index++) db.upsertTrackMeta(`fixture-${index}`, { artist: `Small pool artist ${index % 3}` });
  library.stats({ fresh: true });
  await assert.rejects(prepareTakeoverPreview({ ...request(), template: 'outside-comfort-zone' }), /no available genre palette/);
  assert.equal(modelCalls, 0);
  assert.equal(settings.get().scheduleOverride, null);
});

test('Time Capsule repairs partial-decade prose without changing the accepted year range', async () => {
  planningTemplate = 'time-capsule';
  for (let index = 0; index < 40; index++) db.upsertTrackMeta(`fixture-${index}`, { year: 1982 });
  library.stats({ fresh: true });
  compilerPatch = { topic: 'Folk from the mid-1980s.' };
  const preview = await prepareTakeoverPreview({ ...request(), template: 'time-capsule' });
  assert.equal(repairCalls, 1);
  assert.deepEqual(preview.plan.eras, [{ fromYear: 1980, toYear: 1984 }]);
  assert.doesNotMatch(preview.plan.topic, /mid-1980s/);
});

test('compiler attempts to add, remove or broaden fixed filters are ignored', async () => {
  conceptEras = [{ fromYear: 1980, toYear: 1984 }];
  for (const patch of [
    { genres: ['Other'], eras: [], filtersStrict: false },
    { genres: [], eras: [{ fromYear: 1900, toYear: null }], filtersStrict: false },
    { genres: [{ name: 'Other' }], eras: 'not an era', filtersStrict: 'invalid' },
  ]) {
    compilerPatch = patch;
    const generated = await generateShowPlan({ template: 'dj-choice', planningPrompt: '1980–1984 only',
      show: { id: 'fixture' }, cast: { hostPersonaId: persona.id, guestPersonaIds: [] },
      occurrence: { id: 'fixed-contract', startsAt: epoch, endsAt: epoch + 3600_000 },
    });
    assert.deepEqual(generated.genres, ['Folk']);
    assert.deepEqual(generated.eras, conceptEras);
    assert.equal(generated.filtersStrict, true);
  }
});

test('unknown moods and malformed editable fields still reject the compiler response', async () => {
  for (const patch of [{ moods: ['unknown-mood'] }, { energies: ['invalid-energy'] }, { topic: [] }]) {
    compilerPatch = patch;
    await assert.rejects(prepareTakeoverPreview(request()));
    assert.equal(settings.get().scheduleOverride, null);
    assert.deepEqual(await showPreparation.generatedRecords(), []);
  }
});

test('preparing a takeover returns a draft without changing programming or publishing an episode', async () => {
  const preview = await prepareTakeoverPreview(request());
  assert.equal(preview.plan.name, plan.name);
  assert.equal(preview.host.id, persona.id);
  assert.deepEqual(preview.guests, []);
  assert.equal(settings.get().scheduleOverride, null);
  assert.deepEqual(settings.get().shows, []);
  assert.deepEqual(await showPreparation.generatedRecords(), []);
  assert.equal(modelCalls, 2);
});

test('a dated compiler brief gets one prose-only repair without changing strict filters', async () => {
  datedBrief = true;
  const preview = await prepareTakeoverPreview(request());
  assert.equal(modelCalls, 3);
  assert.equal(repairCalls, 1);
  assert.equal(preview.plan.topic, `${plan.topic}\n\nTalking point (optional thread): ${plan.talkingPoint}`);
  assert.deepEqual(preview.plan.genres, ['Folk']);
  assert.deepEqual(preview.plan.eras, []);
  assert.equal(preview.plan.filtersStrict, true);
  assert.equal(settings.get().scheduleOverride, null);
  assert.deepEqual(await showPreparation.generatedRecords(), []);
});

test('a repair that still contradicts the era fails after exactly one repair call', async () => {
  datedBrief = true;
  invalidRepair = true;
  await assert.rejects(prepareTakeoverPreview(request()), /period outside/);
  assert.equal(modelCalls, 3);
  assert.equal(repairCalls, 1);
  assert.equal(settings.get().scheduleOverride, null);
  assert.deepEqual(await showPreparation.generatedRecords(), []);
});

test('activation publishes the exact preview before switching and starts the full duration at activation', async () => {
  const preview = await prepareTakeoverPreview(request());
  mock.timers.setTime(epoch + 90_000);
  const activated = await activateTakeoverPreview(preview.token);
  assert.equal(activated.newlyActivated, true);
  assert.equal(activated.override.startedAt, epoch + 90_000);
  assert.equal(activated.override.expiresAt, epoch + 90_000 + 3600_000);
  assert.deepEqual(settings.get().scheduleOverride, activated.override);
  const [record] = await showPreparation.generatedRecords();
  assert.equal(record.kind, 'ready');
  assert.deepEqual(record.kind === 'ready' && record.plan, preview.plan);
  assert.equal(settings.resolveActiveShow(new Date())?.name, preview.plan.name);
  assert.equal(modelCalls, 2, 'activation must not regenerate');
});

test('simultaneous activation requests share one commit and only one reports a new takeover', async () => {
  const preview = await prepareTakeoverPreview(request());
  const results = await Promise.all([activateTakeoverPreview(preview.token), activateTakeoverPreview(preview.token)]);
  assert.deepEqual(results.map(result => result.newlyActivated).sort(), [false, true]);
  assert.deepEqual(results[0].override, results[1].override);
  assert.equal((await showPreparation.generatedRecords()).length, 1);
  assert.equal((await activateTakeoverPreview(preview.token)).newlyActivated, false);
  assert.equal(modelCalls, 2);
});

test('expired and unknown preview tokens cannot activate programming', async () => {
  const preview = await prepareTakeoverPreview(request());
  mock.timers.setTime(preview.expiresAt + 1);
  for (const token of [preview.token, 'missing-preview-token']) {
    await assert.rejects(activateTakeoverPreview(token), /expired or the controller restarted/);
  }
  assert.equal(settings.get().scheduleOverride, null);
  assert.deepEqual(await showPreparation.generatedRecords(), []);
});

test('changed persona eligibility requires a new preview rather than silently changing the host', async () => {
  const preview = await prepareTakeoverPreview(request());
  await settings.update({ subShows: { eligibleHostPersonaIds: [] } });
  await assert.rejects(activateTakeoverPreview(preview.token), /roster or Sub\/Shows settings changed/);
  assert.equal(settings.get().scheduleOverride, null);
  assert.deepEqual(await showPreparation.generatedRecords(), []);
});

test('a reduced music pool rejects activation and leaves current programming alone', async () => {
  const preview = await prepareTakeoverPreview(request());
  for (let index = 0; index < 20; index++) db.upsertTrackMeta(`fixture-${index}`, { genres: ['Other'] });
  await assert.rejects(activateTakeoverPreview(preview.token), /available music pool changed/);
  assert.equal(settings.get().scheduleOverride, null);
  assert.deepEqual(await showPreparation.generatedRecords(), []);
});

test('a failed switch rolls back the staged plan and preserves an existing regular show', async () => {
  const existing = regular('s_takeover_dj_choice');
  await settings.update({ shows: [existing] });
  const preview = await prepareTakeoverPreview(request());
  await assert.rejects(activateTakeoverPreview(preview.token), /already used by a regular show/);
  assert.equal(settings.get().scheduleOverride, null);
  assert.notEqual(settings.get().shows[0].generation?.mode, 'generated');
  assert.equal(settings.get().shows[0].name, existing.name);
  assert.deepEqual(await showPreparation.generatedRecords(), []);
});

test('changed schedule-change boundaries reject the old preview', async () => {
  const show = regular('s_regular');
  const schedule = structuredClone(settings.get().schedule);
  schedule[1][9] = show.id;
  await settings.update({ shows: [show], schedule });
  const preview = await prepareTakeoverPreview(takeoverPreviewRequestSchema.parse({ showId: null,
    template: 'dj-choice', until: 'schedule-change', expectedEndsAt: epoch + 3600_000 }));
  schedule[1][9] = null; schedule[1][10] = show.id;
  await settings.update({ schedule });
  await assert.rejects(activateTakeoverPreview(preview.token), /schedule window changed/);
  assert.equal(settings.get().scheduleOverride, null);
  assert.deepEqual(await showPreparation.generatedRecords(), []);
});

test('a semantic generation refusal creates no takeover or accepted episode', async () => {
  refuse = true;
  await assert.rejects(prepareTakeoverPreview(request()), /No coherent musical fit/);
  assert.equal(modelCalls, 1);
  assert.equal(settings.get().scheduleOverride, null);
  assert.deepEqual(await showPreparation.generatedRecords(), []);
});

test('unavailable genre metadata cannot turn strict takeover filters into an inactive lock', async () => {
  const preview = await prepareTakeoverPreview(request());
  mock.timers.setTime(epoch + 6 * 60_000); // Expire the genre-name cache, keeping the preview valid.
  genresUnavailable = true;
  await assert.rejects(activateTakeoverPreview(preview.token), /Could not verify.*music filters/);
  assert.equal(settings.get().scheduleOverride, null);
  assert.deepEqual(await showPreparation.generatedRecords(), []);
});

test('provider failures in either call leave programming and accepted episodes untouched', async () => {
  for (const stage of ['concept', 'compiler'] as const) {
    unavailableStage = stage; modelCalls = 0;
    await assert.rejects(prepareTakeoverPreview(request()), /Fixture provider unavailable/);
    assert.equal(modelCalls, stage === 'concept' ? 2 : 3, 'shared SDK recovery may repeat the failed call; no coverage correction starts');
    assert.equal(settings.get().scheduleOverride, null);
    assert.deepEqual(settings.get().shows, []);
    assert.deepEqual(await showPreparation.generatedRecords(), []);
  }
});

test('a provider failure preparing another takeover preserves the already-active accepted show', async () => {
  const preview = await prepareTakeoverPreview(request());
  const active = await activateTakeoverPreview(preview.token);
  const records = await showPreparation.generatedRecords();
  unavailableStage = 'concept';
  await assert.rejects(prepareTakeoverPreview(request()), /Fixture provider unavailable/);
  assert.deepEqual(settings.get().scheduleOverride, active.override);
  assert.deepEqual(await showPreparation.generatedRecords(), records);
  assert.equal(settings.resolveActiveShow(new Date())?.name, preview.plan.name);
});

test('a short pool permits only one concept/compiler correction pair, without activating a fallback show', async () => {
  for (let index = 0; index < 11; index++) db.upsertTrackMeta(`fixture-${index}`, { genres: ['Other'] });
  library.stats({ fresh: true });
  await assert.rejects(prepareTakeoverPreview(request()), /needs at least 30.*only 29/);
  assert.equal(modelCalls, 4, 'two structured calls per proposal, at most two proposals for coverage');
  assert.equal(settings.get().scheduleOverride, null);
  assert.deepEqual(await showPreparation.generatedRecords(), []);
});

test('a small library can support a shorter slot without inventing broader filters', async () => {
  for (let index = 0; index < 11; index++) db.upsertTrackMeta(`fixture-${index}`, { genres: ['Other'] });
  library.stats({ fresh: true });
  const preview = await prepareTakeoverPreview({ ...request(), minutes: 30 });
  assert.deepEqual(preview.plan.genres, ['Folk']);
  assert.equal(preview.plan.filtersStrict, true);
  assert.equal(modelCalls, 2);
  assert.equal(settings.get().scheduleOverride, null);
});

test('a narrow single-genre library cannot fabricate a Deep Discovery rarity core', async () => {
  await assert.rejects(prepareTakeoverPreview({ ...request(), template: 'deep-discovery' }), /no smaller genre pools/);
  assert.equal(modelCalls, 0);
  assert.equal(settings.get().scheduleOverride, null);
  assert.deepEqual(await showPreparation.generatedRecords(), []);
});

test('an empty library stops before spending a model call', async () => {
  db.pruneMissingTracks(new Set());
  library.stats({ fresh: true });
  await assert.rejects(prepareTakeoverPreview(request()), /no available genre palette/);
  assert.equal(modelCalls, 0);
  assert.equal(settings.get().scheduleOverride, null);
});

test('indexed tracks without genre metadata cannot fabricate a genre palette', async () => {
  db.pruneMissingTracks(new Set());
  db.upsertTrackMeta('no-genres', { title: 'Fixture Song', artist: 'Fixture Artist', duration: 240 });
  db.upsertTrackTags('no-genres', { moods: ['reflective'], energy: 'low', source: 'llm' });
  library.stats({ fresh: true });
  await assert.rejects(prepareTakeoverPreview(request()), /no available genre palette/);
  assert.equal(modelCalls, 0);
  assert.equal(settings.get().scheduleOverride, null);
});

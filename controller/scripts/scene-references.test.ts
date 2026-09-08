// The referenced-by warning on a scene merge (#1593). A merge retires a source
// value, and a show, blocklist rule or playlist filter still naming it then
// matches nothing, silently. The boundary held here is which merges are HARMLESS:
// show filters fold case AND punctuation and let a track's tag refine the filter,
// so "rock" → "Rock" and "Hip-Hop" → "Hip Hop" orphan nothing — and, the subtler
// half, a "Punk" show catches "Punk Rock", so retiring it narrows without orphaning.
// Run: npm test -- scene-references

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const STATE = mkdtempSync(join(tmpdir(), 'subwave-scene-refs-'));
process.env.STATE_DIR = STATE;

// The three stores are read from disk, so they are written before their importers.
writeFileSync(
  join(STATE, 'schedule.json'),
  JSON.stringify({
    shows: [
      { id: 'sh_night', name: 'Night Bus', personaId: 'p_default0', genres: ['Trip Hop'] },
      { id: 'sh_mixed', name: 'Slow Motion', personaId: 'p_default0', genres: ['trip-hop', 'Ambient'] },
      { id: 'sh_rock', name: 'Loud Hour', personaId: 'p_default0', genres: ['Rock'] },
      { id: 'sh_open', name: 'Freeform', personaId: 'p_default0', genres: [] },
    ],
    schedule: {},
  }),
);
writeFileSync(
  join(STATE, 'blocklist.json'),
  JSON.stringify({
    entries: [],
    rules: [
      {
        id: 'r_trip', label: 'No trip-hop before noon', field: 'genre',
        values: ['Trip-Hop'], season: null, showIds: [], addedAt: '2026-01-01T00:00:00Z',
      },
      {
        // A tag rule matches trackAllTags, genres included, so it IS in scope —
        // but by normText EXACT, which does not fold the hyphen the genre
        // predicate folds. Both halves of that show up below.
        id: 'r_tag', label: 'No trip-hop tag', field: 'tag',
        values: ['trip-hop'], season: null, showIds: [], addedAt: '2026-01-01T00:00:00Z',
      },
      {
        // A mood is a vocabulary a genre merge cannot reach — out of scope.
        id: 'r_mood', label: 'No melancholy', field: 'mood',
        values: ['melancholy'], season: null, showIds: [], addedAt: '2026-01-01T00:00:00Z',
      },
    ],
  }),
);
writeFileSync(
  join(STATE, 'playlist-recipes.json'),
  JSON.stringify({
    version: 1,
    recipes: [
      {
        playlistId: 'pl_1', name: 'Sunday Comedown',
        recipe: { knobs: { genres: ['Trip Hop', 'Downtempo'] }, sources: {} },
        perSyncCap: 25, createdAt: '2026-01-01T00:00:00Z', lastSyncedAt: null, lastResult: null,
      },
      {
        // A recipe with no genre knob has nothing to orphan.
        playlistId: 'pl_2', name: 'Recently Added',
        recipe: { knobs: {}, sources: { recentlyAdded: true } },
        perSyncCap: 25, createdAt: '2026-01-01T00:00:00Z', lastSyncedAt: null, lastResult: null,
      },
    ],
  }),
);

const refs = await import('../src/music/scene-references.js');
const settings = await import('../src/settings.js');
const blocklist = await import('../src/music/blocklist.js');
const sceneVocab = await import('../src/music/scene-vocab.js');

type SceneFilter = refs.SceneFilter;
type SceneReferenceRow = refs.SceneReference;

const show = (id: string, name: string, values: string[]): SceneFilter =>
  ({ kind: 'show', mode: 'genre', id, name, values });
const tagRule = (id: string, name: string, values: string[]): SceneFilter =>
  ({ kind: 'rule', mode: 'tag', id, name, values });


test('a semantic rename orphans the filter that names the retired value', () => {
  const out = refs.orphanedFilters([show('sh1', 'Night Bus', ['Trip Hop'])], ['trip-hop'], 'Downtempo');
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    kind: 'show', id: 'sh1', name: 'Night Bus', orphaned: ['Trip Hop'], remaining: [],
  });
});

test('a case-only merge orphans nothing', () => {
  // "rock" → "Rock" is a real merge (two stored rows), but normGenre folds case,
  // so no filter noticed the difference.
  assert.deepEqual(refs.orphanedFilters([show('sh1', 'Loud Hour', ['rock'])], ['rock'], 'Rock'), []);
  assert.deepEqual(refs.orphanedFilters([show('sh1', 'Loud Hour', ['Rock'])], ['rock'], 'Rock'), []);
  assert.deepEqual(refs.orphanedFilters([show('sh1', 'Loud Hour', ['ROCK'])], ['Rock'], 'rock'), []);
});

test('a punctuation-only merge orphans nothing', () => {
  // The scene listing keeps "Hip Hop" and "Hip-Hop" apart on purpose — which
  // spelling survives is the operator's call — but normGenre strips the hyphen,
  // so every filter naming either one still matches after the fold.
  for (const filterValue of ['Hip Hop', 'Hip-Hop', 'hiphop']) {
    assert.deepEqual(
      refs.orphanedFilters([show('sh1', 'Beats', [filterValue])], ['Hip-Hop'], 'Hip Hop'),
      [],
      `"${filterValue}" should survive Hip-Hop → Hip Hop`,
    );
  }
});

test('a filter the survivor still refines is not orphaned', () => {
  // Matching is one-directional: a track's tag may refine a show's genre. A
  // "Punk" show still matches tracks tagged "Post-Punk", so retiring "Punk
  // Rock" into it costs that show nothing.
  assert.deepEqual(
    refs.orphanedFilters([show('sh1', 'Basement', ['Punk'])], ['Punk Rock'], 'Post-Punk'),
    [],
  );
  // The reverse direction is NOT match: a "Punk Rock" show asked for something
  // narrower than plain "Punk", so folding its value into "Punk" does orphan it.
  const out = refs.orphanedFilters([show('sh1', 'Basement', ['Punk Rock'])], ['Punk Rock'], 'Punk');
  assert.deepEqual(out.map(r => r.orphaned), [['Punk Rock']]);
});

test('a filter that only CATCHES the retired value has narrowed, not broken', () => {
  // A "Punk" show catches "Punk Rock" by refinement, so a one-way test called it
  // orphaned. Narrowing happens on nearly every overlapping merge and drowns the
  // warnings that are real breakage.
  assert.deepEqual(
    refs.orphanedFilters([show('sh1', 'Basement', ['Punk'])], ['Punk Rock'], 'Downtempo'),
    [],
  );
  // The distinction is mutual coverage, and the matcher answers both halves.
  assert.equal(refs.filterCatchesScene('genre', 'Punk', 'Punk Rock'), true);
  assert.equal(refs.filterNamesScene('genre', 'Punk', 'Punk Rock'), false);
  // …while a value that IS the retired spelling names it, punctuation and all.
  assert.equal(refs.filterNamesScene('genre', 'Trip Hop', 'trip-hop'), true);
  assert.equal(refs.filterNamesScene('genre', 'Hip-Hop', 'Hip Hop'), true);
});

test('a tag rule uses its own stricter predicate', () => {
  // field: 'tag' matches trackAllTags — genres among them — by normText EXACT,
  // which folds case and whitespace but NOT punctuation. So a tag rule naming
  // the retired spelling goes quiet on that namespace…
  assert.deepEqual(
    refs.orphanedFilters([tagRule('r1', 'No trip hop', ['trip hop'])], ['Trip Hop'], 'Downtempo')
      .map(r => r.orphaned),
    [['trip hop']],
  );
  // …but a punctuation variant is a different tag entirely, where the genre
  // predicate would have folded the two together.
  assert.deepEqual(
    refs.orphanedFilters([tagRule('r1', 'No trip-hop', ['trip-hop'])], ['Trip Hop'], 'Downtempo'),
    [],
  );
  // And refinement is not a tag match at all, in either direction.
  assert.equal(refs.filterCatchesScene('tag', 'Punk', 'Punk Rock'), false);
  assert.equal(refs.filterCatchesScene('genre', 'Punk', 'Punk Rock'), true);
});

test('a filter that never named the retired value is untouched', () => {
  assert.deepEqual(
    refs.orphanedFilters([show('sh1', 'Loud Hour', ['Rock', 'Metal'])], ['trip-hop'], 'Downtempo'),
    [],
  );
});

test('remaining is the rest of that filter\'s own list', () => {
  const out = refs.orphanedFilters(
    [show('sh1', 'Slow Motion', ['Trip-Hop', 'Ambient'])],
    ['trip-hop'],
    'Downtempo',
  );
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].orphaned, ['Trip-Hop']);
  // The other value on the SAME show only, not a claim that Ambient still matches.
  assert.deepEqual(out[0].remaining, ['Ambient']);
});

test('a merge with no sources, or no target, warns about nothing', () => {
  const filters = [show('sh1', 'Night Bus', ['Trip Hop'])];
  assert.deepEqual(refs.orphanedFilters(filters, [], 'Downtempo'), []);
  assert.deepEqual(refs.orphanedFilters(filters, ['   '], 'Downtempo'), []);
  assert.deepEqual(refs.orphanedFilters(filters, ['trip-hop'], ''), []);
});

test('a filter value that normalises to nothing is never reported', () => {
  // "—" survives the trim and normalises to '' — matching it against anything
  // would report every filter on every merge.
  assert.deepEqual(refs.orphanedFilters([show('sh1', 'Odd', ['—'])], ['trip-hop'], 'Downtempo'), []);
});


test('shows project on genres, and a show with none is not a filter', () => {
  assert.deepEqual(
    refs.showFilters([
      { id: 'sh1', name: 'Night Bus', genres: ['Trip Hop'] },
      { id: 'sh2', name: 'Freeform', genres: [] },
      { id: 'sh3', name: 'Legacy' },
    ]),
    [{ kind: 'show', mode: 'genre', id: 'sh1', name: 'Night Bus', values: ['Trip Hop'] }],
  );
});

test('genre AND tag rules are scanned, each with its own predicate', () => {
  // A tag rule matches trackAllTags, which is genres ∪ moods ∪ audio moods ∪
  // Last.fm tags — so a genre merge silences it on the genre namespace exactly
  // like a genre rule. The five other fields name values from vocabularies a
  // genre merge cannot reach.
  const rules = [
    { id: 'r1', label: 'No trip-hop', field: 'genre' as const, values: ['Trip-Hop'], season: null, showIds: [], addedAt: '' },
    { id: 'r2', label: 'No trip-hop tag', field: 'tag' as const, values: ['trip-hop'], season: null, showIds: [], addedAt: '' },
    { id: 'r3', label: 'No sad songs', field: 'mood' as const, values: ['melancholy'], season: null, showIds: [], addedAt: '' },
    { id: 'r4', label: 'Empty', field: 'genre' as const, values: [], season: null, showIds: [], addedAt: '' },
  ];
  assert.deepEqual(refs.ruleFilters(rules), [
    { kind: 'rule', mode: 'genre', id: 'r1', name: 'No trip-hop', values: ['Trip-Hop'] },
    { kind: 'rule', mode: 'tag', id: 'r2', name: 'No trip-hop tag', values: ['trip-hop'] },
  ]);
});

test('playlist recipes project on knobs.genres', () => {
  const entries = [
    {
      playlistId: 'pl_1', name: 'Comedown',
      recipe: { knobs: { genres: ['Trip Hop'] }, sources: {} },
      perSyncCap: 25, createdAt: '', lastSyncedAt: null, lastResult: null,
    },
    {
      playlistId: 'pl_2', name: 'Fresh',
      recipe: { knobs: { moods: ['warm'] }, sources: {} },
      perSyncCap: 25, createdAt: '', lastSyncedAt: null, lastResult: null,
    },
  ];
  assert.deepEqual(refs.recipeFilters(entries), [
    { kind: 'playlist', mode: 'genre', id: 'pl_1', name: 'Comedown', values: ['Trip Hop'] },
  ]);
});


test('the scan reads shows, blocklist rules and playlist recipes', async () => {
  await settings.load();
  await blocklist.load();

  const found = refs.collectSceneFilters();
  const byId = new Map(found.map(f => [f.id, f]));
  assert.equal(byId.get('sh_night')?.kind, 'show');
  assert.deepEqual(byId.get('sh_night')?.values, ['Trip Hop']);
  assert.equal(byId.get('r_trip')?.kind, 'rule');
  assert.equal(byId.get('r_trip')?.mode, 'genre');
  assert.equal(byId.get('r_trip')?.name, 'No trip-hop before noon');
  assert.equal(byId.get('r_tag')?.mode, 'tag');
  assert.equal(byId.get('pl_1')?.kind, 'playlist');
  assert.deepEqual(byId.get('pl_1')?.values, ['Trip Hop', 'Downtempo']);
  // A show with no genres, a rule on a vocabulary a genre merge cannot reach,
  // and a knobless recipe are not filters over scene values at all.
  assert.equal(byId.has('sh_open'), false);
  assert.equal(byId.has('r_mood'), false);
  assert.equal(byId.has('pl_2'), false);
});

test('a semantic rename names every kind that still references it', async () => {
  const out = await refs.sceneReferences(['Trip-Hop', 'trip-hop', 'Trip Hop'], 'Downtempo');
  const names = out.map(r => `${r.kind}:${r.id}`).sort();
  // The tag rule is in because this merge retires "trip-hop" verbatim.
  assert.deepEqual(
    names,
    ['playlist:pl_1', 'rule:r_tag', 'rule:r_trip', 'show:sh_mixed', 'show:sh_night'],
  );
  // The mixed show keeps Ambient; the playlist keeps Downtempo, which IS the
  // survivor — so neither goes fully quiet and the row says so.
  assert.deepEqual(out.find(r => r.id === 'sh_mixed')?.remaining, ['Ambient']);
  assert.deepEqual(out.find(r => r.id === 'pl_1')?.remaining, ['Downtempo']);
  assert.deepEqual(out.find(r => r.id === 'sh_night')?.remaining, []);
  // The Rock show and the mood rule are not in it at all.
  assert.equal(out.some(r => r.id === 'sh_rock' || r.id === 'r_mood'), false);
});

test('the harmless merge produces no warning against the real stores', async () => {
  assert.deepEqual(await refs.sceneReferences(['rock'], 'Rock'), []);
});

test('a punctuation merge is harmless to genre filters and NOT to a tag rule', async () => {
  // "Trip-Hop" → "trip hop" is a pure punctuation fold, so genre filters ride it
  // out. The tag rule does not: its predicate folds case and whitespace only, which
  // is why tag rules are scanned with their own predicate rather than waved off.
  const out = await refs.sceneReferences(['Trip-Hop'], 'trip hop');
  assert.deepEqual(out.map(r => r.id), ['r_tag']);
  assert.deepEqual(out[0]!.orphaned, ['trip-hop']);
  assert.deepEqual(out[0]!.remaining, []);
});

test('the target is resolved through the rule set before the scan', async () => {
  // The typed target is itself already retired; recordMerge resolves it through to
  // the survivor, so the warning has to as well.
  await sceneVocab.recordMerge(['Downtempo'], 'Ambient Techno');
  try {
    // Slow Motion filters on "Ambient", the retired spelling; "Ambient Techno"
    // survives and "Ambient" still catches it by refinement.
    const out = await refs.sceneReferences(['ambient'], 'Downtempo');
    assert.equal(out.some(r => r.id === 'sh_mixed'), false);
    const typed = refs.orphanedFilters(refs.collectSceneFilters(), ['ambient'], 'Downtempo');
    assert.deepEqual(typed.find(r => r.id === 'sh_mixed')?.orphaned, ['Ambient']);
  } finally {
    await sceneVocab.forget('downtempo');
  }
});


delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;

const express = (await import('express')).default;
const db = await import('../src/music/library-db.js');
const library = await import('../src/music/library.js');
const { router } = await import('../src/routes/library.js');

await library.load();
db.upsertTrackMeta('t1', { title: 't1', artist: 'Someone', album: 'A Record', genres: ['Trip Hop'] });
db.upsertTrackMeta('t2', { title: 't2', artist: 'Someone', album: 'A Record', genres: ['rock'] });

const app = express();
app.use(express.json());
app.use(router);
const server = createServer(app);
await new Promise<void>(r => { server.listen(0, '127.0.0.1', () => r()); });
// unref, or the listening socket holds the event loop open and the test FILE
// never exits — which under run-tests.ts (concurrency 1) wedges the suite.
server.unref();
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const post = async (path: string, body: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};

test('POST /library/scenes/references names what a rename would orphan', async () => {
  const res = await post('/library/scenes/references', { from: ['Trip Hop'], to: 'Downtempo' });
  assert.equal(res.status, 200);
  const found = res.body.references as SceneReferenceRow[];
  // Every spelling that folds onto "Trip Hop" through normGenre is named, not just
  // the one the operator ticked. The TAG rule spelled "trip-hop" is not: its own
  // predicate does not fold the hyphen, and the scan has to disagree with it.
  assert.deepEqual(
    found.map(r => `${r.kind}:${r.id}`).sort(),
    ['playlist:pl_1', 'rule:r_trip', 'show:sh_mixed', 'show:sh_night'],
  );
  assert.deepEqual(found.find(r => r.id === 'sh_night')?.orphaned, ['Trip Hop']);
  assert.deepEqual(found.find(r => r.id === 'sh_mixed')?.remaining, ['Ambient']);
});

test('POST /library/scenes/references stays quiet on a case merge', async () => {
  const res = await post('/library/scenes/references', { from: ['rock'], to: 'Rock' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.references, []);
});

test('the preview and the merge response give the same answer', async () => {
  const preview = await post('/library/scenes/references', { from: ['Trip Hop'], to: 'Downtempo' });
  const merged = await post('/library/scenes/merge', { from: ['Trip Hop'], to: 'Downtempo' });
  assert.equal(merged.status, 200);
  assert.equal(merged.body.tracksChanged, 1);
  // Warning only: the merge ran in full with the shows left exactly as they were.
  assert.deepEqual(db.getTrack('t1')!.genres, ['Downtempo']);
  assert.deepEqual(merged.body.references, preview.body.references);
  assert.equal((merged.body.references as SceneReferenceRow[]).length, 4);
});

test('a body the merge would refuse is refused here the same way', async () => {
  const res = await post('/library/scenes/references', { from: [], to: 'Downtempo' });
  assert.equal(res.status, 400);
});

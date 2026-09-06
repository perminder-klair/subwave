// The referenced-by warning on a scene merge (#1593), split out of #1591 where
// it was raised against #1580.
//
// A merge retires a source value. The library ends up correct either way — the
// operator asked for it — but a show, blocklist rule or playlist filter still
// naming the retired spelling then matches nothing, with no error and no
// visible cause: the schedule quietly stops working. The warning names which.
//
// The boundary this file exists to hold is which merges are HARMLESS. Show
// filters resolve through show-filter's normGenre + genreMatches, which fold
// case AND punctuation and let a track's tag refine the filter — so "rock" →
// "Rock" and "Hip-Hop" → "Hip Hop" orphan nothing, and warning about them is
// how the operator learns to click past the warning that matters.
//
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

// The three stores are read from disk, so they are written BEFORE the modules
// that read them are imported — that is the shape a real controller boots in,
// and the whole point of the integration half below.
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
        // Same value, different FIELD — a tag that reads like a genre is not a
        // scene, and the tag vocabulary is untouched by a genre merge.
        id: 'r_tag', label: 'No trip-hop tag', field: 'tag',
        values: ['trip-hop'], season: null, showIds: [], addedAt: '2026-01-01T00:00:00Z',
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

type GenreFilter = refs.GenreFilter;
type SceneReferenceRow = refs.SceneReference;

const show = (id: string, name: string, genres: string[]): GenreFilter =>
  ({ kind: 'show', id, name, genres });

// ---------------------------------------------------------------------------
// The boundary: which merges orphan a filter and which do not
// ---------------------------------------------------------------------------

test('a semantic rename orphans the filter that names the retired value', () => {
  const out = refs.orphanedFilters([show('sh1', 'Night Bus', ['Trip Hop'])], ['trip-hop'], 'Downtempo');
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    kind: 'show', id: 'sh1', name: 'Night Bus', orphaned: ['Trip Hop'], remaining: [],
  });
});

test('a case-only merge orphans nothing', () => {
  // "rock" → "Rock" is a real merge — two distinct stored rows, and the rule
  // is what stops the next walk writing the retired spelling back — but the
  // filter never noticed the difference, because normGenre folds case. A
  // warning here is a warning on the most common merge in the section.
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

test('a filter that never named the retired value is untouched', () => {
  assert.deepEqual(
    refs.orphanedFilters([show('sh1', 'Loud Hour', ['Rock', 'Metal'])], ['trip-hop'], 'Downtempo'),
    [],
  );
});

test('remaining says whether the whole genre constraint goes quiet', () => {
  const out = refs.orphanedFilters(
    [show('sh1', 'Slow Motion', ['Trip-Hop', 'Ambient'])],
    ['trip-hop'],
    'Downtempo',
  );
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].orphaned, ['Trip-Hop']);
  // Ambient still selects tracks, so this show narrows rather than dies — the
  // difference between "fix this now" and "have a look".
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

// ---------------------------------------------------------------------------
// Projections — where a genre filter lives
// ---------------------------------------------------------------------------

test('shows project on genres, and a show with none is not a filter', () => {
  assert.deepEqual(
    refs.showFilters([
      { id: 'sh1', name: 'Night Bus', genres: ['Trip Hop'] },
      { id: 'sh2', name: 'Freeform', genres: [] },
      { id: 'sh3', name: 'Legacy' },
    ]),
    [{ kind: 'show', id: 'sh1', name: 'Night Bus', genres: ['Trip Hop'] }],
  );
});

test('only field=genre blocklist rules are scanned', () => {
  const rules = [
    { id: 'r1', label: 'No trip-hop', field: 'genre' as const, values: ['Trip-Hop'], season: null, showIds: [], addedAt: '' },
    { id: 'r2', label: 'No trip-hop tag', field: 'tag' as const, values: ['trip-hop'], season: null, showIds: [], addedAt: '' },
    { id: 'r3', label: 'Empty', field: 'genre' as const, values: [], season: null, showIds: [], addedAt: '' },
  ];
  assert.deepEqual(refs.ruleFilters(rules), [
    { kind: 'rule', id: 'r1', name: 'No trip-hop', genres: ['Trip-Hop'] },
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
    { kind: 'playlist', id: 'pl_1', name: 'Comedown', genres: ['Trip Hop'] },
  ]);
});

// ---------------------------------------------------------------------------
// The gatherer — against the three real stores
// ---------------------------------------------------------------------------

test('the scan reads shows, blocklist rules and playlist recipes', async () => {
  await settings.load();
  await blocklist.load();

  const found = refs.collectGenreFilters();
  const byId = new Map(found.map(f => [f.id, f]));
  // A pure test would pass on all of this while reading the wrong store, or
  // the wrong field of the right one.
  assert.equal(byId.get('sh_night')?.kind, 'show');
  assert.deepEqual(byId.get('sh_night')?.genres, ['Trip Hop']);
  assert.equal(byId.get('r_trip')?.kind, 'rule');
  assert.equal(byId.get('r_trip')?.name, 'No trip-hop before noon');
  assert.equal(byId.get('pl_1')?.kind, 'playlist');
  assert.deepEqual(byId.get('pl_1')?.genres, ['Trip Hop', 'Downtempo']);
  // A show with no genres, a non-genre rule and a knobless recipe are not
  // genre filters at all.
  assert.equal(byId.has('sh_open'), false);
  assert.equal(byId.has('r_tag'), false);
  assert.equal(byId.has('pl_2'), false);
});

test('a semantic rename names every kind that still references it', () => {
  const out = refs.sceneReferences(['Trip-Hop', 'trip-hop', 'Trip Hop'], 'Downtempo');
  const names = out.map(r => `${r.kind}:${r.id}`).sort();
  assert.deepEqual(names, ['playlist:pl_1', 'rule:r_trip', 'show:sh_mixed', 'show:sh_night']);
  // The mixed show keeps Ambient; the playlist keeps Downtempo, which IS the
  // survivor — so neither goes fully quiet and the row says so.
  assert.deepEqual(out.find(r => r.id === 'sh_mixed')?.remaining, ['Ambient']);
  assert.deepEqual(out.find(r => r.id === 'pl_1')?.remaining, ['Downtempo']);
  assert.deepEqual(out.find(r => r.id === 'sh_night')?.remaining, []);
  // The Rock show and the tag rule are not in it at all.
  assert.equal(out.some(r => r.id === 'sh_rock' || r.id === 'r_tag'), false);
});

test('the harmless merge produces no warning against the real stores', () => {
  assert.deepEqual(refs.sceneReferences(['rock'], 'Rock'), []);
  assert.deepEqual(refs.sceneReferences(['Trip-Hop'], 'trip hop'), []);
});

test('the target is resolved through the rule set before the scan', async () => {
  // The operator types a target that is itself already retired. recordMerge
  // resolves it through to the survivor, so the warning has to as well —
  // otherwise the preview names a show the merge will not actually break.
  await sceneVocab.recordMerge(['Downtempo'], 'Ambient Techno');
  try {
    // Slow Motion filters on "Ambient", which the retired "Ambient Dub"
    // matches. What actually survives is "Ambient Techno" — which "Ambient"
    // matches too, so the show loses nothing. Judged against the TYPED
    // "Downtempo" it would have been reported as breaking.
    const out = refs.sceneReferences(['Ambient Dub'], 'Downtempo');
    assert.equal(out.some(r => r.id === 'sh_mixed'), false);
    // And the same scan against a target that resolves nowhere DOES report it,
    // so this is the resolution doing the work and not an unreachable filter.
    const typed = refs.orphanedFilters(refs.collectGenreFilters(), ['Ambient Dub'], 'Downtempo');
    assert.deepEqual(typed.find(r => r.id === 'sh_mixed')?.orphaned, ['Ambient']);
  } finally {
    await sceneVocab.forget('downtempo');
  }
});

// ---------------------------------------------------------------------------
// The routes — the surface the admin panel actually calls
//
// requireAdmin is a no-op with ADMIN_USER/ADMIN_PASS unset (middleware/auth.ts),
// so the router mounts bare. The point of this half is that the PREVIEW and the
// MERGE answer the same question: the panel warns before the confirm and shows
// the result afterwards, and the two disagreeing is the failure that would make
// the warning worse than none.
// ---------------------------------------------------------------------------

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
  // Every spelling that folds onto "Trip Hop" through normGenre is named, not
  // just the one the operator ticked: Slow Motion's "trip-hop" is the same
  // filter as far as the picker is concerned.
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
  // Warning only: the merge ran, in full, with the shows left exactly as they
  // were. Blocking it or repointing the filter are both bigger decisions.
  assert.deepEqual(db.getTrack('t1')!.genres, ['Downtempo']);
  assert.deepEqual(merged.body.references, preview.body.references);
  assert.equal((merged.body.references as SceneReferenceRow[]).length, 4);
});

test('a body the merge would refuse is refused here the same way', async () => {
  const res = await post('/library/scenes/references', { from: [], to: 'Downtempo' });
  assert.equal(res.status, 400);
});

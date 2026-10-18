import assert from 'node:assert/strict';
import test from 'node:test';
import { genreGuardCause, genreLabelKeys, runGenreKeys, runGenreGuard, type GenreGuardDeps } from '../src/broadcast/dj-agent/genre-guard.js';
import { genreKeysWithFamilies } from '../src/broadcast/dj-agent/genre-families.js';
import { aliasMapOf } from '../src/music/scene-vocab.js';

const aliases = aliasMapOf(['Roots Reggae', 'Dub', 'Rocksteady'].map(from => ({ from: from.toLowerCase(), to: 'Reggae', at: '' })));
const keys = (labels: readonly string[]) => genreLabelKeys(labels, aliases);
const rawKeys = (labels: readonly string[]) => genreLabelKeys(labels, new Map());
type Song = { id: string; title: string; artist: string; genres: string[] };
const pick: Song = { id: 'repeat', title: 'Repeat', artist: 'New Artist', genres: ['Dub', 'Reggae', 'Roots Reggae'] };
const other: Song = { id: 'other', title: 'Other', artist: 'Other Artist', genres: ['Soul'] };
const prince: Song = { id: 'prince', title: 'Black Pum Pum', artist: 'Prince Buster', genres: ['Pop', 'International Pop', 'Reggae'] };

function fixture(patch: Partial<GenreGuardDeps<Song>> = {}) {
  const calls: Map<string, Song>[] = [];
  const events: Record<string, unknown>[] = [];
  const lines: string[] = [];
  const deps: GenreGuardDeps<Song> = {
    song: pick, seen: new Map([[pick.id, pick], [other.id, other], [prince.id, prince]]),
    recentGenres: [['Reggae'], ['Roots Reggae'], ['Dub'], ['Rocksteady']].map(keys),
    window: 4, genreKeysOf: s => keys(s.genres), recentRoots: new Set(),
    repick: async alt => { calls.push(alt); return { id: other.id, reason: 'Smooth' }; },
    log: line => lines.push(line), logEvent: (_name, event) => events.push(event),
    ...patch,
  };
  return { deps, calls, events, lines };
}

test('fires exactly when the next pick exceeds the configured aired run', () => {
  const reggae = rawKeys(['Reggae']);
  const history = Array.from({ length: 4 }, () => reggae);
  assert.equal(genreGuardCause(reggae, history.slice(0, 3), 4), false);
  assert.equal(genreGuardCause(reggae, history, 4), true);
  assert.equal(genreGuardCause(rawKeys(['Soul']), history, 4), false);
  assert.equal(genreGuardCause(reggae, [reggae, reggae, rawKeys(['Soul']), reggae], 4), false);
  assert.equal(genreGuardCause(reggae, [reggae, new Set(), reggae, reggae], 4), false);
  assert.equal(genreGuardCause(new Set(), history, 4), false);
  assert.equal(genreGuardCause(reggae, history, 0), false);
  assert.equal(genreGuardCause(reggae, [...history, rawKeys(['Soul'])], 4), true, 'older history is outside the window');
});

test('scene consolidations group subgenres; unconfigured labels remain distinct', async () => {
  assert.deepEqual([...keys(['Roots Reggae', 'Dub', 'Rocksteady', '  REGGAE '])], ['reggae']);
  assert.deepEqual([...rawKeys([' Roots   Reggae ', 'REGGAE', 'reggae', '', ' '])], ['roots reggae', 'reggae']);
  assert.deepEqual([...genreLabelKeys([null, undefined, 42], aliases)], []);
  assert.deepEqual([...rawKeys(['Hip Hop', 'Hip-Hop'])], ['hip hop', 'hip-hop'], 'punctuation stays distinct');
  const { deps, calls, events } = fixture();
  assert.equal((await runGenreGuard(deps)).kind, 'repicked');
  assert.deepEqual([...calls[0].keys()], [other.id]);
  assert.deepEqual(events[0].genres, ['reggae']);
  assert.equal(events[0].relaxed, false);
});

test('run labels are the full-window intersection, never a union or pairwise overlap', async () => {
  const history = [['Pop', 'Reggae'], ['Dub', 'Reggae'], ['Roots Reggae', 'Reggae'], ['Rocksteady', 'Reggae']].map(rawKeys);
  assert.deepEqual([...runGenreKeys(history, 4)], ['reggae']);
  assert.deepEqual([...runGenreKeys([rawKeys(['Pop', 'Reggae']), rawKeys(['Reggae', 'Dub']), rawKeys(['Dub', 'Pop'])], 3)], []);
  const { deps, calls } = fixture({ recentGenres: history, genreKeysOf: s => rawKeys(s.genres) });
  assert.equal((await runGenreGuard(deps)).kind, 'repicked');
  assert.deepEqual([...calls[0].keys()], [other.id]);
});

for (const song of [prince, { ...pick, artist: 'Jacob Miller' }]) {
  test(`${song.artist}'s non-primary Reggae label extends a Reggae run without aliases`, async () => {
    const { deps, calls } = fixture({ song, recentGenres: Array.from({ length: 4 }, () => rawKeys(['Reggae'])), genreKeysOf: s => rawKeys(s.genres) });
    assert.equal((await runGenreGuard(deps)).kind, 'repicked');
    assert.deepEqual([...calls[0].keys()], [other.id], 'neither multi-label reggae shape is a valid alternative');
  });
}

test('a pick sharing ANY run label fires; alternatives must carry NONE and a known label', async () => {
  const dub = { ...pick, genres: ['Dub'] };
  const reggae = { ...prince, genres: ['Pop', 'Reggae'] };
  const unknown = { ...other, id: 'unknown', genres: [] };
  const { deps, calls, events } = fixture({
    song: dub, genreKeysOf: s => rawKeys(s.genres),
    recentGenres: Array.from({ length: 4 }, () => rawKeys(['Reggae', 'Dub'])),
    seen: new Map([dub, reggae, other, unknown].map(s => [s.id, s])),
  });
  assert.equal((await runGenreGuard(deps)).kind, 'repicked');
  assert.deepEqual([...calls[0].keys()], [other.id]);
  assert.deepEqual(events[0].genres, ['reggae', 'dub']);
});

test('no common full-window label stays quiet even with pairwise overlap', async () => {
  const { deps, calls, events } = fixture({ recentGenres: [['Reggae', 'Soul'], ['Soul', 'Dub'], ['Dub', 'Reggae'], ['Reggae']].map(rawKeys) });
  assert.deepEqual(await runGenreGuard(deps), { kind: 'none' });
  assert.deepEqual([calls, events], [[], []]);
});

test('off is unchanged, without even looking up metadata or walking candidates', async () => {
  const { deps, calls, events, lines } = fixture({
    window: 0, genreKeysOf: () => { throw new Error('must not read'); },
    seen: { [Symbol.iterator]() { throw new Error('must not walk'); } },
  });
  assert.deepEqual(await runGenreGuard(deps), { kind: 'none' });
  assert.deepEqual([calls, events, lines], [[], [], []]);
});

test('no proven non-overlapping candidate keeps the original and logs, without a model call', async () => {
  const unknown = { ...other, genres: [] };
  const { deps, calls, events, lines } = fixture({ seen: new Map([[pick.id, pick], [prince.id, prince], [other.id, unknown]]) });
  assert.deepEqual(await runGenreGuard(deps), { kind: 'kept' });
  assert.equal(calls.length, 0);
  assert.equal(events[0].reason, 'no-other-genre');
  assert.match(lines[0], /allowed/);
});

for (const id of [null, 'outside', pick.id, prince.id]) {
  test(`failed or invalid re-pick (${id}) keeps the original and logs`, async () => {
    let calls = 0;
    const { deps, events } = fixture({ repick: async () => { calls++; return id ? { id } : null; } });
    assert.deepEqual(await runGenreGuard(deps), { kind: 'kept' });
    assert.equal(calls, 1);
    assert.equal(events[0].reason, 'repick-failed');
  });
}

test('artist spacing may relax but a successful anchor exclusion survives', async () => {
  const { deps, calls, events } = fixture({ recentRoots: new Set(['other artist']) });
  assert.equal((await runGenreGuard(deps)).kind, 'repicked');
  assert.equal(events[0].artistStarved, true);
  assert.equal(calls.length, 1);
  const blocked = fixture({ avoidAnchorRoot: 'other artist' });
  assert.equal((await runGenreGuard(blocked.deps)).kind, 'kept');
  assert.equal(blocked.calls.length, 0);
});

// Family rule: a shared label OR the same small built-in family.
const famKeys = (labels: readonly string[]) => genreKeysWithFamilies(labels, new Map());
const ska: Song = { id: 'ska', title: 'Ska', artist: 'Ska Artist', genres: ['Ska'] };
const lovers: Song = { id: 'lovers', title: 'Lovers', artist: 'Lovers Artist', genres: ['Lovers Rock'] };
const fam = (patch: Partial<GenreGuardDeps<Song>> = {}) => fixture({
  song: ska, seen: new Map([ska, lovers, other].map(s => [s.id, s])),
  recentGenres: [['Reggae'], ['Roots Reggae'], ['Dub'], ['Rocksteady']].map(famKeys),
  genreKeysOf: s => famKeys(s.genres), ...patch,
});

test('same family with no shared label still forms a run, and a pick in the family extends it', async () => {
  const { deps, calls, events } = fam();
  assert.deepEqual([...runGenreKeys(deps.recentGenres, 4)], ['family:reggae']);
  assert.equal((await runGenreGuard(deps)).kind, 'repicked');
  assert.deepEqual([...calls[0].keys()], [other.id], 'only the outside-family candidate is offered');
  assert.deepEqual(events[0].genres, ['family:reggae']);
  assert.equal(events[0].steered, false);
});

test('a mixed-family window is not a run; a shared label alone still is', () => {
  const history = [['Reggae'], ['Roots Reggae'], ['Soul'], ['Dub']].map(famKeys);
  assert.deepEqual([...runGenreKeys(history, 4)], []);
  const soulRun = Array.from({ length: 4 }, () => famKeys(['Soul']));
  assert.deepEqual([...runGenreKeys(soulRun, 4)], ['soul'], 'unknown labels fall back to label overlap');
});

test('unknown labels: a different unknown label is outside the run, an unlabelled track is not an alternative', async () => {
  const soul = { ...other, id: 'soul', genres: ['Soul'] };
  const blank = { ...other, id: 'blank', genres: [] };
  const offered: string[][] = [];
  const { deps } = fam({
    seen: new Map([ska, soul, blank].map(s => [s.id, s])),
    repick: async alt => { offered.push([...alt.keys()]); return { id: 'soul' }; },
  });
  assert.equal((await runGenreGuard(deps)).kind, 'repicked');
  assert.deepEqual(offered, [['soul']]);
});

test('every candidate in the family: one steer call, then the re-pick draws from its results', async () => {
  let steerCalls = 0;
  const { deps, calls, events, lines } = fam({
    seen: new Map([ska, lovers].map(s => [s.id, s])),
    steer: async () => { steerCalls++; return new Map([[lovers.id, lovers], [other.id, other]]); },
  });
  const out = await runGenreGuard(deps);
  assert.equal(out.kind, 'repicked');
  assert.equal(steerCalls, 1);
  assert.deepEqual([...calls[0].keys()], [other.id], 'steered in-family tracks are filtered out too');
  assert.equal(events[0].steered, true);
  assert.match(lines[0], /steer-away/);
});

test('the steer call is skipped when an outside candidate already exists', async () => {
  let steerCalls = 0;
  const { deps } = fam({ steer: async () => { steerCalls++; return new Map(); } });
  assert.equal((await runGenreGuard(deps)).kind, 'repicked');
  assert.equal(steerCalls, 0);
});

for (const [name, result] of [['empty', new Map<string, Song>()], ['null', null], ['all in family', new Map([[lovers.id, lovers]])]] as const) {
  test(`steer returns ${name}: keep the original pick and log it`, async () => {
    let repicks = 0;
    const { deps, events, lines } = fam({
      seen: new Map([ska, lovers].map(s => [s.id, s])),
      steer: async () => result, repick: async () => { repicks++; return { id: other.id }; },
    });
    assert.deepEqual(await runGenreGuard(deps), { kind: 'kept' });
    assert.equal(repicks, 0);
    assert.equal(events[0].reason, 'steer-empty');
    assert.equal(events[0].steered, true);
    assert.match(lines[0], /allowed/);
  });
}

test('a throwing steer call keeps the original pick', async () => {
  const { deps, events } = fam({
    seen: new Map([[ska.id, ska]]),
    steer: async () => { throw new Error('index offline'); },
  });
  assert.deepEqual(await runGenreGuard(deps), { kind: 'kept' });
  assert.equal(events[0].reason, 'steer-empty');
});

test('a steered candidate the model cannot land keeps the original pick', async () => {
  const { deps, events } = fam({
    seen: new Map([[ska.id, ska]]),
    steer: async () => new Map([[other.id, other]]), repick: async () => null,
  });
  assert.deepEqual(await runGenreGuard(deps), { kind: 'kept' });
  assert.equal(events[0].reason, 'repick-failed');
  assert.equal(events[0].steered, true);
});

test('off makes no steer call and no reads', async () => {
  const { deps, events } = fam({
    window: 0, steer: async () => { throw new Error('must not call'); },
    genreKeysOf: () => { throw new Error('must not read'); },
  });
  assert.deepEqual(await runGenreGuard(deps), { kind: 'none' });
  assert.deepEqual(events, []);
});

test('no run means no steer call', async () => {
  const { deps } = fam({
    recentGenres: [['Reggae'], ['Soul'], ['Dub'], ['Ska']].map(famKeys),
    steer: async () => { throw new Error('must not call'); },
  });
  assert.deepEqual(await runGenreGuard(deps), { kind: 'none' });
});

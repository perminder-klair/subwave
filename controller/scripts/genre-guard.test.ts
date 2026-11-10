import assert from 'node:assert/strict';
import test from 'node:test';
import { genreGuardApplies, runGenreGuard, withGenreRepick, type GenreGuardDeps } from '../src/broadcast/dj-agent/genre-guard.js';
import { genreKeysWithFamilies } from '../src/broadcast/dj-agent/genre-families.js';

// Labels arrive already consolidated by the operator's scene aliases.
const keys = (labels: readonly string[]) => genreKeysWithFamilies(labels);
type Song = { id: string; title: string; artist: string; genres: string[] };
const pick: Song = { id: 'repeat', title: 'Repeat', artist: 'New Artist', genres: ['Dub', 'Reggae', 'Roots Reggae'] };
const other: Song = { id: 'other', title: 'Other', artist: 'Other Artist', genres: ['Soul'] };
const prince: Song = { id: 'prince', title: 'Black Pum Pum', artist: 'Prince Buster', genres: ['Pop', 'International Pop', 'Reggae'] };
const reggaeRun = () => Array.from({ length: 4 }, () => keys(['Reggae']));

function fixture(patch: Partial<GenreGuardDeps<Song>> = {}) {
  const calls: Map<string, Song>[] = [];
  const prompts: string[] = [];
  const events: Record<string, unknown>[] = [];
  const lines: string[] = [];
  const deps: GenreGuardDeps<Song> = {
    song: pick, seen: new Map([[pick.id, pick], [other.id, other], [prince.id, prince]]),
    recentGenres: reggaeRun(),
    window: 4, genreKeysOf: s => keys(s.genres), recentRoots: new Set(),
    repick: async (alt, reason) => { calls.push(alt); prompts.push(reason); return { id: other.id, reason: 'Smooth' }; },
    log: line => lines.push(line), logEvent: (_name, event) => events.push(event),
    ...patch,
  };
  return { deps, calls, prompts, events, lines };
}

// Whether the guard treats `song` as extending a run over `recent`.
async function fires(song: Song, recent: Song['genres'][], window = 4) {
  const { deps } = fixture({ song, recentGenres: recent.map(keys), window });
  return (await runGenreGuard(deps)).kind !== 'none';
}

test('fires exactly when the next pick exceeds the configured run', async () => {
  const reggae = { ...pick, genres: ['Reggae'] };
  const soul = { ...other, id: 'soul-pick', genres: ['Soul'] };
  const run = Array.from({ length: 4 }, () => ['Reggae']);
  assert.equal(await fires(reggae, run.slice(0, 3)), false, 'three airings are not yet a run of four');
  assert.equal(await fires(reggae, run), true);
  assert.equal(await fires(soul, run), false);
  assert.equal(await fires(reggae, [['Reggae'], ['Reggae'], ['Soul'], ['Reggae']]), false);
  assert.equal(await fires(reggae, [['Reggae'], [], ['Reggae'], ['Reggae']]), false, 'an unlabelled track breaks the run');
  assert.equal(await fires({ ...reggae, genres: [] }, run), false, 'an unlabelled pick extends nothing');
  assert.equal(await fires(reggae, run, 0), false);
  assert.equal(await fires(reggae, [...run, ['Soul']]), true, 'older tracks are outside the window');
  assert.equal(await fires(reggae, [['Reggae']], 1), true, 'a window of one');
});

test('a run is named as the newest track spells it; separators do not split a genre', async () => {
  const { deps, calls, prompts, events } = fixture({
    song: { ...pick, genres: ['Neo Soul'] },
    seen: new Map([[pick.id, { ...pick, genres: ['Neo Soul'] }], ['funk', { ...other, id: 'funk', genres: ['Funk'] }], ['neo', { ...other, id: 'neo', genres: ['neo-soul'] }]]),
    recentGenres: [['Neo-Soul'], ['Neo Soul'], ['NEO SOUL'], ['neo-soul']].map(keys),
    repick: async (alt, reason) => { calls.push(alt); prompts.push(reason); return { id: 'funk' }; },
  });
  assert.equal((await runGenreGuard(deps)).kind, 'repicked');
  assert.deepEqual([...calls[0].keys()], ['funk'], 'a differently spelled Neo-Soul is no alternative');
  assert.deepEqual(events[0].genres, ['neosoul']);
  assert.match(prompts[0], /\["Neo-Soul"\]/);
});

test('run labels are the full-window intersection, never a union or pairwise overlap', async () => {
  const history = [['Pop', 'Reggae'], ['Dub', 'Reggae'], ['Roots Reggae', 'Reggae'], ['Rocksteady', 'Reggae']];
  const { deps, calls, events } = fixture({ recentGenres: history.map(keys) });
  assert.equal((await runGenreGuard(deps)).kind, 'repicked');
  assert.deepEqual([...calls[0].keys()], [other.id]);
  assert.deepEqual(events[0].genres, ['reggae', 'family:reggae']);
  const soul = { ...other, id: 'soul-pick', genres: ['Soul'] };
  assert.equal(await fires(soul, [['Pop', 'Soul'], ['Soul', 'Funk'], ['Funk', 'Pop']], 3), false, 'pairwise overlap is not a run');
});

for (const song of [prince, { ...pick, artist: 'Jacob Miller' }]) {
  test(`${song.artist}'s non-primary Reggae label extends a Reggae run`, async () => {
    const { deps, calls } = fixture({ song });
    assert.equal((await runGenreGuard(deps)).kind, 'repicked');
    assert.deepEqual([...calls[0].keys()], [other.id], 'neither multi-label reggae shape is a valid alternative');
  });
}

test('a pick sharing ANY run label fires; alternatives must carry NONE and a known label', async () => {
  const dub = { ...pick, genres: ['Dub'] };
  const reggae = { ...prince, genres: ['Pop', 'Reggae'] };
  const unknown = { ...other, id: 'unknown', genres: [] };
  const { deps, calls, events } = fixture({
    song: dub,
    recentGenres: Array.from({ length: 4 }, () => keys(['Reggae', 'Dub'])),
    seen: new Map([dub, reggae, other, unknown].map(s => [s.id, s])),
  });
  assert.equal((await runGenreGuard(deps)).kind, 'repicked');
  assert.deepEqual([...calls[0].keys()], [other.id]);
  assert.deepEqual(events[0].genres, ['reggae', 'family:reggae', 'dub']);
});

test('no common full-window label stays quiet even with pairwise overlap', async () => {
  const { deps, calls, events } = fixture({
    song: { ...pick, genres: ['Funk', 'Soul', 'Pop'] },
    recentGenres: [['Funk', 'Soul'], ['Soul', 'Pop'], ['Pop', 'Funk'], ['Funk']].map(keys),
  });
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

test('a genre re-pick never undoes artist spacing or the anchor exclusion', async () => {
  // The only outside-run candidate is by a recently played artist: the pick stands.
  const spaced = fixture({ recentRoots: new Set(['other artist']) });
  assert.deepEqual(await runGenreGuard(spaced.deps), { kind: 'kept' });
  assert.equal(spaced.calls.length, 0);
  assert.equal(spaced.events[0].reason, 'artist-spacing');
  assert.match(spaced.lines[0], /artist spacing holds/);
  // With a fresh artist beside it, only the fresh artist is offered.
  const fresh = { ...other, id: 'fresh', artist: 'Fresh Artist', genres: ['Funk'] };
  const narrowed = fixture({ recentRoots: new Set(['other artist']), seen: new Map([pick, other, fresh].map(s => [s.id, s])), repick: async alt => { narrowed.calls.push(alt); return { id: fresh.id }; } });
  assert.equal((await runGenreGuard(narrowed.deps)).kind, 'repicked');
  assert.deepEqual([...narrowed.calls[0].keys()], [fresh.id]);
  const anchored = fixture({ avoidAnchorRoot: 'other artist' });
  assert.deepEqual(await runGenreGuard(anchored.deps), { kind: 'kept' });
  assert.equal(anchored.calls.length, 0);
  assert.equal(anchored.events[0].reason, 'anchor-artist');
});

// Family rule: a shared label OR the same small built-in family.
const ska: Song = { id: 'ska', title: 'Ska', artist: 'Ska Artist', genres: ['Ska'] };
const lovers: Song = { id: 'lovers', title: 'Lovers', artist: 'Lovers Artist', genres: ['Lovers Rock'] };
const fam = (patch: Partial<GenreGuardDeps<Song>> = {}) => fixture({
  song: ska, seen: new Map([ska, lovers, other].map(s => [s.id, s])),
  recentGenres: [['Reggae'], ['Roots Reggae'], ['Dub'], ['Rocksteady']].map(keys),
  genreKeysOf: s => keys(s.genres), ...patch,
});

test('same family with no shared label still forms a run, and a pick in the family extends it', async () => {
  const { deps, calls, events } = fam();
  assert.equal((await runGenreGuard(deps)).kind, 'repicked');
  assert.deepEqual([...calls[0].keys()], [other.id], 'only the outside-family candidate is offered');
  assert.deepEqual(events[0].genres, ['family:reggae']);
  assert.equal(events[0].steered, false);
});

test('a mixed-family window is not a run; a shared label alone still is', async () => {
  assert.equal(await fires(ska, [['Reggae'], ['Roots Reggae'], ['Soul'], ['Dub']]), false);
  const soul = { ...other, id: 'soul-pick', genres: ['Soul'] };
  assert.equal(await fires(soul, Array.from({ length: 4 }, () => ['Soul'])), true, 'unknown labels fall back to label overlap');
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
    recentGenres: [['Reggae'], ['Soul'], ['Dub'], ['Ska']].map(keys),
    steer: async () => { throw new Error('must not call'); },
  });
  assert.deepEqual(await runGenreGuard(deps), { kind: 'none' });
});

test('album cooldown: a fresh-album alternative is offered, a recent-album one never is', async () => {
  const recentAlbum = { ...other, id: 'recent-album', genres: ['Soul'], album: 'Old Record' };
  const freshAlbum = { ...other, id: 'fresh-album', genres: ['Funk'], album: 'New Record' };
  const albumOf = (s: Song & { album?: string }) => s.album ?? '';
  const offered: string[][] = [];
  const base = {
    albumKeyOf: albumOf, recentAlbums: new Set(['Old Record']),
    repick: async (alt: Map<string, Song>) => { offered.push([...alt.keys()]); return { id: [...alt.keys()][0] }; },
  };
  const a = fam({ ...base, seen: new Map([ska, recentAlbum, freshAlbum].map(s => [s.id, s])) });
  assert.equal((await runGenreGuard(a.deps)).kind, 'repicked');
  assert.deepEqual(offered.pop(), ['fresh-album']);

  // Only a recent-album alternative: the pick, which passed the cooldown, stands.
  const b = fam({ ...base, seen: new Map([ska, recentAlbum].map(s => [s.id, s])) });
  assert.deepEqual(await runGenreGuard(b.deps), { kind: 'kept' });
  assert.equal(offered.length, 0);
  assert.equal(b.events[0].reason, 'album-cooldown');

  // Steered candidates are held to the same rule.
  const c = fam({ ...base, seen: new Map([[ska.id, ska]]), steer: async () => new Map([recentAlbum, freshAlbum].map(s => [s.id, s])) });
  assert.equal((await runGenreGuard(c.deps)).kind, 'repicked');
  assert.deepEqual(offered.pop(), ['fresh-album']);

  // Cooldown off (no recent albums) changes nothing.
  const d = fam({ albumKeyOf: albumOf, recentAlbums: new Set(), seen: new Map([ska, recentAlbum, freshAlbum].map(s => [s.id, s])), repick: base.repick });
  assert.equal((await runGenreGuard(d.deps)).kind, 'repicked');
  assert.deepEqual(offered.pop(), ['recent-album', 'fresh-album']);
});

test('an alternative inside both the spacing window and the cooldown keeps a pick that passed both', async () => {
  const soul = { ...other, album: 'Recent Album' };
  let repicks = 0;
  const { deps, events } = fixture({
    seen: new Map([[pick.id, pick], [soul.id, soul]]),
    recentRoots: new Set(['other artist']),
    recentAlbums: new Set(['Recent Album']), albumKeyOf: (s: Song & { album?: string }) => s.album ?? '',
    repick: async () => { repicks++; return { id: soul.id }; },
  });
  assert.deepEqual(await runGenreGuard(deps), { kind: 'kept' });
  assert.equal(repicks, 0);
  assert.equal(events[0].reason, 'album-cooldown');
});

test('the steer call runs only when every candidate is in the run', async () => {
  const blank = { ...other, id: 'blank', genres: [] };
  const byAnchor = { ...other, id: 'by-anchor', artist: 'Anchor Artist' };
  for (const [leftover, patch, reason] of [
    [blank, {}, 'no-other-genre'],
    [byAnchor, { avoidAnchorRoot: 'anchor artist' }, 'anchor-artist'],
  ] as const) {
    let steerCalls = 0;
    const { deps, events } = fam({
      ...patch,
      seen: new Map([[ska.id, ska], [leftover.id, leftover]]),
      steer: async () => { steerCalls++; return new Map([[other.id, other]]); },
    });
    assert.deepEqual(await runGenreGuard(deps), { kind: 'kept' }, leftover.id);
    assert.equal(steerCalls, 0, leftover.id);
    assert.equal(events[0].reason, reason);
  }
});

test('the guard is for whole-library programming: a genre list or an owned direction exempts the pick', () => {
  assert.equal(genreGuardApplies({}, null), true, 'no show, or a show with no genre list');
  assert.equal(genreGuardApplies({}, []), true);
  assert.equal(genreGuardApplies({}, ['Reggae']), false, 'the show chose its genres, soft or strict');
  assert.equal(genreGuardApplies({ episodeSource: { kind: 'artist' } }, null), false, 'a prepared episode');
  assert.equal(genreGuardApplies({ playlistLock: new Set(['a']) }, null), false, 'a strict playlist');
  assert.equal(genreGuardApplies({ audioWaypoint: [0.1, 0.2] }, null), false, 'a sonic journey');
  assert.equal(genreGuardApplies({ audioWaypoint: [] }, null), true, 'an empty waypoint is no journey');
});

test('a genre re-pick is named beside an earlier artist or album re-pick, never over it', () => {
  assert.equal(withGenreRepick('none'), 'genre-repick');
  assert.equal(withGenreRepick(undefined), 'genre-repick');
  assert.equal(withGenreRepick('artist-repick'), 'artist-and-genre-repick');
  assert.equal(withGenreRepick('album-repick'), 'album-and-genre-repick');
  assert.equal(withGenreRepick('artist-and-album-repick'), 'artist-album-and-genre-repick');
});

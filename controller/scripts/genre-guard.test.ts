import assert from 'node:assert/strict';
import test from 'node:test';
import { genreGuardCause, primaryGenreKey, runGenreGuard, type GenreGuardDeps } from '../src/broadcast/dj-agent/genre-guard.js';
import { aliasMapOf } from '../src/music/scene-vocab.js';

const aliases = aliasMapOf(['Roots Reggae', 'Dub', 'Rocksteady'].map(from => ({ from: from.toLowerCase(), to: 'Reggae', at: '' })));
const key = (genre: string) => primaryGenreKey(genre, aliases);
type Song = { id: string; title: string; artist: string; genre: string };
const pick: Song = { id: 'repeat', title: 'Repeat', artist: 'New Artist', genre: 'Dub' };
const other: Song = { id: 'other', title: 'Other', artist: 'Other Artist', genre: 'Soul' };

function fixture(patch: Partial<GenreGuardDeps<Song>> = {}) {
  const calls: Map<string, Song>[] = [];
  const events: Record<string, unknown>[] = [];
  const lines: string[] = [];
  const deps: GenreGuardDeps<Song> = {
    song: pick, seen: new Map([[pick.id, pick], [other.id, other]]),
    recentGenres: ['Reggae', 'Roots Reggae', 'Dub', 'Rocksteady'].map(key),
    window: 4, genreKeyOf: s => key(s.genre), recentRoots: new Set(),
    repick: async alt => { calls.push(alt); return { id: other.id, reason: 'Smooth' }; },
    log: line => lines.push(line), logEvent: (_name, event) => events.push(event),
    ...patch,
  };
  return { deps, calls, events, lines };
}

test('fires exactly when the next pick exceeds the configured aired run', () => {
  assert.equal(genreGuardCause('reggae', ['reggae', 'reggae', 'reggae'], 4), false);
  assert.equal(genreGuardCause('reggae', ['reggae', 'reggae', 'reggae', 'reggae'], 4), true);
  assert.equal(genreGuardCause('soul', ['reggae', 'reggae', 'reggae', 'reggae'], 4), false);
  assert.equal(genreGuardCause('reggae', ['reggae', 'reggae', 'soul', 'reggae'], 4), false);
  assert.equal(genreGuardCause('reggae', ['reggae', '', 'reggae', 'reggae'], 4), false);
  assert.equal(genreGuardCause('', ['', '', '', ''], 4), false);
});

test('scene consolidations group subgenres; unconfigured labels remain distinct', async () => {
  assert.deepEqual(['Roots Reggae', 'Dub', 'Rocksteady', '  REGGAE '].map(key), Array(4).fill('reggae'));
  assert.equal(primaryGenreKey(' Roots   Reggae ', new Map()), 'roots reggae');
  assert.equal(primaryGenreKey(null, aliases), '');
  const { deps, calls, events } = fixture();
  const result = await runGenreGuard(deps);
  assert.equal(result.kind, 'repicked');
  assert.deepEqual([...calls[0].keys()], [other.id]);
  assert.equal(events[0].relaxed, false);
});

test('off is unchanged, without even looking up metadata or walking candidates', async () => {
  const { deps, calls, events, lines } = fixture({ window: 0, genreKeyOf: () => { throw new Error('must not read'); } });
  assert.deepEqual(await runGenreGuard(deps), { kind: 'none' });
  assert.deepEqual([calls, events, lines], [[], [], []]);
});

test('no proven outside-genre candidate keeps the original and logs, without a model call', async () => {
  const unknown = { ...other, genre: '' };
  const { deps, calls, events, lines } = fixture({ seen: new Map([[pick.id, pick], [other.id, unknown]]) });
  assert.deepEqual(await runGenreGuard(deps), { kind: 'kept' });
  assert.equal(calls.length, 0);
  assert.equal(events[0].reason, 'no-other-genre');
  assert.match(lines[0], /allowed/);
});

for (const id of [null, 'outside', pick.id]) {
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

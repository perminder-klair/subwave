// Playlist steer: the pick paths see the active show with the steer's music
// overlay, and nothing else does. Run: npx tsx scripts/steer-show.test.ts
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

const stateRoot = createTempDir(join(tmpdir(), 'subwave-steer-show-'));
process.env.STATE_DIR = stateRoot;

const { steeredShow } = await import('../src/music/steer.js');
const { showNoRepeatGuard } = await import('../src/music/show-recency.js');
const { isInOrderShow } = await import('../src/music/playlist-order.js');
const { steerRequestSchema, steerSchema } = await import('../src/schemas/steer.js');
const settings = await import('../src/settings.js');

after(() => rmSync(stateRoot, { recursive: true, force: true }));

const src = (...p: string[]) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', ...p), 'utf8');
const NOW = Date.now();
const playlistSteer = { playlistId: 'pl-1', prompt: '', startedAt: NOW, expiresAt: NOW + 60 * 60_000 };
const promptSteer = { ...playlistSteer, playlistId: null, prompt: 'more 2020s pop' };
const show = {
  id: 's1', name: 'Evening', topic: 'slow jazz', persona: { id: 'p1' }, guests: [],
  moods: ['calm'], genres: ['Jazz'], eras: [], energies: ['low'], vocals: 'instrumental', filtersStrict: true,
  playlistIds: ['own'], playlistStrict: true, playlistExhaust: false, playlistInOrder: true, excludedPlaylistIds: ['no'],
};
const tracks = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, title: `Track ${i}`, artist: `Artist ${i}` }));

test('a steer needs a playlist or a prompt, and either alone will do', () => {
  assert.equal(steerRequestSchema.safeParse({ until: 'once' }).success, false);
  assert.equal(steerRequestSchema.safeParse({ playlistId: 'pl-1', until: 'once' }).success, true);
  assert.equal(steerRequestSchema.safeParse({ playlistId: '', until: 'once' }).success, false);
  assert.equal(steerSchema({ now: null }).safeParse(playlistSteer).success, true);
  assert.equal(steerSchema({ now: null }).safeParse({ ...playlistSteer, playlistId: null }).success, false);
});

test('a playlist steer makes the show a strict, fully rotated anchor on that playlist and sets its own music rules aside', () => {
  const steered = steeredShow(show, playlistSteer);
  assert.deepEqual(steered.playlistIds, ['pl-1']);
  assert.equal(steered.playlistStrict, true);
  assert.equal(steered.playlistExhaust, true);
  assert.deepEqual(steered.excludedPlaylistIds, []);
  assert.deepEqual([steered.moods, steered.genres, steered.eras, steered.energies], [[], [], [], []]);
  assert.equal(steered.vocals, '');
  assert.equal(steered.filtersStrict, false);
  // Who is on air is not the steer's business.
  assert.deepEqual([steered.id, steered.name, steered.topic, steered.persona], [show.id, show.name, show.topic, show.persona]);
  assert.equal(isInOrderShow(steered), false, 'an in-order show stops walking its own list');
  assert.equal(show.playlistInOrder, true, 'the show itself is not mutated');
});

test('a prompt-only steer changes no field, and no steer changes nothing', () => {
  assert.equal(steeredShow(show, promptSteer), show);
  assert.equal(steeredShow(show, null), show);
  assert.equal(steeredShow(null, promptSteer), null);
});

test('with no show on air a playlist steer still gives the pick paths a show to read', () => {
  const steered = steeredShow(null, playlistSteer);
  assert.equal(steered.id, null);
  assert.equal(steered.persona, null);
  assert.deepEqual(steered.guests, []);
  assert.deepEqual(steered.playlistIds, ['pl-1']);
  assert.equal(steered.playlistStrict, true);
  assert.deepEqual([steered.maxTrackSeconds, steered.minTrackLengthSeconds, steered.fadeAtShowEnd], [null, null, null]);
});

test('the steered show rotates the whole playlist before a repeat, but an artist episode would outrank it', () => {
  const steered = steeredShow(show, playlistSteer);
  const anchor = { show: steered as never, playlistTracks: tracks(10), excludedIds: null };
  assert.deepEqual(showNoRepeatGuard(100, 20_000, anchor), { window: 8, exhaustive: true });
  // Which is why both pick paths set the episode aside under a playlist steer.
  assert.equal(showNoRepeatGuard(100, 20_000, { ...anchor, episodeTracks: tracks(4) }).exhaustive, false);
  assert.deepEqual(showNoRepeatGuard(100, 20_000, { ...anchor, playlistTracks: tracks(2) }), { window: 0, exhaustive: false },
    'two tracks or fewer loop freely');
});

test('the pick show carries the steer up to its end and not past it; the active show never changes', async () => {
  await settings.update({ steer: playlistSteer });
  const before = settings.resolvePickShow(new Date(playlistSteer.expiresAt - 1));
  assert.deepEqual(before?.playlistIds, ['pl-1']);
  assert.equal(settings.resolvePickShow(new Date(playlistSteer.expiresAt)), null,
    'a pick airing at the steer\'s end is the next show\'s, unsteered');
  assert.equal(settings.resolveActiveShow(new Date(playlistSteer.expiresAt - 1)), null, 'no show is on air; a steer does not invent one');
  await settings.update({ steer: null });
});

test('every show read on the pick paths goes through the steer', () => {
  const agent = src('broadcast', 'dj-agent.ts');
  const prompt = src('broadcast', 'dj-agent', 'schemas.ts');
  const pool = src('music', 'picker.ts');
  const shortlist = src('broadcast', 'dj-agent', 'shortlist-pick.ts');
  const searches = src('broadcast', 'shortlist-search-preparation.ts');
  for (const [name, file] of [['shortlist-pick.ts', shortlist], ['shortlist-search-preparation.ts', searches]] as const) {
    assert.ok(!/resolveActiveShow\(/.test(file), `${name} reads the show it is handed, not its own`);
  }
  assert.ok(!/resolveActiveShow\(/.test(agent), 'dj-agent.ts reads the show through resolvePickShow');
  assert.ok(!/resolveActiveShow\(/.test(prompt), 'pickSystem reads the show through resolvePickShow');
  for (const line of pool.split('\n').filter(l => l.includes('resolveActiveShow('))) {
    assert.ok(line.includes('steeredShow('), `picker.ts reads an unsteered show: ${line.trim()}`);
  }
  assert.ok(!/ctx\?\.activeShow\?\.playlistStrict/.test(agent), 'the exploration nudge reads the steered show');
  assert.match(pool, /playlistId\s*\?\s*null\s*:\s*showPreparation\.read\(\{ context: ctx \}\)\.music/,
    'picker.ts sets the artist episode aside under a playlist steer');
  assert.match(agent, /preparedContext && !steeredPlaylist \? showPreparation\.read\(/,
    'dj-agent.ts sets the artist episode aside under a playlist steer');
  assert.match(agent, /preparedContext && steeredPlaylist \? \{ \.\.\.preparedContext, episodeEditorial: '' \}/,
    'and its editorial brief with it');
  assert.match(agent, /const repickSteer = steerClause\(settings\.activeSteer\(/, 'a corrective re-pick is under the steer too');
  assert.equal(agent.match(/\$\{repickSteer\}/g)?.length, 2, 'on both routes');
});

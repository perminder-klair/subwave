// A multi-genre show drifting into one of its genres under the Track
// Shortlist: the controller names the run so the one-shot call can turn away
// from it. A preference only — nothing is filtered — and absent wherever it
// has nothing to say, so those prompts stay byte-identical.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const stateRoot = mkdtempSync(join(tmpdir(), 'subwave-genre-run-'));
process.env.STATE_DIR = stateRoot;
process.env.NAVIDROME_URL = 'http://genre-run.invalid';
const { genreRun, GENRE_RUN_MIN_PLAYS } = await import('../src/music/genre-run.js');
const { shortlistSignals } = await import('../src/broadcast/dj-agent.js');
const { shortlistPickPrompt } = await import('../src/broadcast/dj-agent/shortlist-pick.js');
const { pickerScope } = await import('../src/llm/tools.js');
after(() => rmSync(stateRoot, { recursive: true, force: true }));

const SHOW = ['Punjabi', 'Hip-Hop', 'Soul', 'R&B', 'Electronic'];
const t = (...genres: string[]) => ({ genres });

test('a run of one show genre is named, matched through the one-directional rule', () => {
  // "Punjabi Pop" refines the show's "Punjabi", so it continues the run.
  const recent = [t('Punjabi'), t('Punjabi Pop'), t('Punjabi'), t('Soul'), t('Punjabi')];
  assert.deepEqual(genreRun(recent, SHOW), { genre: 'Punjabi', plays: 3 });
});

test('below the threshold, or broken by another genre, there is no run', () => {
  assert.equal(GENRE_RUN_MIN_PLAYS, 3);
  assert.equal(genreRun([t('Punjabi'), t('Punjabi'), t('Soul')], SHOW), null);
  assert.equal(genreRun([t('Soul'), t('Punjabi'), t('Punjabi'), t('Punjabi')], SHOW), null,
    'the newest track starts the run');
});

test('an untagged track ends the run rather than extending it', () => {
  assert.equal(genreRun([t('Punjabi'), t('Punjabi'), {}, t('Punjabi')], SHOW), null);
  assert.equal(genreRun([t('Punjabi'), null, t('Punjabi'), t('Punjabi')], SHOW), null);
});

test('a track spanning two show genres keeps whichever the run shares', () => {
  const recent = [t('Punjabi Hip-Hop'), t('Hip-Hop'), t('Hip-Hop')];
  assert.deepEqual(genreRun(recent, SHOW), { genre: 'Hip-Hop', plays: 3 });
});

test('a single-genre show, or none, has nowhere else to go', () => {
  const recent = [t('Punjabi'), t('Punjabi'), t('Punjabi'), t('Punjabi')];
  assert.equal(genreRun(recent, ['Punjabi']), null);
  assert.equal(genreRun(recent, []), null);
  assert.equal(genreRun(recent, null), null);
});

test('a broader tag never counts as the show genre it does not refine', () => {
  // Show "R&B" is not covered by a plain "Pop" tag; "Contemporary R&B" refines it.
  assert.equal(genreRun([t('Pop'), t('Pop'), t('Pop')], ['R&B', 'Soul']), null);
  assert.deepEqual(genreRun([t('Contemporary R&B'), t('R&B'), t('R&B')], ['R&B', 'Soul']), { genre: 'R&B', plays: 3 });
});

const queueOf = (...genres: string[]) => ({
  current: { track: { title: 'On Air', artist: 'A', genres: [genres[0]] } },
  history: genres.slice(1).map((g, i) => ({ track: { title: `Before ${i}`, artist: `B${i}`, genres: [g] } })),
});

test('Shortlist signals carry the run for the show\'s genres', () => {
  const signals = shortlistSignals(queueOf('Punjabi', 'Punjabi', 'Punjabi', 'Soul'), pickerScope(), null, SHOW);
  assert.deepEqual(signals.genreRun, { genre: 'Punjabi', plays: 3 });
  assert.equal('genreRun' in shortlistSignals(queueOf('Punjabi', 'Soul', 'Punjabi'), pickerScope(), null, SHOW), false);
});

test('an episode, journey or strict playlist owns the direction, so no run is named', () => {
  const queue = queueOf('Punjabi', 'Punjabi', 'Punjabi');
  for (const scope of [
    pickerScope({ episodeSource: { artist: 'X' } as any }),
    pickerScope({ audioWaypoint: [0.1] }),
    pickerScope({ playlistTracks: [{ id: 'p' }], playlistLock: new Set(['p']) }),
  ]) {
    assert.equal('genreRun' in shortlistSignals(queue, scope, null, SHOW), false);
  }
});

test('the prompt names the run only when there is one', () => {
  const candidates = [{ id: 'x', title: 'X', artist: 'Y', genre: 'Soul' }];
  const withRun = shortlistPickPrompt(candidates, { genreRun: { genre: 'Punjabi', plays: 4 } });
  assert.match(withRun, /genreRun says the last 4 tracks have all been Punjabi/);
  assert.doesNotMatch(shortlistPickPrompt(candidates, {}), /genreRun/);
});

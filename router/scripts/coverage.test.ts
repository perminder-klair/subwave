// subsonic/coverage.ts is a claim about handlers.ts: one row per handler, and
// for every endpoint that leans on an optional op, what the station gets when
// the source lacks it. The admin service matrix shows that claim to the
// operator, so it is checked against the real handlers here, not restated.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENDPOINT_COVERAGE } from '../src/subsonic/coverage.js';
import { handlers } from '../src/subsonic/handlers.js';
import { configWith, startRouter, type RunningRouter } from './helpers.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/plugins');

let r: RunningRouter;

before(async () => {
  r = await startRouter({ pluginsDir: FIXTURES });
  // The `good` fixture implements only the required ops, so every optional
  // op an endpoint can lean on is missing.
  r.writeConfig(configWith([{ plugin: 'good', config: { greeting: 'hi' } }]));
  const resp = await r.internal('/reload', { method: 'POST' });
  assert.equal(resp.status, 200);
});

after(async () => {
  await r.close();
});

test('one coverage row per Subsonic handler, and no row without one', () => {
  const rows = ENDPOINT_COVERAGE.map((row) => row.endpoint).sort();
  assert.deepEqual(rows, Object.keys(handlers).sort());
  assert.equal(new Set(rows).size, rows.length, 'no endpoint listed twice');
});

test('a row names its op and its fallback together, or neither', () => {
  for (const row of ENDPOINT_COVERAGE) {
    assert.equal(row.needs === null, row.whenMissing === null, row.endpoint);
    if (row.needs) assert.ok(row.feature, `${row.endpoint} says what the station loses`);
  }
});

// Enough params for each endpoint to reach the optional op rather than fail on
// a missing argument.
const PARAMS: Record<string, Record<string, string>> = {
  getArtistInfo2: { id: 'good-ar1' },
  getSimilarSongs2: { id: 'good-s1' },
  getTopSongs: { artist: 'Fixture Artist' },
  getSonicSimilarTracks: { id: 'good-s1' },
  star: { id: 'good-s1' },
  unstar: { id: 'good-s1' },
  getPlaylist: { id: 'good-p1' },
  createPlaylist: { name: 'probe', songId: 'good-s1' },
  updatePlaylist: { playlistId: 'good-p1', name: 'renamed' },
  deletePlaylist: { id: 'good-p1' },
  getLyricsBySongId: { id: 'good-s1' },
  scrobble: { id: 'good-s1' },
};

test('every fallback the matrix shows is what the handler really does without the op', async () => {
  const status = (await (await r.internal('/status')).json()) as any;
  for (const row of ENDPOINT_COVERAGE.filter((x) => x.needs)) {
    assert.equal(status.serving.capabilities[row.needs!], false, `the fixture lacks ${row.needs}`);
    const body = await r.rest(row.endpoint, PARAMS[row.endpoint] ?? {});
    const expected = row.whenMissing === 'degraded' ? 'ok' : 'failed';
    assert.equal(body.status, expected, `${row.endpoint} without ${row.needs} should be ${row.whenMissing}`);
  }
});

test('status carries the coverage table and the serving set', async () => {
  const status = (await (await r.internal('/status')).json()) as any;
  assert.equal(status.endpoints.length, ENDPOINT_COVERAGE.length);
  assert.equal(status.serving.name, 'good');
});

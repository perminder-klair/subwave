// The admin Signal path feed (host/activity.ts, GET /internal/activity): which
// source answered each Subsonic request, how long it took and why it failed —
// and never what was asked for.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVITY_CAPACITY, clientOf, redactError } from '../src/host/activity.js';
import { PASS, configWith, startRouter, type RunningRouter } from './helpers.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/plugins');

let r: RunningRouter;

before(async () => {
  r = await startRouter({ pluginsDir: FIXTURES });
});

after(async () => {
  await r.close();
});

async function use(config: unknown): Promise<any> {
  r.writeConfig(config);
  const resp = await r.internal('/reload', { method: 'POST' });
  assert.equal(resp.status, 200);
  return resp.json();
}

async function activity(): Promise<any> {
  const resp = await r.internal('/activity');
  assert.equal(resp.status, 200);
  return resp.json();
}

test('callers are labelled by user agent: curl is Liquidsoap, Node the controller, Python the analyzer', () => {
  assert.equal(clientOf('curl/8.5.0'), 'liquidsoap');
  assert.equal(clientOf('node'), 'controller');
  assert.equal(clientOf('undici'), 'controller');
  assert.equal(clientOf('python-requests/2.32.3'), 'analyzer');
  assert.equal(clientOf('Python-urllib/3.12'), 'analyzer');
  assert.equal(clientOf('Mozilla/5.0 (X11; Linux x86_64)'), 'Mozilla');
  assert.equal(clientOf(undefined), 'unknown');
});

test('an error message keeps a URL path but never its query string', () => {
  const shown = redactError('GET http://plex:32400/library/metadata/1?X-Plex-Token=SEKRIT&a=1 failed (fetch failed)');
  assert.doesNotMatch(shown, /SEKRIT/);
  assert.match(shown, /http:\/\/plex:32400\/library\/metadata\/1\?…/);
  assert.ok(redactError('x'.repeat(1000)).length <= 240);
});

test('the internal activity route needs the router credentials', async () => {
  const anon = await fetch(`${r.base}/internal/activity`);
  assert.equal(anon.status, 401);
});

test('a request records its endpoint, caller and the source call that answered it — not what was asked', async () => {
  await use(configWith([{ plugin: 'mock' }]));
  const hits = await r.rest('search3', { query: 'NEEDLE-IN-THE-QUERY', songCount: 2 });
  assert.equal(hits.status, 'ok');

  const snap = await activity();
  const [latest] = snap.requests;
  assert.equal(latest.endpoint, 'search3');
  assert.equal(latest.client, 'controller');
  assert.equal(latest.state, 'ok');
  assert.equal(typeof latest.ms, 'number');
  // The handler also reads stars to annotate the songs it returns.
  assert.deepEqual(latest.calls[0], { ...latest.calls[0], source: 'mock', op: 'search', state: 'ok' });
  assert.ok(latest.calls.every((c: any) => c.source === 'mock' && c.state === 'ok'));

  const text = JSON.stringify(snap);
  assert.doesNotMatch(text, /NEEDLE/);
  assert.ok(!text.includes(PASS));
  assert.doesNotMatch(text, /[?&](t|s|u)=/);
});

test('a Subsonic error inside a 200 is recorded as failed, with its reason', async () => {
  const before_ = (await activity()).totals.failed;
  const miss = await r.rest('getSong', { id: 'mock-does-not-exist' });
  assert.equal(miss.status, 'failed');
  const snap = await activity();
  assert.equal(snap.requests[0].state, 'error');
  assert.equal(snap.requests[0].error, 'Song not found');
  assert.equal(snap.totals.failed, before_ + 1);
});

test('a refused login is recorded as failed and reaches no source', async () => {
  await fetch(`${r.base}/rest/ping?${r.auth('subwave', 'wrong-password-xxxxxxxx')}`);
  const [latest] = (await activity()).requests;
  assert.equal(latest.endpoint, 'ping');
  assert.equal(latest.state, 'error');
  assert.deepEqual(latest.calls, []);
});

test('a merged set lights only the owner on a routed request and every backend on a fan-out', async () => {
  await use(configWith([{ plugin: 'mock' }, { plugin: 'good', config: { greeting: 'merged' } }], { merge: true }));

  await r.rest('getSong', { id: 'good-s1' });
  const routed = (await activity()).requests[0];
  // The song lookup goes to its owner alone (the star annotation still asks everyone).
  assert.deepEqual(routed.calls.filter((c: any) => c.op === 'song').map((c: any) => c.source), ['good']);

  await r.rest('getGenres');
  const fanned = (await activity()).requests[0];
  assert.deepEqual([...new Set(fanned.calls.map((c: any) => c.source))].sort(), ['good', 'mock']);
});

test('a source without an op is "unsupported", not a failure', async () => {
  // The merged artist index asks every child; the fixture has no artists().
  await r.rest('getArtists');
  const latest = (await activity()).requests[0];
  const good = latest.calls.find((c: any) => c.source === 'good');
  assert.equal(good?.state, 'unsupported');
});

test('the feed is bounded', async () => {
  for (let i = 0; i < ACTIVITY_CAPACITY + 5; i++) await r.rest('ping');
  const snap = await activity();
  assert.equal(snap.requests.length, ACTIVITY_CAPACITY);
  assert.equal(snap.capacity, ACTIVITY_CAPACITY);
  assert.ok(snap.totals.requests >= ACTIVITY_CAPACITY + 5);
});

test('status reports what each plugin supported when last built, and null for one never built', async () => {
  const status = await (await r.internal('/status')).json() as any;
  const byName = new Map(status.plugins.map((p: any) => [p.name, p]));
  assert.equal((byName.get('mock') as any).capabilities.similarSongs, true);
  assert.equal((byName.get('good') as any).capabilities.artists, false);
  assert.equal((byName.get('plex') as any).capabilities, null);
});

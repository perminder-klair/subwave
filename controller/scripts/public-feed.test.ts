// GET /state and GET /session are unauthenticated and open even on a private
// station, so each is an explicit allowlist (util/public-feed.ts) rather than a
// spread of internal state. Pinned here:
//   - /state never carries the booth log (`djLog`), which holds operator
//     diagnostics: settings saves, blocklist edits, upstream error text.
//   - /session reduces each turn's meta to what a booth renders, so an agent's
//     tool trail (`toolCalls`, `steps`) and model-only `promptSuffix` stay in.
//   - The booth log is still readable by an operator, behind requireAdmin, at
//     GET /debug/dj-log, and the MCP state tool picks it up there.
//
// Run: npm test -- public-feed

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir } from './test-utils/temp-dir.js';

const root = createTempDir(join(tmpdir(), 'subwave-public-feed-'));
process.env.STATE_DIR = root;
process.env.ADMIN_USER = 'feed-admin';
process.env.ADMIN_PASS = 'feed-admin-pass';

const { default: express } = await import('express');
const { publicQueueState, publicSessionTurn } = await import('../src/util/public-feed.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const { router: publicRouter } = await import('../src/routes/public.js');
const { router: debugRouter } = await import('../src/routes/debug.js');
const { SubwaveClient } = await import('../src/mcp/client.js');

const app = express();
app.use(publicRouter);
app.use(debugRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

const ADMIN = { authorization: `Basic ${Buffer.from('feed-admin:feed-admin-pass').toString('base64')}` };

// Lines of the kind admin routes and publicError() write to the booth log.
const PRIVATE_LINES = [
  ['scheduler', 'weather location → Flat 4, 12 Example Road (51.5, -0.12) · on air → London'],
  ['scheduler', 'Navidrome connection updated → http://navidrome.internal:4533 (user station-owner)'],
  ['blocked', 'Never-play rule added: artist = Secret Artist'],
  ['error', '/schedule failed: ENOENT /var/sub-wave/settings.json'],
] as const;
const PRIVATE_NEEDLES = ['Example Road', 'navidrome.internal', 'station-owner', 'Secret Artist', '/var/sub-wave'];

test('publicQueueState keeps the queue keys and drops the booth log and anything unnamed', () => {
  const snap = {
    current: { title: 'A' }, upcoming: [{ title: 'B' }], history: [{ title: 'C' }],
    nextTransition: 'crossfade', autoPick: true, autoLink: false, pickerBusy: false,
    djLog: [{ t: 1, kind: 'error', text: 'secret' }],
    someFutureInternal: 'x',
  };
  assert.deepEqual(publicQueueState(snap), {
    current: { title: 'A' }, upcoming: [{ title: 'B' }], history: [{ title: 'C' }],
    nextTransition: 'crossfade', autoPick: true, autoLink: false, pickerBusy: false,
  });
  assert.ok(!('nextTransition' in publicQueueState({ upcoming: [] })), 'a missing key stays absent');
  assert.deepEqual(publicQueueState(null), {});
});

test('publicSessionTurn keeps booth meta and drops tool trails and prompt coaching', () => {
  const turn = {
    t: '2026-10-09T10:00:00.000Z', role: 'dj', kind: 'request', text: 'Coming up next.',
    meta: {
      trackId: 't1', requester: 'Sam', title: 'Song', artist: 'Band', say: 'here it is',
      personaId: 'p1', personaName: 'Nova', airedAt: '2026-10-09T10:00:01.000Z', durationMs: 4200,
      requestedBy: 'Sam', source: 'request', carried: true, carriedFrom: 's_old',
      boundary: { at: 'x', show: 'Late', persona: 'Nova', fromShow: 'Early', fromSessionId: 's_old' },
      toolCalls: [{ name: 'searchLibrary', args: { q: 'x' }, result: { error: 'could not reach http://navidrome:4533' } }],
      steps: 3,
      promptSuffix: ' (coaching)',
    },
  };
  const out = publicSessionTurn(turn);
  assert.deepEqual(Object.keys(out), ['t', 'role', 'kind', 'text', 'meta']);
  for (const k of ['toolCalls', 'steps', 'promptSuffix']) assert.ok(!(k in out.meta), `${k} withheld`);
  const { toolCalls: _t, steps: _s, promptSuffix: _p, ...kept } = turn.meta;
  assert.deepEqual(out.meta, kept);
  assert.deepEqual(publicSessionTurn({ t: 'x', role: 'event', kind: 'scenario', text: 'y' }).meta, {},
    'meta is always an object, as before');
});

test('GET /state carries no booth log, so no operator line reaches it', async () => {
  for (const [kind, text] of PRIVATE_LINES) queue.log(kind, text);
  assert.ok(queue.djLog.length >= PRIVATE_LINES.length, 'the lines are in the booth log');

  const res = await fetch(`${base}/state`);
  assert.equal(res.status, 200);
  const raw = await res.text();
  const body = JSON.parse(raw);
  assert.ok(!('djLog' in body), 'djLog key is absent');
  for (const needle of PRIVATE_NEEDLES) assert.ok(!raw.includes(needle), `${needle} not in /state`);
  // The listener fields the players read are still there.
  assert.ok(Array.isArray(body.upcoming) && Array.isArray(body.history));
  assert.equal(typeof body.privacy?.privatePlayer, 'boolean');
  assert.equal(typeof body.station?.name, 'string');
});

test('GET /session publishes booth meta only', async () => {
  session.start({ at: new Date().toISOString() } as never);
  session.appendTurn({ role: 'event', kind: 'pick', text: 'Pick the next track.', meta: { promptSuffix: ' MODEL-ONLY' } });
  session.appendTurn({
    role: 'dj', kind: 'request', text: 'Here is your track.',
    meta: {
      trackId: 't9', requester: 'Ana',
      toolCalls: [{ name: 'searchLibrary', args: { q: 'x' }, result: { error: 'could not reach http://navidrome.internal:4533' } }],
    },
  });

  const raw = await (await fetch(`${base}/session`)).text();
  const body = JSON.parse(raw);
  assert.ok(!raw.includes('navidrome.internal'), 'tool results stay internal');
  assert.ok(!raw.includes('MODEL-ONLY'), 'prompt coaching stays internal');
  const reply = body.messages.find((m: { kind: string; role: string }) => m.role === 'dj');
  assert.deepEqual(reply.meta, { trackId: 't9', requester: 'Ana' });
});

test('GET /debug/dj-log serves the booth log to an admin only', async () => {
  assert.equal((await fetch(`${base}/debug/dj-log`)).status, 401);
  const res = await fetch(`${base}/debug/dj-log`, { headers: ADMIN });
  assert.equal(res.status, 200);
  const body = await res.json() as { djLog: Array<{ message: string }>; djLogCount: number };
  assert.ok(body.djLog.some((e) => e.message.includes('navidrome.internal')));
  assert.ok(body.djLog.length <= 50);
  assert.equal(body.djLogCount, queue.djLog.length);
});

test('the MCP client reads the booth log only with admin credentials', async () => {
  const admin = new SubwaveClient({ baseUrl: base, adminUser: 'feed-admin', adminPass: 'feed-admin-pass' });
  const log = await admin.boothLog();
  assert.ok(Array.isArray(log) && log.length > 0);

  assert.equal(await new SubwaveClient({ baseUrl: base }).boothLog(), null, 'no credentials: no call');
  const wrong = new SubwaveClient({ baseUrl: base, adminUser: 'feed-admin', adminPass: 'nope' });
  assert.equal(await wrong.boothLog(), null, 'refused credentials degrade, not throw');
});

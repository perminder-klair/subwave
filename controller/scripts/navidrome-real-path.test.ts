// Navidrome's "Report Real Path" on SUB/WAVE's own player rows: which rows are
// ours, the Doctor's reading, and the switch, against a fake Navidrome native
// API (POST /auth/login, GET/PUT /api/player) on a real HTTP socket.
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { config } from '../src/config.js';
import * as settings from '../src/settings.js';
import {
  isOwnPlayer,
  normalizePlayerRow,
  ownPlayers,
  realPathFinding,
  serverKind,
  stateOf,
  type NavidromePlayerRow,
  type RealPathStatus,
} from '../src/music/navidrome-players-policy.js';
import { autoEnableRealPath, realPathStatus, _resetAutoOutcome } from '../src/music/navidrome-players.js';
import { realPathTick } from '../src/broadcast/scheduler.js';

type Row = Record<string, unknown> & { id: string; reportRealPath: boolean };

const fake = {
  mode: 'navidrome' as 'navidrome' | 'not-navidrome' | 'refuse-put',
  // What the Subsonic ping names the server: '' leaves `type` out (a server that does not say).
  serverType: 'navidrome',
  rows: [] as Row[],
  puts: [] as { id: string; body: Record<string, unknown> }[],
  requests: 0,
};

function row(id: string, client: string, userAgent: string, userName: string, on: boolean): Row {
  return { id, client, userAgent, userName, userId: `u-${userName}`, reportRealPath: on, maxBitRate: 0, transcodingId: '', scrobbleEnabled: true, name: `${client} [${userAgent}]`, ip: '10.0.0.2', lastSeen: '2026-10-22T12:00:00Z' };
}

function seed() {
  fake.rows = [
    row('p-node', 'sub-wave', 'node', 'radio', false),
    row('p-admin', 'sub-wave-admin', 'node', 'radio', false),
    row('p-lavf', 'sub-wave', 'Lavf', 'radio', true),
    // Not ours: another app on the same account, a look-alike name, another user.
    row('p-web', 'NavidromeUI', 'Firefox', 'radio', false),
    row('p-probe', 'subwave', 'Python-urllib', 'radio', false),
    row('p-front', 'sub-wavefront', 'node', 'radio', false),
    row('p-other', 'sub-wave', 'node', 'someone-else', false),
  ];
}

async function readBody(req: IncomingMessage): Promise<string> {
  let b = '';
  for await (const c of req) b += c;
  return b;
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  fake.requests++;
  const send = (status: number, body?: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const url = new URL(req.url || '/', 'http://x');
  if (fake.mode === 'not-navidrome') return send(404, { error: 'not found' });
  if (url.pathname === '/rest/ping') {
    return send(200, { 'subsonic-response': { status: 'ok', version: '1.16.1', ...(fake.serverType ? { type: fake.serverType, serverVersion: '0.16.4' } : {}) } });
  }
  if (req.method === 'POST' && url.pathname === '/auth/login') {
    const b = JSON.parse(await readBody(req));
    if (b.username !== 'radio' || b.password !== 'secret') return send(401, { error: 'bad creds' });
    return send(200, { id: 'u-radio', name: 'Radio', username: 'radio', isAdmin: false, token: 'jwt-1' });
  }
  if (req.headers['x-nd-authorization'] !== 'Bearer jwt-1') return send(401, { error: 'no token' });
  if (req.method === 'GET' && url.pathname === '/api/player') return send(200, fake.rows);
  const m = url.pathname.match(/^\/api\/player\/([^/]+)$/);
  const target = m && fake.rows.find(r => r.id === decodeURIComponent(m[1]));
  if (m && !target) return send(404, { error: 'no such player' });
  if (req.method === 'GET' && target) return send(200, target);
  if (req.method === 'PUT' && target) {
    if (fake.mode === 'refuse-put') return send(403, { error: 'forbidden' });
    const body = JSON.parse(await readBody(req));
    fake.puts.push({ id: target.id, body });
    Object.assign(target, body);
    return send(200, target);
  }
  return send(405, {});
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => new Promise<void>(resolve => server.close(() => resolve())));

beforeEach(() => {
  fake.mode = 'navidrome';
  fake.serverType = 'navidrome';
  fake.puts = [];
  fake.requests = 0;
  seed();
  config.navidrome.url = base;
  config.navidrome.user = 'radio';
  config.navidrome.password = 'secret';
  config.navidrome.clientName = 'sub-wave';
  _resetAutoOutcome();
});

const own = { clientName: 'sub-wave', user: 'radio' };
const asRow = (r: Row) => normalizePlayerRow(r) as NavidromePlayerRow;

test('a SUB/WAVE player is our client name or its -suffix, on the station account only', () => {
  seed();
  assert.deepEqual(ownPlayers(fake.rows.map(asRow), own).map(p => p.id), ['p-node', 'p-admin', 'p-lavf']);
  // Navidrome reports the username as stored; the station may have typed it in another case.
  assert.equal(isOwnPlayer(asRow(row('x', 'sub-wave', 'node', 'Radio', false)), own), true);
  // A blank client name owns nothing rather than everything.
  assert.equal(isOwnPlayer(asRow(fake.rows[0]), { clientName: ' ', user: 'radio' }), false);
  assert.equal(isOwnPlayer(asRow(row('x', '', 'node', 'radio', false)), { clientName: '', user: 'radio' }), false);
});

test('a row without an id or client is not a player row', () => {
  assert.equal(normalizePlayerRow(null), null);
  assert.equal(normalizePlayerRow({ client: 'sub-wave' }), null);
  assert.equal(normalizePlayerRow({ id: 'a' }), null);
  const r = normalizePlayerRow({ id: 'a', client: 'sub-wave', reportRealPath: 'yes' });
  assert.equal(r?.reportRealPath, false, 'only a real true counts as on');
  assert.equal(r?.userAgent, '');
});

test('the state is on only when every SUB/WAVE row reports real paths', () => {
  const rows = ownPlayers(fake.rows.map(asRow), own);
  assert.equal(stateOf([]), 'no-players');
  assert.equal(stateOf(rows), 'off');
  assert.equal(stateOf(rows.map(p => ({ ...p, reportRealPath: true }))), 'on');
});

test('reading the players changes nothing in Navidrome', async () => {
  const st = await realPathStatus();
  assert.equal(st.state, 'off');
  assert.deepEqual(st.players.map(p => p.id), ['p-node', 'p-admin', 'p-lavf']);
  assert.deepEqual(st.switched, []);
  assert.equal(fake.puts.length, 0);
});

test('switching turns on our rows that are off, sends the whole row, and leaves every other row alone', async () => {
  const st = await realPathStatus({ enable: true });
  assert.equal(st.state, 'on');
  assert.deepEqual(st.switched, ['p-node', 'p-admin']);
  assert.deepEqual(fake.puts.map(p => p.id), ['p-node', 'p-admin'], 'the row already on is not rewritten');
  const sent = fake.puts[0].body;
  assert.equal(sent.reportRealPath, true);
  // Navidrome's PUT replaces the record: the other fields must ride along unchanged.
  assert.equal(sent.maxBitRate, 0);
  assert.equal(sent.scrobbleEnabled, true);
  assert.equal(sent.client, 'sub-wave');
  for (const id of ['p-web', 'p-probe', 'p-front', 'p-other']) {
    assert.equal(fake.rows.find(r => r.id === id)?.reportRealPath, false, `${id} is not ours`);
  }
});

test('a refused write reports refused with the reason, and no row is claimed as switched', async () => {
  fake.mode = 'refuse-put';
  const st = await realPathStatus({ enable: true });
  assert.equal(st.state, 'refused');
  assert.match(st.reason || '', /403/);
  assert.deepEqual(st.switched, []);
  assert.equal(st.players.find(p => p.id === 'p-node')?.reportRealPath, false);
});

test('a server without Navidrome\'s native API, or no connection, reads as unavailable', async () => {
  fake.mode = 'not-navidrome';
  const st = await realPathStatus({ enable: true });
  assert.equal(st.state, 'unavailable');
  assert.match(st.reason || '', /404/);

  fake.mode = 'navidrome';
  config.navidrome.password = '';
  fake.requests = 0;
  const none = await realPathStatus();
  assert.equal(none.state, 'unavailable');
  assert.equal(fake.requests, 0, 'an unconfigured station asks nothing');
});

test('the server kind comes from the Subsonic ping type; an unnamed server is unknown', () => {
  assert.equal(serverKind('navidrome'), 'navidrome');
  assert.equal(serverKind('Navidrome'), 'navidrome');
  assert.equal(serverKind('gonic'), 'other');
  assert.equal(serverKind(''), 'unknown');
  assert.equal(serverKind('unknown'), 'unknown');
  assert.equal(serverKind(undefined), 'unknown');
});

test('a music server that names itself as not Navidrome is never sent Navidrome\'s API, and nothing is logged', async () => {
  fake.serverType = 'gonic';
  const st = await realPathStatus({ enable: true });
  assert.equal(st.state, 'not-navidrome');
  assert.deepEqual(st.server, { type: 'gonic', version: '0.16.4' });
  assert.equal(fake.requests, 1, 'only the Subsonic ping');
  assert.deepEqual(fake.puts, []);
  const lines: string[] = [];
  await autoEnableRealPath(l => lines.push(l));
  await autoEnableRealPath(l => lines.push(l));
  assert.deepEqual(lines, [], 'the hourly pass stays quiet on a server without the setting');
  const f = realPathFinding(st, { localMount: true });
  assert.equal(f.status, 'skip');
  assert.match(f.detail, /Navidrome setting.*gonic 0\.16\.4/);
});

test('a server that does not name itself is tried through the native API, as before', async () => {
  fake.serverType = '';
  const st = await realPathStatus();
  assert.equal(st.state, 'off');
  assert.equal(st.server?.type, '');
});

test('the automatic pass logs what it switched, and a repeated refusal only once', async () => {
  const lines: string[] = [];
  await autoEnableRealPath(l => lines.push(l));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /sub-wave \[node\], sub-wave-admin \[node\]/);
  await autoEnableRealPath(l => lines.push(l));
  assert.equal(lines.length, 1, 'nothing left to switch, nothing logged');

  fake.mode = 'refuse-put';
  seed();
  await autoEnableRealPath(l => lines.push(l));
  await autoEnableRealPath(l => lines.push(l));
  assert.equal(lines.length, 2, 'the same refusal is logged once, not every hour');
  assert.match(lines[1], /could not keep Report Real Path on/);
});

test('the hourly tick writes nothing unless the operator opted in', async () => {
  // The first load of this process, from a hand-edited file: a malformed flag is off.
  writeFileSync(join(process.env.STATE_DIR as string, 'settings.json'), JSON.stringify({ musicSource: { reportRealPath: 'yes' } }));
  await settings.load();
  assert.equal(settings.get().musicSource.reportRealPath, false, 'a non-boolean stored flag loads as off');
  await realPathTick();
  assert.equal(fake.requests, 0);

  const r = await settings.update({ musicSource: { reportRealPath: true } });
  assert.equal(r.saved.musicSource.reportRealPath, true);
  await realPathTick();
  assert.deepEqual(fake.puts.map(p => p.id), ['p-node', 'p-admin']);
  await settings.update({ musicSource: { reportRealPath: false } });
});

const status = (over: Partial<RealPathStatus>): RealPathStatus => ({ state: 'off', players: [], switched: [], ...over });

test('the Doctor warns while a SUB/WAVE row is off, naming the row and the manual step', () => {
  const players = ownPlayers(fake.rows.map(asRow), own);
  const f = realPathFinding(status({ players }), { localMount: false });
  assert.equal(f.status, 'warn');
  assert.match(f.detail, /off for sub-wave \[node\], sub-wave-admin \[node\]/);
  assert.doesNotMatch(f.detail, /Lavf/, 'a row already on is not listed');
  assert.match(f.hint || '', /Settings → Players/);
  assert.match(f.hint || '', /tag-built file paths/);
  assert.match(realPathFinding(status({ players }), { localMount: true }).hint || '', /MUSIC_LIBRARY_PATH/);
  const refused = realPathFinding(status({ state: 'refused', players, reason: 'HTTP 403' }), { localMount: false });
  assert.equal(refused.status, 'warn');
  assert.match(refused.detail, /refused .*HTTP 403/);
});

test('the Doctor is ok when every row is on and skips what it cannot read', () => {
  const on = ownPlayers(fake.rows.map(asRow), own).map(p => ({ ...p, reportRealPath: true }));
  assert.deepEqual(realPathFinding(status({ state: 'on', players: on }), { localMount: false }), {
    status: 'ok',
    detail: 'on for all 3 SUB/WAVE player(s)',
  });
  assert.equal(realPathFinding(status({ state: 'no-players' }), { localMount: false }).status, 'skip');
  const un = realPathFinding(status({ state: 'unavailable', reason: 'HTTP 404 on /auth/login' }), { localMount: false });
  assert.equal(un.status, 'skip');
  assert.match(un.detail, /HTTP 404/);
});

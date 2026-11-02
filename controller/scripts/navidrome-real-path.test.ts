// Navidrome's "Report Real Path" on SUB/WAVE's own player rows: which rows are
// ours, the Doctor's reading, and the switch, against a fake Navidrome native
// API (POST /auth/login, GET/PUT /api/player) on a real HTTP socket. The fake's
// songs carry the `path` and `size` stock Navidrome sends: tag-built until the
// calling player has the flag on, then absolute inside its own container.
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { config } from '../src/config.js';
import * as settings from '../src/settings.js';
import { setCache } from '../src/settings/store.js';
import {
  isOwnPlayer,
  normalizePlayerRow,
  ownPlayers,
  passwordRefusal,
  realPathFinding,
  serverKind,
  stateOf,
  type NavidromePlayerRow,
  type RealPathStatus,
} from '../src/music/navidrome-players-policy.js';
import { autoEnableRealPath, passiveRealPathStatus, realPathStatus, sampleLocalPaths, _resetAutoOutcome } from '../src/music/navidrome-players.js';
import { getAnnotatedUri, getSong } from '../src/music/subsonic.js';
import { checkNavidrome } from '../src/doctor/checks-services.js';
import { realPathTick } from '../src/broadcast/scheduler.js';
import { _markLibraryMountProven } from '../src/music/library-mount.js';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const express = (await import('express')).default;
const { router: settingsRouter } = await import('../src/routes/settings/core.js');
const { router: djRouter } = await import('../src/routes/dj.js');

type Row = Record<string, unknown> & { id: string; reportRealPath: boolean };

// Stock Navidrome's library root inside its own container.
const ND_ROOT = '/music';

interface FakeSong { id: string; title: string; artist: string; album: string; tagPath: string; file: string; root?: string }

// `tagPath` is what the tags build, `file` is where it sits below the root.
const ALIGNED: FakeSong = { id: 's-aligned', title: 'Aligned Title', artist: 'Aligned Artist', album: 'Aligned Album', tagPath: 'Aligned Artist/Aligned Album/01 - Aligned Title.mp3', file: 'Aligned Artist/Aligned Album/01 - Aligned Title.mp3' };
const ODD: FakeSong = { id: 's-odd', title: 'Odd Title', artist: 'Odd Artist', album: 'Odd Album', tagPath: 'Odd Artist/Odd Album/01 - Odd Title.mp3', file: 'Real Folder/Odd Dir/weird-filename-on-disk.mp3' };

// Two tracks at one folder and file name in two libraries, the same length to
// the byte, as a real server's pair of equal-length tracks came out.
const VA_ONE: FakeSong = { id: 's-va-one', title: 'ONE-VA-GH-01', artist: 'One', album: 'One', tagPath: 'One/One/01 - ONE-VA-GH-01.mp3', file: 'Various Artists/Greatest Hits/01.mp3' };
const VA_TWO: FakeSong = { ...VA_ONE, id: 's-va-two', title: 'TWO-VA-GH-01', root: '/library/two' };

// A track's file: stand-in audio with its title in the tags. The fake's `size`
// is this file's length, as a real server reports it.
const fileBytes = (song: { title: string }) => Buffer.from(`ID3 TIT2 ${song.title} and then the audio`);

const fake = {
  // `not-navidrome` answers 404 to everything, `no-native` only to Navidrome's own API.
  mode: 'navidrome' as 'navidrome' | 'not-navidrome' | 'no-native' | 'refuse-put' | 'redirect-login',
  // What the Subsonic ping names the server: '' leaves `type` out (a server that does not say).
  serverType: 'navidrome',
  rows: [] as Row[],
  // A row's PUT answers with this status; 0 drops the connection.
  failPut: new Map<string, number>(),
  // Every row a write was tried on, whatever came of it.
  attempted: [] as string[],
  songs: [ALIGNED, ODD],
  // Off for a server that sends no `size`.
  sendSize: true,
  // The real root a song without its own `root` sits under.
  root: ND_ROOT,
  puts: [] as { id: string; body: Record<string, unknown> }[],
  requests: 0,
  // Requests to where a redirected login was pointed.
  redirected: 0,
  // `METHOD /path` of every request, and the client name of every ping.
  calls: [] as string[],
  pingClients: [] as (string | null)[],
};

const logins = () => fake.calls.filter(c => c === 'POST /auth/login').length;
// Anything on Navidrome's own API, as opposed to Subsonic's.
const nativeCalls = () => fake.calls.filter(c => /\/auth\/|\/api\//.test(c)).length;

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
    row('p-sound', 'sub-wave-of-sound', 'DSub', 'radio', false),
    row('p-other', 'sub-wave', 'node', 'someone-else', false),
  ];
}

async function readBody(req: IncomingMessage): Promise<string> {
  let b = '';
  for await (const c of req) b += c;
  return b;
}

// What Navidrome answers THIS caller: the flag is on the row of the client name
// and user agent making the request.
function songFor(song: FakeSong, req: IncomingMessage, url: URL) {
  const player = fake.rows.find(r => r.client === url.searchParams.get('c')
    && r.userAgent === req.headers['user-agent']
    && r.userName === url.searchParams.get('u'));
  const { tagPath, file, root, ...rest } = song;
  return {
    ...rest,
    path: player?.reportRealPath ? `${root ?? fake.root}/${file}` : tagPath,
    ...(fake.sendSize ? { size: fileBytes(song).length } : {}),
  };
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  fake.requests++;
  const send = (status: number, body?: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const url = new URL(req.url || '/', 'http://x');
  fake.calls.push(`${req.method} ${url.pathname}`);
  if (fake.mode === 'not-navidrome') return send(404, { error: 'not found' });
  if (fake.mode === 'no-native' && !url.pathname.startsWith('/rest/')) return send(404, { error: 'not found' });
  if (url.pathname === '/rest/ping') {
    fake.pingClients.push(url.searchParams.get('c'));
    return send(200, { 'subsonic-response': { status: 'ok', version: '1.16.1', ...(fake.serverType ? { type: fake.serverType, serverVersion: '0.16.4' } : {}) } });
  }
  const subsonicOk = (body: unknown) => send(200, { 'subsonic-response': { status: 'ok', version: '1.16.1', ...(body as object) } });
  if (url.pathname === '/rest/getSong') {
    const song = fake.songs.find(x => x.id === url.searchParams.get('id'));
    return subsonicOk(song ? { song: songFor(song, req, url) } : {});
  }
  if (url.pathname === '/rest/getRandomSongs') {
    return subsonicOk({ randomSongs: { song: fake.songs.map(x => songFor(x, req, url)) } });
  }
  if (url.pathname === '/rest/search3') {
    return subsonicOk({ searchResult3: { song: fake.songs.map(x => songFor(x, req, url)) } });
  }
  if (url.pathname === '/elsewhere') {
    fake.redirected++;
    return send(200, { token: 'jwt-1' });
  }
  if (req.method === 'POST' && url.pathname === '/auth/login') {
    if (fake.mode === 'redirect-login') {
      res.writeHead(307, { Location: '/elsewhere' });
      return res.end();
    }
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
    fake.attempted.push(target.id);
    if (fake.mode === 'refuse-put') return send(403, { error: 'forbidden' });
    const failing = fake.failPut.get(target.id);
    if (failing === 0) return req.socket.destroy();
    if (failing) return send(failing, { error: 'failed' });
    const body = JSON.parse(await readBody(req));
    fake.puts.push({ id: target.id, body });
    Object.assign(target, body);
    return send(200, target);
  }
  return send(405, {});
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const libraries = createTempDir(join(tmpdir(), 'subwave-real-path-'));
let libraryCount = 0;
after(async () => {
  delete process.env.MUSIC_LIBRARY_PATH;
  await removeTempDir(libraries);
  await new Promise<void>(resolve => server.close(() => resolve()));
});

function addTracks(root: string, ...tracks: FakeSong[]) {
  for (const track of tracks) {
    mkdirSync(dirname(join(root, track.file)), { recursive: true });
    writeFileSync(join(root, track.file), fileBytes(track));
  }
}

// A library on disk with the given tracks below it, as MUSIC_LIBRARY_PATH.
function mount(...tracks: FakeSong[]): string {
  const root = join(libraries, `lib-${++libraryCount}`);
  mkdirSync(root, { recursive: true });
  addTracks(root, ...tracks);
  process.env.MUSIC_LIBRARY_PATH = root;
  // What the mixer's proof would have cached (library-mount.test.ts pins that).
  _markLibraryMountProven(root);
  return root;
}

beforeEach(() => {
  fake.mode = 'navidrome';
  fake.serverType = 'navidrome';
  fake.songs = [ALIGNED, ODD];
  fake.sendSize = true;
  fake.root = ND_ROOT;
  delete process.env.MUSIC_LIBRARY_PATH;
  fake.puts = [];
  fake.requests = 0;
  fake.redirected = 0;
  fake.calls = [];
  fake.pingClients = [];
  fake.failPut = new Map();
  fake.attempted = [];
  seed();
  config.navidrome.url = base;
  config.navidrome.user = 'radio';
  config.navidrome.password = 'secret';
  config.navidrome.clientName = 'sub-wave';
  _resetAutoOutcome();
});

const own = { clientName: 'sub-wave', user: 'radio' };
const asRow = (r: Row) => normalizePlayerRow(r) as NavidromePlayerRow;

test('a SUB/WAVE player is on the exact list of our client names, on the station account only', () => {
  seed();
  assert.deepEqual(ownPlayers(fake.rows.map(asRow), own).map(p => p.id), ['p-node', 'p-admin', 'p-lavf']);
  assert.equal(isOwnPlayer(asRow(row('x', 'sub-wave-wizard', 'node', 'radio', false)), own), true);
  for (const client of ['sub-wave-of-sound', 'sub-wave-', 'sub-wave-admin-2', 'sub-wave-wizard-x', 'SUB-WAVE-ADMIN']) {
    assert.equal(isOwnPlayer(asRow(row('x', client, 'node', 'radio', false)), own), false, client);
  }
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
  // The whole row goes back: the other fields ride along unchanged.
  assert.equal(sent.maxBitRate, 0);
  assert.equal(sent.scrobbleEnabled, true);
  assert.equal(sent.client, 'sub-wave');
  for (const id of ['p-web', 'p-probe', 'p-front', 'p-sound', 'p-other']) {
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

test('a refusal after a row switched is logged once, beside the switch', async () => {
  fake.failPut.set('p-admin', 403);
  const lines: string[] = [];
  const first = await autoEnableRealPath(l => lines.push(l));
  assert.equal(first.state, 'refused');
  assert.deepEqual(first.switched, ['p-node']);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /switched Report Real Path on for sub-wave \[node\]/);
  assert.match(lines[1], /could not keep Report Real Path on \(sub-wave-admin \[node\]: HTTP 403/);

  await autoEnableRealPath(l => lines.push(l));
  await autoEnableRealPath(l => lines.push(l));
  assert.equal(lines.length, 2, 'not every hour');
});

test('a 500 on one row leaves the next row its turn, and is not called a refusal', async () => {
  fake.failPut.set('p-node', 500);
  const lines: string[] = [];
  const st = await autoEnableRealPath(l => lines.push(l));
  assert.deepEqual(fake.attempted, ['p-node', 'p-admin']);
  assert.deepEqual(st.switched, ['p-admin']);
  assert.equal(st.state, 'off', 'a row is still off, and nobody refused anything');
  assert.equal(st.reason, 'sub-wave [node]: HTTP 500');
  assert.doesNotMatch(st.reason || '', /p-node/, 'row ids stay server-side');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /could not keep Report Real Path on \(sub-wave \[node\]: HTTP 500\)/);

  fake.failPut.clear();
  await autoEnableRealPath(l => lines.push(l));
  assert.equal(lines.length, 3, 'the row switches on the next pass');
  assert.equal(fake.rows.find(r => r.id === 'p-node')?.reportRealPath, true);
});

test('a 401 or a dead connection ends the pass rather than trying every row', async () => {
  fake.failPut.set('p-node', 401);
  const refused = await realPathStatus({ enable: true });
  assert.equal(refused.state, 'refused');
  assert.deepEqual(fake.attempted, ['p-node']);

  seed();
  fake.attempted = [];
  fake.failPut = new Map([['p-node', 0]]);
  const dead = await realPathStatus({ enable: true });
  assert.equal(dead.state, 'off');
  assert.deepEqual(fake.attempted, ['p-node']);
  assert.match(dead.reason || '', /^sub-wave \[node\]: could not reach Navidrome: /);
});

test('a dead server names the cause, not a bare "fetch failed"', async () => {
  const closed = createServer();
  await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve));
  const { port } = closed.address() as AddressInfo;
  await new Promise<void>(resolve => closed.close(() => resolve()));
  config.navidrome.url = `http://127.0.0.1:${port}`;
  const st = await realPathStatus();
  assert.equal(st.state, 'unavailable');
  assert.match(st.reason || '', new RegExp(`could not reach http://127\\.0\\.0\\.1:${port}: fetch failed \\(ECONNREFUSED\\)`));
});

test('a server without Navidrome\'s native API, or no connection, reads as unavailable', async () => {
  fake.mode = 'no-native';
  const st = await realPathStatus({ enable: true });
  assert.equal(st.state, 'unavailable');
  assert.match(st.reason || '', /404 on \/auth\/login/);
  assert.equal(st.access, undefined, 'a 404 is not the account being refused');

  fake.mode = 'navidrome';
  config.navidrome.password = '';
  fake.requests = 0;
  const none = await realPathStatus();
  assert.equal(none.state, 'unavailable');
  assert.equal(fake.requests, 0, 'an unconfigured station asks nothing');
});

test('a refused login reaches the Doctor as a warning with the step by hand, and the log points at it', async () => {
  config.navidrome.password = 'wrong';
  const st = await realPathStatus({ enable: true });
  assert.equal(st.state, 'unavailable');
  assert.equal(st.access, 'refused');
  assert.match(st.reason || '', /401/);

  const f = realPathFinding(st, { localMount: false });
  assert.equal(f.status, 'warn');
  assert.match(f.detail, /401/);
  assert.match(f.hint || '', /refused this account/);
  assert.match(f.hint || '', /Settings → Players/);
  assert.doesNotMatch(f.hint || '', /Keep Report Real Path on/, 'the opt-in signs in the same way, so it is no answer');

  const lines: string[] = [];
  await autoEnableRealPath(l => lines.push(l));
  assert.match(lines[0], /see the Doctor for the manual step/);
});

test('a refused read of the players warns like a refused login', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => (String(input).includes('/api/player')
    ? Promise.resolve(new Response('{}', { status: 403 }))
    : realFetch(input, init));
  try {
    const st = await realPathStatus();
    assert.equal(st.access, 'refused');
    assert.equal(realPathFinding(st, { localMount: false }).status, 'warn');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the password goes over https, or to a host on the station\'s own network', () => {
  for (const url of [
    'https://music.example.com',
    'https://8.8.8.8:4533',
    // Loopback.
    'http://127.0.0.1:4533',
    'http://127.200.0.9',
    'http://[::1]:4533',
    'http://0x7f.1',
    // RFC 1918, at the edge of each range.
    'http://10.0.0.1',
    'http://10.255.255.255',
    'http://172.16.0.1',
    'http://172.31.255.255',
    'http://192.168.1.20:4533',
    // Link-local.
    'http://169.254.10.1',
    'http://[fe80::1]',
    'http://[febf::1]',
    'http://[FE80::1]:4533',
    // Tailscale's 100.64.0.0/10, at both edges.
    'http://100.64.0.0',
    'http://100.64.0.1:4533',
    'http://100.100.100.100',
    'http://100.127.255.255',
    // IPv6 unique-local, fc00::/7, at both edges and in every spelling.
    'http://[fc00::1]',
    'http://[fd00::1]',
    'http://[fdff:ffff::1]:4533',
    'http://[FD12:3456:789A:1::1]',
    'http://[fd00:0:0:0:0:0:0:1]',
    // Names.
    'http://localhost:4533',
    'http://LOCALHOST',
    'http://nas.local',
    'http://Music.Box.local:4533',
    'http://navidrome:4533',
    'http://navidrome/sub/path',
    // The setup wizard's own default for a Navidrome on the Docker host.
    'http://host.docker.internal:4533',
    'http://navidrome.corp.internal',
    'http://nas.lan',
    'http://NAS.LAN:4533',
    'http://nas.home.arpa',
    'http://music.tail1234.ts.net',
    'http://nas.localdomain',
    'http://nas.home',
    'http://navidrome.corp',
    'http://navidrome.default.svc:4533',
    'http://navidrome.default.svc.cluster.local:4533',
    'http://nas.fritz.box',
    'http://NAS.FRITZ.BOX:4533',
  ]) {
    assert.equal(passwordRefusal(url), null, url);
  }
});

test('anything else is refused, with what was refused named', () => {
  for (const url of [
    'http://music.example.com:4533',
    'http://8.8.8.8',
    'http://134744072', // 8.8.8.8 as one number
    'http://0x08.0x08.0x08.0x08',
    // Just outside each range.
    'http://11.0.0.1',
    'http://172.15.255.255',
    'http://172.32.0.1',
    'http://192.169.0.1',
    'http://169.253.0.1',
    'http://169.255.0.1',
    'http://126.0.0.1',
    'http://0.0.0.0',
    // Just outside Tailscale's range, either side, and the rest of 100/8.
    'http://100.63.255.255',
    'http://100.128.0.1',
    'http://100.0.0.1',
    'http://100.255.0.1',
    // Public IPv6, and just outside each private range.
    'http://[2001:4860:4860::8888]',
    'http://[2606:4700:4700::1111]',
    'http://[2001:db8::1]',
    'http://[fbff::1]',
    'http://[fe00::1]',
    'http://[fe7f::1]',
    'http://[fec0::1]',
    'http://[ff02::1]',
    // A short first group is not the range it looks like: 00fd::, 0fd0::.
    'http://[fd::1]',
    'http://[fd0::1]',
    'http://[fe8::1]',
    // A private IPv4 in IPv6 clothing is not on the list; refused, not parsed.
    'http://[::ffff:8.8.8.8]',
    'http://[::ffff:192.168.1.1]',
    'http://navidrome.',
    // A local-looking name that is not local.
    'http://localhost.example.com',
    'http://nas.local.example.com',
    'http://10.0.0.1.example.com',
    'http://192.168.1.1@music.example.com',
    // A private suffix anywhere but the end, or with no name in front.
    'http://example.lan.com',
    'http://lan.example.com',
    'http://host.docker.internal.example.com',
    'http://internal.example.com',
    'http://music.ts.net.example.com',
    'http://music.home.arpa.example.com',
    'http://ts.net',
    'http://home.arpa',
    'http://fritz.box',
    'http://home.example.com',
    'http://corp.example.com',
    'http://svc.example.com',
    'http://example.home.com',
    'http://example.corp.com',
    'http://example.svc.com',
    'http://nas.localdomain.example.com',
    'http://nas.fritz.box.example.com',
    // The suffix must be a whole label.
    'http://nas.xlan',
    'http://nas.xinternal',
    'http://nas.xts.net',
    'http://nas.xhome.arpa',
    'http://nas.xlocaldomain',
    'http://nas.xhome',
    'http://nas.xcorp',
    'http://nas.xsvc',
    'http://nas.xfritz.box',
    'http://notfritz.box',
    'http://nas.lan.',
    'http://nas.home.',
    // Another scheme.
    'ftp://navidrome',
    'ws://localhost',
  ]) {
    assert.match(passwordRefusal(url) || '', /only sent over https or to a local address/, url);
  }
  assert.match(passwordRefusal('http://music.example.com:4533') || '', /http:\/\/music\.example\.com:4533 is neither/);
  assert.match(passwordRefusal('not a url') || '', /not valid/);
  assert.match(passwordRefusal('') || '', /not valid/);
  assert.doesNotMatch(passwordRefusal('http://user:hunter2@music.example.com') || '', /hunter2/);
});

// The Subsonic ping goes out as usual, to a fake on a public-looking name.
async function onPublicHost<T>(run: (sent: { url: string; body: string }[]) => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  const sent: { url: string; body: string }[] = [];
  config.navidrome.url = 'http://music.example.com:4533';
  globalThis.fetch = (input, init) => {
    sent.push({ url: String(input), body: String(init?.body ?? '') });
    return realFetch(String(input).replace(config.navidrome.url, base), init);
  };
  try {
    return await run(sent);
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('a refused host is sent nothing, opted in or not, and reads as unavailable', async () => {
  await onPublicHost(async sent => {
    const read = await realPathStatus();
    const on = await realPathStatus({ enable: true });
    for (const st of [read, on]) {
      assert.equal(st.state, 'unavailable');
      assert.equal(st.access, 'not-sent');
      assert.match(st.reason || '', /is neither/);
    }
    assert.ok(sent.length > 0, 'the ping still went');
    assert.deepEqual(sent.filter(r => !r.url.includes('/rest/ping')), [], 'nothing but the ping');
    assert.equal(sent.some(r => `${r.url} ${r.body}`.includes('secret')), false, 'the password never left');
    assert.equal(fake.puts.length, 0);
  });
});

test('the Doctor says why the password was kept back, and how to fix it', async () => {
  const st = await onPublicHost(() => realPathStatus());
  const f = realPathFinding(st, { localMount: false });
  assert.equal(f.status, 'warn');
  assert.match(f.detail, /only sent over https or to a local address/);
  assert.match(f.hint || '', /over https, or at a private address/);
  assert.match(f.hint || '', /host\.docker\.internal/);
  assert.match(f.hint || '', /Settings → Players/);
});

test('the hourly pass logs a kept-back password once, and writes nothing', async () => {
  const lines: string[] = [];
  await onPublicHost(async () => {
    await autoEnableRealPath(l => lines.push(l));
    await autoEnableRealPath(l => lines.push(l));
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /is neither/);
});

test('a redirect does not carry the password anywhere', async () => {
  fake.mode = 'redirect-login';
  const st = await realPathStatus();
  assert.equal(st.state, 'unavailable');
  assert.match(st.reason || '', /307/);
  assert.equal(fake.redirected, 0);
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

test('a stored true survives a cold load, and a stored false stays off', async () => {
  await settings.update({ musicSource: { reportRealPath: true } });
  setCache(null);
  await settings.load();
  assert.equal(settings.get().musicSource.reportRealPath, true);

  await settings.update({ musicSource: { reportRealPath: false } });
  setCache(null);
  await settings.load();
  assert.equal(settings.get().musicSource.reportRealPath, false);
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

test('a saved opt-in survives a cold load', async () => {
  await settings.update({ musicSource: { reportRealPath: true } });
  setCache(null);
  await settings.load();
  assert.equal(settings.get().musicSource.reportRealPath, true);
  await settings.update({ musicSource: { reportRealPath: false } });
});

test('a failed ping never reaches the login, on any path', async () => {
  fake.mode = 'not-navidrome';
  const read = await realPathStatus();
  assert.equal(read.state, 'unavailable');
  assert.match(read.reason || '', /ping returned HTTP 404/);
  assert.equal(logins(), 0, 'a plain read');

  assert.equal((await realPathStatus({ enable: true })).state, 'unavailable');
  assert.equal(logins(), 0, 'the switch');

  await autoEnableRealPath(() => {});
  assert.equal(logins(), 0, 'the automatic pass');

  await settings.update({ musicSource: { reportRealPath: true } });
  try {
    assert.equal((await passiveRealPathStatus()).state, 'unavailable');
    assert.equal(logins(), 0, 'a passive read with the opt-in on');
  } finally {
    await settings.update({ musicSource: { reportRealPath: false } });
  }
});

test('no read asks as sub-wave-admin, so none can recreate that row', async () => {
  await realPathStatus();
  await realPathStatus({ enable: true });
  await passiveRealPathStatus();
  assert.ok(fake.pingClients.length >= 3);
  assert.deepEqual([...new Set(fake.pingClients)], ['sub-wave']);
});

// The report the Doctor's `real file paths` line comes from, unattended at 04:17 or on request.
const doctorFinding = async () => {
  const findings = await checkNavidrome();
  return findings.find(f => f.label === 'real file paths');
};

test('with the opt-in off the Doctor skips and never touches Navidrome\'s own API', async () => {
  await settings.update({ musicSource: { reportRealPath: false } });

  const bare = await doctorFinding();
  assert.equal(bare?.status, 'skip', 'an upgrade with no mount adds no warning');
  assert.match(bare?.detail || '', /Keep Report Real Path on/);
  assert.equal(bare?.hint, undefined);

  mount(ALIGNED);
  const mounted = await doctorFinding();
  assert.equal(mounted?.status, 'skip', 'nor does one with a mount');
  assert.match(mounted?.hint || '', /MUSIC_LIBRARY_PATH is set/);

  assert.equal(logins(), 0);
  assert.equal(nativeCalls(), 0);
  assert.deepEqual(fake.puts, []);
  assert.ok(!fake.calls.includes('GET /rest/getRandomSongs'), 'and samples nothing');
});

test('with the opt-in on the Doctor reads the rows and warns on one that is off', async () => {
  await settings.update({ musicSource: { reportRealPath: true } });
  try {
    const off = await doctorFinding();
    assert.equal(off?.status, 'warn');
    assert.match(off?.detail || '', /off for sub-wave \[node\], sub-wave-admin \[node\]/);
    assert.equal(logins(), 1);

    await realPathStatus({ enable: true });
    assert.equal((await doctorFinding())?.status, 'ok', 'no mount to sample');

    mount();
    const missing = await doctorFinding();
    assert.equal(missing?.status, 'warn', 'every flag on, and the mount holds nothing');
    assert.match(missing?.detail || '', /2 of 2 sampled tracks not proved on MUSIC_LIBRARY_PATH/);

    mount(ALIGNED, ODD);
    assert.equal((await doctorFinding())?.status, 'ok');
  } finally {
    await settings.update({ musicSource: { reportRealPath: false } });
  }
});

test('the Doctor adds no line on a failed ping, and names another server with the opt-in off', async () => {
  fake.mode = 'not-navidrome';
  assert.equal(await doctorFinding(), undefined);
  assert.equal(logins(), 0);

  fake.mode = 'navidrome';
  fake.serverType = 'gonic';
  const f = await doctorFinding();
  assert.equal(f?.status, 'skip');
  assert.match(f?.detail || '', /gonic 0\.16\.4/);
  assert.equal(nativeCalls(), 0);
});

// The two read routes and the switch, as the card calls them.
const app = express();
app.use(express.json());
app.use(settingsRouter);
app.use(djRouter);
const adminServer: Server = createServer(app);
await new Promise<void>(resolve => adminServer.listen(0, '127.0.0.1', resolve));
after(() => new Promise<void>(resolve => adminServer.close(() => resolve())));
const adminBase = `http://127.0.0.1:${(adminServer.address() as AddressInfo).port}`;

async function card(path: string, method = 'GET') {
  const res = await fetch(`${adminBase}${path}`, { method });
  assert.equal(res.status, 200);
  return await res.json() as { state: string; reason: string | null; autoEnable: boolean; switched: number; players: { client: string }[] };
}

test('opening the card with the opt-in off reads nothing from Navidrome, and a press does', async () => {
  await settings.update({ musicSource: { reportRealPath: false } });

  const opened = await card('/settings/navidrome/players');
  assert.equal(opened.state, 'not-read');
  assert.equal(opened.autoEnable, false);
  assert.deepEqual(opened.players, []);
  assert.equal(logins(), 0);
  assert.equal(nativeCalls(), 0);

  const checked = await card('/settings/navidrome/players/check', 'POST');
  assert.equal(checked.state, 'off');
  assert.equal(checked.players.length, 3);
  assert.equal(logins(), 1, 'the press logs in once');
  assert.deepEqual(fake.puts, [], 'and writes nothing');

  assert.ok(!checked.players.some(p => p.client === 'sub-wave-of-sound'), 'a look-alike is not on the card as ours');

  const switched = await card('/settings/navidrome/players/real-path', 'POST');
  assert.equal(switched.state, 'on');
  assert.equal(switched.switched, 2);
  assert.equal(fake.rows.find(r => r.id === 'p-sound')?.reportRealPath, false, 'and the press leaves it alone');

  fake.calls = [];
  assert.equal((await card('/settings/navidrome/players')).state, 'not-read', 'the next opening reads nothing again');
  assert.equal(nativeCalls(), 0);
});

test('the card gets the reason a row failed, whatever the state', async () => {
  await settings.update({ musicSource: { reportRealPath: false } });
  fake.failPut.set('p-node', 500);
  const failed = await card('/settings/navidrome/players/real-path', 'POST');
  assert.equal(failed.state, 'off');
  assert.equal(failed.reason, 'sub-wave [node]: HTTP 500');

  seed();
  fake.failPut = new Map([['p-node', 403]]);
  const refused = await card('/settings/navidrome/players/real-path', 'POST');
  assert.equal(refused.state, 'refused');
  assert.match(refused.reason || '', /HTTP 403/);
});

test('opening the card with the opt-in on reads the rows', async () => {
  await settings.update({ musicSource: { reportRealPath: true } });
  try {
    const opened = await card('/settings/navidrome/players');
    assert.equal(opened.state, 'off');
    assert.equal(opened.autoEnable, true);
    assert.equal(opened.players.length, 3);
  } finally {
    await settings.update({ musicSource: { reportRealPath: false } });
  }
});

test('opening the card on another server still shrinks it to one line, with no native call', async () => {
  await settings.update({ musicSource: { reportRealPath: false } });
  fake.serverType = 'gonic';
  const opened = await card('/settings/navidrome/players');
  assert.equal(opened.state, 'not-navidrome');
  assert.deepEqual(opened.players, []);
  assert.equal(nativeCalls(), 0);
});

// The URI the mixer gets, past the annotations.
const mixerUri = async (id: string) => getAnnotatedUri(await getSong(id)).replace(/^annotate:.*?":/, '');

test('the flag on plays the local file: the table that found this bug', async () => {
  const root = mount(ALIGNED, ODD);

  // Off: a tag-built path hits when the tags match the folders, and misses when they do not.
  assert.equal((await getSong(ALIGNED.id)).path, ALIGNED.tagPath);
  assert.equal(await mixerUri(ALIGNED.id), `${root}/${ALIGNED.file}`);
  assert.equal((await getSong(ODD.id)).path, ODD.tagPath);
  assert.match(await mixerUri(ODD.id), /^subhttp:/);

  const st = await realPathStatus({ enable: true });
  assert.equal(st.state, 'on');

  // On: Navidrome's absolute path, and both tracks play from disk.
  assert.equal((await getSong(ALIGNED.id)).path, `/music/${ALIGNED.file}`);
  assert.equal(await mixerUri(ALIGNED.id), `${root}/${ALIGNED.file}`);
  assert.equal((await getSong(ODD.id)).path, `/music/${ODD.file}`);
  assert.equal(await mixerUri(ODD.id), `${root}/${ODD.file}`);
});

test('a track that is not on the mount still streams with the flag on', async () => {
  mount(ALIGNED);
  await realPathStatus({ enable: true });
  assert.match(await mixerUri(ALIGNED.id), /^(?!subhttp:)/);
  assert.match(await mixerUri(ODD.id), /^subhttp:/);
});

test('a track in a library the mount does not hold streams, though another song sits at its place', async () => {
  await realPathStatus({ enable: true });
  fake.songs = [VA_ONE, VA_TWO];
  const root = mount(VA_ONE);
  assert.equal((await getSong(VA_TWO.id)).path, `/library/two/${VA_TWO.file}`);
  assert.equal((await getSong(VA_TWO.id)).size, (await getSong(VA_ONE.id)).size, 'the same size to the byte');
  assert.equal(await mixerUri(VA_ONE.id), `${root}/${VA_ONE.file}`);
  assert.match(await mixerUri(VA_TWO.id), /^subhttp:/);
});

test('a server that sends no size streams a mapped track, and the Doctor does not call it ok', async () => {
  await settings.update({ musicSource: { reportRealPath: true } });
  try {
    await realPathStatus({ enable: true });
    mount(ALIGNED, ODD);
    fake.sendSize = false;
    assert.match(await mixerUri(ALIGNED.id), /^subhttp:/);
    const f = await doctorFinding();
    assert.equal(f?.status, 'warn');
    assert.match(f?.detail || '', /2 of 2 sampled tracks not proved/);
  } finally {
    await settings.update({ musicSource: { reportRealPath: false } });
  }
});

test('the admin row keeps what the proof needs, so a track queued from search plays from disk', async () => {
  await realPathStatus({ enable: true });
  const root = mount(ALIGNED, ODD);
  const res = await fetch(`${adminBase}/dj/search?q=title`);
  const { results } = await res.json() as { results: { id: string; title: string; path: string; size: number }[] };
  assert.equal(results.length, 2);
  for (const row of results) {
    const asked = fake.songs.find(x => x.id === row.id) as FakeSong;
    assert.equal(row.size, fileBytes(asked).length);
    // The body POST /dj/queue-track gets back is this row, through JSON.
    const body = JSON.parse(JSON.stringify(row));
    assert.equal(getAnnotatedUri(body).replace(/^annotate:.*?":/, ''), `${root}/${asked.file}`);
  }
});

test('the Doctor reads ok only when the sampled tracks are proved on the mount', async () => {
  const players = ownPlayers(fake.rows.map(asRow), own).map(p => ({ ...p, reportRealPath: true }));
  const finding = async () => realPathFinding(status({ state: 'on', players }), { localMount: true, sample: await sampleLocalPaths() });
  await realPathStatus({ enable: true });

  mount(ALIGNED, ODD);
  const all = await finding();
  assert.equal(all.status, 'ok');
  assert.match(all.detail, /on for all 3 SUB\/WAVE player\(s\) · 2 of 2 sampled tracks proved on MUSIC_LIBRARY_PATH/);

  mount(ALIGNED);
  const some = await finding();
  assert.equal(some.status, 'warn');
  assert.match(some.detail, /1 of 2 sampled tracks not proved on MUSIC_LIBRARY_PATH/);
  assert.match(some.hint || '', /weird-filename-on-disk\.mp3/);
  assert.match(some.hint || '', /Point MUSIC_LIBRARY_PATH at the folder Navidrome scans/);

  mount();
  const none = await finding();
  assert.equal(none.status, 'warn', 'every flag on and nothing on the mount is not ok');
  assert.match(none.detail, /2 of 2 sampled tracks not proved/);

  fake.songs = [];
  assert.equal((await finding()).status, 'skip', 'an empty sample proves nothing, so it is not ok');
  assert.equal(realPathFinding(status({ state: 'on', players }), { localMount: true, sample: null }).status, 'skip');
});

test('a file that merely exists is not ok, and the Doctor says which way it fails', async () => {
  await settings.update({ musicSource: { reportRealPath: true } });
  try {
    await realPathStatus({ enable: true });

    // A mapped guess: another track's file at the place. It streams, and the hint says so.
    fake.songs = [VA_TWO];
    mount(VA_ONE);
    const streamed = await doctorFinding();
    assert.equal(streamed?.status, 'warn');
    assert.match(streamed?.detail || '', /1 of 1 sampled tracks not proved/);
    assert.match(streamed?.hint || '', /1 stream instead of playing from disk, for example \/library\/two\//);

    // The real path inside the mount, a different file at it. That plays, since
    // a path taken as it is needs no proof, so the hint must not promise a stream.
    const root = mount();
    fake.songs = [ALIGNED];
    fake.root = root;
    addTracks(root, { ...ALIGNED, title: 'Something Else Altogether' });
    assert.equal(await mixerUri(ALIGNED.id), `${root}/${ALIGNED.file}`);
    const plays = await doctorFinding();
    assert.equal(plays?.status, 'warn');
    assert.match(plays?.hint || '', /1 play the file at that path, whose size differs/);
    assert.doesNotMatch(plays?.hint || '', /stream/);

    // The same path with the right file is proved.
    addTracks(root, ALIGNED);
    assert.equal((await doctorFinding())?.status, 'ok');
  } finally {
    await settings.update({ musicSource: { reportRealPath: false } });
  }
});

test('a mount the mixer has not proved is the library mount line\'s to report, not this one\'s', async () => {
  await settings.update({ musicSource: { reportRealPath: true } });
  try {
    await realPathStatus({ enable: true });
    const root = mount();
    // On disk for the controller, with no proof from the mixer for this path.
    const unproven = `${root}-unproven`;
    addTracks(unproven, ALIGNED, ODD);
    process.env.MUSIC_LIBRARY_PATH = unproven;
    assert.match(await mixerUri(ALIGNED.id), /^subhttp:/, 'nothing local reaches the mixer');
    const f = await doctorFinding();
    assert.equal(f?.status, 'ok');
    assert.match(f?.detail || '', /2 of 2 sampled tracks proved/);
  } finally {
    await settings.update({ musicSource: { reportRealPath: false } });
  }
});

test('a Doctor run changes nothing the mixer gets next', async () => {
  await settings.update({ musicSource: { reportRealPath: true } });
  try {
    await realPathStatus({ enable: true });
    fake.songs = [ALIGNED, ODD, VA_ONE, VA_TWO];
    mount(ALIGNED, VA_ONE);
    const uris = () => Promise.all(fake.songs.map(s => mixerUri(s.id)));
    const before = await uris();
    assert.equal(before.filter(u => u.startsWith('subhttp:')).length, 2);
    for (let i = 0; i < 4; i++) await doctorFinding();
    assert.deepEqual((await uris()).map(u => u.replace(/#.*/, '').replace(/[?&](t|s)=[^&]*/g, '')),
      before.map(u => u.replace(/#.*/, '').replace(/[?&](t|s)=[^&]*/g, '')));
  } finally {
    await settings.update({ musicSource: { reportRealPath: false } });
  }
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
  // Reached only with the opt-in on: it says what happens next, and how to start rows on.
  assert.doesNotMatch(f.hint || '', /Keep Report Real Path on/);
  assert.match(f.hint || '', /within the hour/);
  assert.match(f.hint || '', /Turn on now/);
  assert.match(f.hint || '', /ND_SUBSONIC_DEFAULTREPORTREALPATH=true/);
  assert.match(f.hint || '', /0\.53\.3 does not/, 'an older server ignores it, so the hint must not promise it');
  assert.match(realPathFinding(status({ players }), { localMount: true }).hint || '', /MUSIC_LIBRARY_PATH/);
  const refused = realPathFinding(status({ state: 'refused', players, reason: 'HTTP 403' }), { localMount: false });
  assert.match(refused.hint || '', /Navidrome → Settings → Players/);
  assert.equal(refused.status, 'warn');
  assert.match(refused.detail, /refused .*HTTP 403/);
});

test('the not-read state is a skip, with the way back only when there is a mount to gain', () => {
  const bare = realPathFinding(status({ state: 'not-read' }), { localMount: false });
  assert.equal(bare.status, 'skip');
  assert.equal(bare.hint, undefined);
  const mounted = realPathFinding(status({ state: 'not-read' }), { localMount: true });
  assert.equal(mounted.status, 'skip');
  assert.match(mounted.hint || '', /folders differ from its tags/);
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
  assert.match(un.hint || '', /Settings → Players/, 'the log sends the operator here for this step');
});

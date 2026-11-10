// Targeted skip (#2017): POST /dj/skip with `{ expectId }` lands only while
// that track is still what the mixer is playing. Driven over HTTP against the
// real dj router, with a fake mixer on the telnet port, so "nothing skipped"
// means the `skip` command never reached Liquidsoap — not that a function was
// not called. The MCP client and tool run against the same server.
//
// The ways a skip meant for one song cuts something else:
//   * the song ended — before the request, or during commitBeforeSkip()'s
//     wait for the queued pick (up to 20s);
//   * a bed or pause-and-talk break followed it — neither writes
//     now-playing.json, so the file still names the song;
//   * a jingle stands between it and the air — the jingle's seam names the
//     song after it while the outgoing tail and the jingle still play;
//   * the controller's own view lags (the watcher's 1.5s tick) — the check
//     reads the files, never queue.getNowPlaying().
// And the bare skip — no body, a text body, `expectId: null` — is unchanged.
//
// Run: npm test -- targeted-skip

import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { after, beforeEach, test } from 'node:test';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir } from './test-utils/temp-dir.js';
import { listen } from './test-utils/http.js';

const commands: string[] = [];
const mixer = createServer(socket => socket.once('data', data => {
  commands.push(data.toString().trim());
  socket.end('OK\r\nEND\r\n');
}));
await new Promise<void>(resolve => mixer.listen(0, '127.0.0.1', resolve));
const mixerAddress = mixer.address();
if (!mixerAddress || typeof mixerAddress === 'string') throw new Error('mixer has no TCP port');
process.env.LIQUIDSOAP_HOST = '127.0.0.1';
process.env.LIQUIDSOAP_PORT = String(mixerAddress.port);
process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-targeted-skip-'));
// requireAdmin is a no-op with these unset, so the dj router mounts bare.
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;

const { config } = await import('../src/config.js');
const { queue } = await import('../src/broadcast/queue.js');
const { skipJingleCrossSec, songFedAtMs, targetedSkipRefusal } = await import('../src/broadcast/skip-policy.js');
const { skipBodySchema } = await import('../src/schemas/dj.js');
const { default: express } = await import('express');
const { router: djRouter } = await import('../src/routes/dj.js');
const { SubwaveClient } = await import('../src/mcp/client.js');
const { registerSubwaveTools } = await import('../src/mcp/tools.js');

(queue as any).persist = () => {};
const realCommit = queue.commitBeforeSkip;
let commits = 0;
// Default: nothing queued, so the commit returns at once (skipPrepAction's
// bare-skip path). A test that needs the wait replaces `duringCommit`.
let duringCommit: () => void = () => {};
(queue as any).commitBeforeSkip = async () => {
  commits++;
  duringCommit();
  return { pending: false, committed: false, waitedMs: 0 };
};

// What reached the route, so the MCP client's bare skip can be shown to send
// exactly what it always sent: no body at all.
const received: Array<{ contentType: string | null; body: unknown }> = [];
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (req.path === '/dj/skip') received.push({ contentType: req.headers['content-type'] ?? null, body: req.body });
  next();
});
app.use(djRouter);
const http = await listen(app);

after(async () => {
  (queue as any).commitBeforeSkip = realCommit;
  await http.close();
  await new Promise<void>((resolve, reject) => mixer.close(err => err ? reject(err) : resolve()));
});

const nowSec = () => Date.now() / 1000;

// now-playing.json as radio.liq's on_meta writes it: `timestamp` is time()
// truncated to whole seconds.
function songOnAir(id: string, fedSecAgo = 120) {
  writeFileSync(config.liquidsoap.nowPlayingFile, JSON.stringify({
    title: `Song ${id}`, artist: 'Artist', album: 'Album', subsonic_id: id,
    filename: `/tmp/${id}.mp3`, timestamp: Math.floor(nowSec() - fedSecAgo),
  }));
}

// The three markers keep time()'s fraction, as their writers do.
const MARKER_FILES = {
  jingle: () => config.liquidsoap.jinglePlayingFile,
  bed: () => config.liquidsoap.bedPlayingFile,
  break: () => config.liquidsoap.pauseTalkPlayingFile,
};
function marker(kind: keyof typeof MARKER_FILES, startedSecAgo: number) {
  const startedAt = nowSec() - startedSecAgo;
  const body = kind === 'jingle'
    ? { filename: '/state/jingles/id.wav', durationSec: 4, startedAt }
    : kind === 'bed'
      ? { filename: '/state/beds/b.mp3', startedAt }
      : { filename: '/state/pause-talk/p.wav', pauseId: 'p1', startedAt };
  writeFileSync(MARKER_FILES[kind](), JSON.stringify(body));
}

async function skip(body?: unknown, contentType = 'application/json') {
  const init: RequestInit = { method: 'POST' };
  if (body !== undefined) {
    init.headers = { 'content-type': contentType };
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(`${http.url}/dj/skip`, init);
  return { status: res.status, body: await res.json() as any };
}

beforeEach(() => {
  commands.length = 0;
  received.length = 0;
  commits = 0;
  duringCommit = () => {};
  for (const file of [config.liquidsoap.nowPlayingFile, ...Object.values(MARKER_FILES).map(f => f())]) {
    rmSync(file, { force: true });
  }
  songOnAir('A');
});

// ── the bare skip is unchanged ───────────────────────────────────────────────

test('no body: the bare skip, as before', async () => {
  const r = await skip();
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, pending: false, committed: false });
  assert.deepEqual(commands, ['skip']);
  assert.equal(commits, 1);
});

test('a bare skip still ends a jingle, bed or break: no id, no target', async () => {
  marker('jingle', 5);
  marker('bed', 4);
  const r = await skip({});
  assert.equal(r.status, 200);
  assert.deepEqual(commands, ['skip']);
});

test('a non-JSON body, expectId: null and an array body all read as no target', async () => {
  for (const body of ['expectId=B', null, []] as const) {
    commands.length = 0;
    const r = body === 'expectId=B'
      ? await skip(body, 'text/plain')
      : await skip(body === null ? { expectId: null } : body);
    assert.equal(r.status, 200, `body ${JSON.stringify(body)}`);
    assert.deepEqual(commands, ['skip'], `body ${JSON.stringify(body)}`);
  }
});

test('other keys are ignored, as the route always ignored its body', async () => {
  const r = await skip({ reason: 'test', force: true });
  assert.equal(r.status, 200);
  assert.deepEqual(commands, ['skip']);
});

test('a malformed expectId is a 400, with nothing committed or skipped', async () => {
  for (const expectId of [42, '', '   ', 'x'.repeat(201)]) {
    const r = await skip({ expectId });
    assert.equal(r.status, 400, `expectId ${JSON.stringify(expectId)}`);
  }
  assert.deepEqual(commands, []);
  assert.equal(commits, 0);
});

// ── targeted: lands ──────────────────────────────────────────────────────────

test('the expected track is on air with nothing after it: skipped', async () => {
  const r = await skip({ expectId: 'A' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.deepEqual(commands, ['skip']);
});

// The marker files are never deleted, so a jingle that aired BEFORE the song
// is the file surviving, not something on air.
test('a jingle, bed or break that aired before the song does not block it', async () => {
  marker('jingle', 300);
  marker('bed', 250);
  marker('break', 200);
  const r = await skip({ expectId: 'A' });
  assert.equal(r.status, 200);
  assert.deepEqual(commands, ['skip']);
});

// now-playing's stamp is whole seconds; a short bed fed just before the song
// can carry a later fraction of the same second. Read as "after", it would
// refuse every skip for the rest of the song.
test('a bed marker inside the song\'s own truncated second is not after it', async () => {
  const fed = Math.floor(nowSec()) - 60;
  writeFileSync(config.liquidsoap.nowPlayingFile, JSON.stringify({ title: 'A', artist: 'X', subsonic_id: 'A', timestamp: fed }));
  writeFileSync(config.liquidsoap.bedPlayingFile, JSON.stringify({ filename: 'b.mp3', startedAt: fed + 0.4 }));
  const r = await skip({ expectId: 'A' });
  assert.equal(r.status, 200);
  assert.deepEqual(commands, ['skip']);
});

// ── a jingle is placed by its own window, never ordered by stamp ─────────────
// radio.liq writes the jingle marker where a jingle goes on air: one writer on
// the music_with_jingle_now switch's output, so a rotate jingle and a manual
// press are marked alike, each at its own feed (liquidsoap/CLAUDE.md). Measured on
// liquidsoap 2.4.6 with that writer: A → J → B writes B's now-playing as A's
// closing seam is FED, and J's marker lands ~50ms after it (stamped at J's own
// feed), in the same second. B is
// not audible until A's buffered tail (the outgoing crossfade stamp) and J have
// played, 13s later for a 3s stinger, 24s for a 14s one. So now-playing names
// B, and J's marker reads as BEFORE B, through everything a skip would
// actually cut.
function jingleAt(startedAt: number, durationSec: number) {
  writeFileSync(config.liquidsoap.jinglePlayingFile, JSON.stringify({ filename: '/state/jingles/id.wav', durationSec, startedAt }));
}
function songFedAt(id: string, timestamp: number) {
  writeFileSync(config.liquidsoap.nowPlayingFile, JSON.stringify({ title: `Song ${id}`, artist: 'X', subsonic_id: id, timestamp }));
}

test('A → J → B: while A\'s tail or the jingle airs, a skip aimed at B is refused', async () => {
  const fed = Math.floor(nowSec()) - 5;
  songFedAt('B', fed);
  jingleAt(fed + 0.21, 3);
  const r = await skip({ expectId: 'B' });
  assert.equal(r.status, 409, 'the skip would cut the jingle (or A\'s tail), and B would play on');
  assert.equal(r.body.reason, 'jingle-on-air');
  assert.deepEqual(commands, []);
});

// The 50ms between the two writes can straddle a second boundary; read as a
// jingle AFTER B, it refused every skip of B for B's whole length.
test('A → J → B with the jingle\'s marker in the next second: B is skippable once J has aired', async () => {
  const fed = Math.floor(nowSec()) - 60;
  songFedAt('B', fed);
  jingleAt(fed + 1.02, 3);
  const r = await skip({ expectId: 'B' });
  assert.equal(r.status, 200);
  assert.deepEqual(commands, ['skip']);
});

// The cost runs the other way: the window ends after the jingle, a few seconds
// into B. Measured with the on-air writer, S2 → JB (14s) → S3 on a 10s
// crossfade: S3's now-playing at +44.24, JB's marker at +44.29, S3 audible
// ~23.6s after the marker, and the window (marker + 14s pad + 14s clip + 1s)
// closes ~5.4s into S3 — 15 − D_A s, with D_A the outgoing tail. Inside it
// the skip is refused; one second past it, it lands. (That writer stamped when
// its async hook ran; the marker is now stamped at the feed, a few hundredths
// earlier, and carries queuedSec 0 for a single jingle, so neither bound moves.)
test('the song after a jingle is refused only until the jingle\'s window closes', async () => {
  for (const [secAfterMarker, status] of [[28, 409], [30, 200]] as const) {
    commands.length = 0;
    const markerAt = nowSec() - secAfterMarker;
    songFedAt('S3', Math.floor(markerAt - 0.05));
    jingleAt(markerAt, 14);
    const r = await skip({ expectId: 'S3' });
    assert.equal(r.status, status, `${secAfterMarker}s after the marker, ${(secAfterMarker - 23.6).toFixed(1)}s into S3`);
    assert.deepEqual(commands, status === 200 ? ['skip'] : []);
  }
});

// The jingle airs after the OUTGOING track's buffered tail, whose length is
// that track's own crossfade stamp: up to CROSS_MAX_SECONDS (14s) on a station
// crossfade of 10s. The station figure alone would let a skip through during
// the jingle's last seconds.
test('the jingle window allows for an outgoing tail longer than the station crossfade', async () => {
  const fed = Math.floor(nowSec()) - 16;
  songFedAt('B', fed);
  jingleAt(fed + 0.05, 3);
  const r = await skip({ expectId: 'B' });
  assert.equal(r.status, 409);
  assert.equal(r.body.reason, 'jingle-on-air');
  assert.deepEqual(commands, []);
});

// ── targeted: refused ────────────────────────────────────────────────────────

test('the song changed before the request: 409 track-changed, no commit, no skip', async () => {
  songOnAir('B', 3);
  const r = await skip({ expectId: 'A' });
  assert.equal(r.status, 409);
  assert.equal(r.body.reason, 'track-changed');
  assert.equal(r.body.onAirId, 'B');
  assert.match(r.body.error, /no longer on air/);
  assert.deepEqual(commands, []);
  assert.equal(commits, 0, 'a skip already moot forces no drain and waits out no commit');
});

test('the song ended during the commit wait: 409 track-changed, no skip', async () => {
  duringCommit = () => songOnAir('B', 0);
  const r = await skip({ expectId: 'A' });
  assert.equal(r.status, 409);
  assert.equal(r.body.reason, 'track-changed');
  assert.equal(r.body.onAirId, 'B');
  assert.equal(commits, 1, 'checked again AFTER the wait, immediately before the telnet skip');
  assert.deepEqual(commands, []);
});

for (const [kind, reason] of [['jingle', 'jingle-on-air'], ['bed', 'bed-on-air'], ['break', 'break-on-air']] as const) {
  test(`a ${kind} on air after the song (now-playing still names it): 409 ${reason}`, async () => {
    marker(kind, 5);
    const r = await skip({ expectId: 'A' });
    assert.equal(r.status, 409);
    assert.equal(r.body.reason, reason);
    assert.equal(r.body.onAirId, 'A', 'now-playing still names the song — that is the trap');
    assert.deepEqual(commands, []);
  });
}

test('a jingle fed during the commit wait: 409 jingle-on-air, no skip', async () => {
  duringCommit = () => marker('jingle', 0.2);
  const r = await skip({ expectId: 'A' });
  assert.equal(r.status, 409);
  assert.equal(r.body.reason, 'jingle-on-air');
  assert.deepEqual(commands, []);
});

test('no now-playing at all cannot confirm the target: refused', async () => {
  rmSync(config.liquidsoap.nowPlayingFile, { force: true });
  const r = await skip({ expectId: 'A' });
  assert.equal(r.status, 409);
  assert.equal(r.body.reason, 'track-changed');
  assert.equal(r.body.onAirId, null);
  assert.deepEqual(commands, []);
});

// The decision reads the files, never the watcher's in-memory copy, which can
// be a tick behind.
test('a stale in-memory now-playing does not decide: the file does', async () => {
  (queue as any)._nowPlaying = { title: 'A', subsonic_id: 'A' };
  (queue as any)._nowPlayingFresh = true;
  songOnAir('B', 1);
  try {
    const r = await skip({ expectId: 'A' });
    assert.equal(r.status, 409);
    assert.equal(r.body.reason, 'track-changed');
    assert.deepEqual(commands, []);
  } finally {
    (queue as any)._nowPlayingFresh = false;
    (queue as any)._nowPlaying = null;
  }
});

test('a booth line names the refusal', async () => {
  marker('bed', 5);
  await skip({ expectId: 'A' });
  const line = queue.djLog.find(e => e.message.startsWith('operator skip refused'));
  assert.ok(line, 'refusal logged');
  assert.match(line.message, /bed is on air/);
});

// ── the MCP surface ──────────────────────────────────────────────────────────

test('MCP client: no expectId sends the bare skip, byte for byte', async () => {
  const c = new SubwaveClient({ baseUrl: http.url });
  const r = await c.skipTrack();
  assert.equal(r.ok, true);
  assert.deepEqual(received, [{ contentType: null, body: undefined }]);
  assert.deepEqual(commands, ['skip']);
});

test('MCP client: a refused targeted skip is an answer (ok: false), not a thrown error', async () => {
  const c = new SubwaveClient({ baseUrl: http.url });
  marker('jingle', 5);
  const r = await c.skipTrack('A');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'jingle-on-air');
  assert.deepEqual(received.map(x => x.body), [{ expectId: 'A' }]);
  assert.deepEqual(commands, []);
});

test('MCP tool: expectId is optional and a refusal is reported, not an isError', async () => {
  const handlers = new Map<string, (args: any) => Promise<any>>();
  const schemas = new Map<string, any>();
  const stub = {
    registerTool: (name: string, def: any, handler: (args: any) => Promise<any>) => {
      handlers.set(name, handler);
      schemas.set(name, def);
    },
  } as any;
  registerSubwaveTools(stub, new SubwaveClient({ baseUrl: http.url }));
  const tool = handlers.get('subwave_skip_track');
  assert.ok(tool);
  assert.ok(schemas.get('subwave_skip_track').inputSchema.expectId, 'expectId is declared');

  const bare = await tool({});
  assert.equal(bare.isError, undefined);
  assert.equal(bare.structuredContent.ok, true);
  assert.deepEqual(commands, ['skip']);

  commands.length = 0;
  songOnAir('B', 2);
  const refused = await tool({ expectId: 'A' });
  assert.equal(refused.isError, undefined);
  assert.equal(refused.structuredContent.ok, false);
  assert.equal(refused.structuredContent.reason, 'track-changed');
  assert.match(refused.content[0].text, /refused \(track-changed\)/);
  assert.deepEqual(commands, []);
});

// Through a real McpServer + Client pair: the SDK client validates structured
// content against the published output schema with no additional properties,
// so a field the route answers with and the schema does not declare is a
// thrown -32602 — after the skip (or the refusal) has already happened.
test('MCP tool over the real SDK: the bare skip and a refusal both arrive as results', async () => {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const server = new McpServer({ name: 'targeted-skip', version: '0' });
  registerSubwaveTools(server, new SubwaveClient({ baseUrl: http.url }));
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'targeted-skip', version: '0' });
  await client.connect(clientSide);
  try {
    await client.listTools();
    const bare: any = await client.callTool({ name: 'subwave_skip_track', arguments: {} });
    assert.equal(bare.isError, undefined);
    assert.deepEqual(bare.structuredContent, { ok: true, pending: false, committed: false });
    assert.deepEqual(commands, ['skip']);

    commands.length = 0;
    marker('jingle', 5);
    const refused: any = await client.callTool({ name: 'subwave_skip_track', arguments: { expectId: 'A' } });
    assert.equal(refused.isError, undefined);
    assert.equal(refused.structuredContent.ok, false);
    assert.equal(refused.structuredContent.reason, 'jingle-on-air');
    assert.equal(refused.structuredContent.onAirId, 'A');
    assert.deepEqual(commands, []);
  } finally {
    await client.close();
  }
});

// ── the pure halves ──────────────────────────────────────────────────────────

test('songFedAtMs counts the song from the end of its truncated second', () => {
  assert.equal(songFedAtMs({ timestamp: 100 }), 101_000);
  assert.equal(songFedAtMs({ timestamp: '100' }), 101_000);
  assert.equal(songFedAtMs({}), null);
  assert.equal(songFedAtMs(null), null);
  assert.equal(songFedAtMs({ timestamp: 'soon' }), null);
  assert.equal(songFedAtMs({ timestamp: 0 }), null);
});

test('targetedSkipRefusal: a changed id outranks an interposed item', () => {
  assert.equal(targetedSkipRefusal({ expectId: 'A', onAirId: 'A', jingleOnAir: false, interposed: null }), null);
  assert.equal(targetedSkipRefusal({ expectId: 'A', onAirId: 'B', jingleOnAir: true, interposed: null }), 'track-changed');
  assert.equal(targetedSkipRefusal({ expectId: 'A', onAirId: null, jingleOnAir: false, interposed: null }), 'track-changed');
  assert.equal(targetedSkipRefusal({ expectId: 'A', onAirId: 'A', jingleOnAir: false, interposed: 'break' }), 'break-on-air');
  assert.equal(targetedSkipRefusal({ expectId: 'A', onAirId: 'A', jingleOnAir: true, interposed: null }), 'jingle-on-air');
});

test('skipJingleCrossSec: the longest outgoing tail a jingle can wait behind', () => {
  assert.equal(skipJingleCrossSec(10), 14, 'a per-track stamp can reach CROSS_MAX_SECONDS');
  assert.equal(skipJingleCrossSec(20), 20, 'an unstamped track carries the station crossfade');
  assert.equal(skipJingleCrossSec(undefined), 14);
});

test('the body schema: no target unless expectId is a usable id', () => {
  const parse = (b: unknown) => skipBodySchema.safeParse(b);
  for (const b of [undefined, null, 'text', [], {}, { expectId: null }, { expectId: undefined }, { other: 1 }]) {
    const r = parse(b);
    assert.ok(r.success, JSON.stringify(b));
    assert.equal(r.data.expectId ?? null, null, JSON.stringify(b));
  }
  const r = parse({ expectId: '  A1  ', other: 1 });
  assert.ok(r.success);
  assert.equal(r.data.expectId, 'A1');
  assert.equal('other' in r.data, false);
});

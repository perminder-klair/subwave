// The proof that the mixer can read MUSIC_LIBRARY_PATH (music/library-mount.ts),
// mostly its safe direction. Liquidsoap opens the file in the broadcast container,
// so a local path it can't open is dead air, and nothing notices: a local hit gets
// no resolve probe, and auto.m3u is built from the same paths. So every answer but
// an exact "yes" must stream, and a proof must go as soon as it stops being true.
// The proof reads one sample, so each pick's own file is asked about too (#2222);
// library-mount-drain.test.ts drives that through the real drain.
// Against a fake mixer on a real socket; radio.liq's own command is run on real
// Liquidsoap by hand, because no test here can start one.
//
// Run: npm test -- library-mount

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after, beforeEach } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const YES = 'yes\nEND\n';
const NO = 'no\nEND\n';
const OLDER_MIXER = 'ERROR: unknown command, type "help" to get a list of commands.\nEND\n';

// What the fake mixer does with the next question. A string is the reply; `hang`
// accepts and never answers; `drop` closes without a word.
let reply: string | 'hang' | 'drop' = YES;
// Files the mixer's own copy lacks: a broadcast mount narrower than the controller's.
const missing = new Set<string>();
// How long the mixer keeps answering after it is told to restart.
let restartDelayMs = 0;
const held: Socket[] = [];
const commands: string[] = [];

function handle(socket: Socket) {
  socket.on('error', () => {});
  socket.once('data', (data) => {
    const command = data.toString().trim();
    commands.push(command);
    if (command === 'restart') {
      // The port going down is what proves a restart landed.
      const server = mixer;
      const down = () => { socket.destroy(); server.close(); };
      if (restartDelayMs > 0) setTimeout(down, restartDelayMs);
      else down();
      return;
    }
    if (command.startsWith('path_readable ') && missing.has(command.slice('path_readable '.length))) {
      socket.end(NO);
      return;
    }
    if (reply === 'hang') {
      held.push(socket);
      return;
    }
    if (reply === 'drop') socket.destroy();
    else socket.end(reply);
  });
}

let mixer: Server = createServer(handle);
await new Promise<void>(resolve => mixer.listen(0, '127.0.0.1', resolve));
const address = mixer.address();
if (!address || typeof address === 'string') throw new Error('mixer has no TCP port');
const PORT = address.port;
const listen = async () => {
  mixer = createServer(handle);
  await new Promise<void>(resolve => mixer.listen(PORT, '127.0.0.1', resolve));
};

process.env.LIQUIDSOAP_HOST = '127.0.0.1';
process.env.LIQUIDSOAP_PORT = String(PORT);
const base = createTempDir(join(tmpdir(), 'subwave-library-mount-'));

const { pathReadable, restartLiquidsoap } = await import('../src/broadcast/liquidsoap-control.js');
const {
  libraryMountProven, libraryMountStands, mixerReadablePath, onLibraryMountLost, proveLibraryMount,
  _resetLibraryMount, _setReproveAfterRestartMs,
} = await import('../src/music/library-mount.js');
const { libraryMountFinding } = await import('../src/music/library-mount-policy.js');
const { findLibraryFile, getAnnotatedUri, getLocalPath, getPlayableUri } = await import('../src/music/subsonic.js');

const SONG = 'Artist/Album/01 - Song.flac';
const track = { id: 'abc', title: 'Song', artist: 'Artist', album: 'Album', path: SONG };
let run = 0;
let root = '';
let lost = 0;
onLibraryMountLost(() => { lost += 1; });

function put(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'x');
  return path;
}

beforeEach(() => {
  _resetLibraryMount();
  reply = YES;
  missing.clear();
  restartDelayMs = 0;
  commands.length = 0;
  lost = 0;
  root = join(base, `mount-${(run += 1)}`);
  put(join(root, SONG));
  process.env.MUSIC_LIBRARY_PATH = root;
});

after(async () => {
  _resetLibraryMount();
  delete process.env.MUSIC_LIBRARY_PATH;
  for (const socket of held) socket.destroy();
  await new Promise<void>(resolve => mixer.close(() => resolve()));
  await removeTempDir(base);
});

const streams = () => {
  assert.equal(getLocalPath(track), null);
  assert.match(String(getPlayableUri(track)), /^subhttp:/);
  assert.match(getAnnotatedUri(track), /:subhttp:/);
};
async function waitFor(check: () => boolean, ms = 3000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const playsLocal = () => {
  assert.equal(getLocalPath(track), `${root}/${SONG}`);
  assert.equal(getPlayableUri(track), `${root}/${SONG}`);
  assert.ok(getAnnotatedUri(track).endsWith(`:${root}/${SONG}`));
};

test('a mount nobody has proven streams, however plainly the file is on disk here', () => {
  assert.equal(findLibraryFile(track), `${root}/${SONG}`, 'the controller can see it');
  streams();
  assert.deepEqual(commands, [], 'and reading the answer asks nothing');
});

test('an exact yes from the mixer proves the mount, and the file still has to exist', async () => {
  const proof = await proveLibraryMount();
  assert.deepEqual(proof, { mount: root, state: 'proven', sample: join(root, SONG) });
  assert.deepEqual(commands, [`path_readable ${join(root, SONG)}`], 'asked about a real file off the mount');
  playsLocal();
  assert.equal(getLocalPath({ path: 'Nobody/Nothing/02.flac' }), null, 'a proof is no licence for a missing file');
  assert.match(String(getPlayableUri({ id: 'x', path: 'Nobody/Nothing/02.flac' })), /^subhttp:/);
});

for (const [name, answer, state] of [
  ['the mixer cannot read it', NO, 'unreadable'],
  ['an older mixer without the command', OLDER_MIXER, 'unknown'],
  ['an empty close', '', 'unknown'],
  ['a dropped connection', 'drop', 'unknown'],
  ['an answer with no terminator', 'yes\n', 'unknown'],
  ['a truncated terminator', 'yes\nEND', 'unknown'],
  ['an inline terminator', 'yesEND\n', 'unknown'],
  ['the wrong case', 'YES\nEND\n', 'unknown'],
  ['a longer word', 'yesterday\nEND\n', 'unknown'],
  ['words after it', 'yes please\nEND\n', 'unknown'],
  ['a second line', 'yes\nno\nEND\n', 'unknown'],
  ['a quoted yes', '"yes"\nEND\n', 'unknown'],
  ['nothing but the terminator', 'END\n', 'unknown'],
] as const) {
  test(`streams on ${name}`, async () => {
    reply = answer;
    assert.equal((await proveLibraryMount())?.state, state);
    streams();
  });
}

test('a mixer that never answers is given up on, and streams', async () => {
  reply = 'hang';
  const started = Date.now();
  assert.equal((await proveLibraryMount())?.state, 'unknown');
  assert.ok(Date.now() - started < 4_000, 'a bounded wait');
  streams();
});

test('a mixer that is down streams', async () => {
  await new Promise<void>(resolve => mixer.close(() => resolve()));
  try {
    assert.equal((await proveLibraryMount())?.state, 'unknown');
    streams();
  } finally {
    await listen();
  }
});

test('getLocalPath answers synchronously from the cache and never touches telnet', async () => {
  await proveLibraryMount();
  commands.length = 0;
  reply = 'hang';
  for (let i = 0; i < 100; i++) assert.equal(typeof getLocalPath(track), 'string');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(commands, []);
});

test('a proof is for its own mount', async () => {
  await proveLibraryMount();
  playsLocal();
  const other = join(base, `other-${run}`);
  put(join(other, SONG));
  process.env.MUSIC_LIBRARY_PATH = other;
  assert.equal(findLibraryFile(track), `${other}/${SONG}`);
  assert.equal(getLocalPath(track), null);
  process.env.MUSIC_LIBRARY_PATH = root;
  assert.equal(getLocalPath(track), `${root}/${SONG}`);
});

test('no mount asks nothing and plays nothing local', async () => {
  delete process.env.MUSIC_LIBRARY_PATH;
  assert.equal(await proveLibraryMount(), null);
  assert.deepEqual(commands, []);
  assert.equal(getLocalPath(track), null);
});

test('a proof that stops being true goes at once, and the coast is told once', async () => {
  await proveLibraryMount();
  playsLocal();

  reply = NO;
  await proveLibraryMount();
  streams();
  assert.equal(lost, 1);

  await proveLibraryMount();
  assert.equal(lost, 1, 'only the change');
});

for (const [name, answer] of [
  ['a telnet failure', 'drop'],
  ['an older mixer after an image change', OLDER_MIXER],
] as const) {
  test(`${name} loses a standing proof too`, async () => {
    await proveLibraryMount();
    reply = answer;
    await proveLibraryMount();
    streams();
    assert.equal(lost, 1);
  });
}

test('a proof that comes back is good again, and a second loss tells the coast again', async () => {
  await proveLibraryMount();
  reply = NO;
  await proveLibraryMount();
  reply = YES;
  await proveLibraryMount();
  playsLocal();
  assert.equal(lost, 1);
  reply = NO;
  await proveLibraryMount();
  assert.equal(lost, 2);
});

test('a mount never proven has nothing for the coast to undo', async () => {
  reply = NO;
  await proveLibraryMount();
  await proveLibraryMount();
  assert.equal(lost, 0);
});

test('a mixer restart drops the proof before the restart is even sent', async () => {
  await proveLibraryMount();
  playsLocal();

  const restarting = restartLiquidsoap();
  streams();
  await restarting;
  streams();
  await listen();
});

test('the mixer that comes back with the mount proves it again, and the coast keeps its paths', async () => {
  await proveLibraryMount();
  await restartLiquidsoap();
  await listen();

  await proveLibraryMount();
  playsLocal();
  assert.equal(lost, 0);
});

test('the mixer that comes back without the mount streams, and the coast is told', async () => {
  await proveLibraryMount();
  await restartLiquidsoap();
  await listen();

  reply = NO;
  await proveLibraryMount();
  streams();
  assert.equal(lost, 1);
});

test('a yes asked before a restart says nothing about the mixer after it', async () => {
  reply = 'hang';
  const asking = proveLibraryMount();
  await new Promise(resolve => setTimeout(resolve, 30));

  reply = YES;
  await restartLiquidsoap();
  await listen();
  held.pop()?.end(YES);
  await asking;

  streams();
});

test('a proof answered while a restart is under way goes once the restart lands', async () => {
  // The old mixer still answers between the restart command and the port going
  // down, and its yes says nothing about the mixer that comes back.
  await proveLibraryMount();
  restartDelayMs = 150;
  const restarting = restartLiquidsoap();
  try {
    await waitFor(() => commands.includes('restart'));
    await proveLibraryMount();
    playsLocal();
    await restarting;
    streams();
  } finally {
    await restarting.catch(() => {});
    await listen();
  }
});

test('the mixer is proven again on its own after a restart, with nobody asking', async () => {
  _setReproveAfterRestartMs(200);
  await proveLibraryMount();
  await restartLiquidsoap();
  await listen();
  commands.length = 0;
  streams();

  await waitFor(() => libraryMountProven(root));
  assert.deepEqual(commands, [`path_readable ${join(root, SONG)}`]);
  playsLocal();
  assert.equal(lost, 0);
});

test('concurrent asks share one question', async () => {
  const [a, b] = await Promise.all([proveLibraryMount(), proveLibraryMount()]);
  assert.equal(commands.length, 1);
  assert.deepEqual(a, b);
});

test('the sample is an audio file, past hidden folders, artwork and unsendable names', async () => {
  const mount = join(base, `walk-${run}`);
  put(join(mount, '.stfolder/hidden.flac'));
  put(join(mount, 'cover.jpg'));
  put(join(mount, 'Artist/notes.txt'));
  put(join(mount, 'Artist/bad\nname.flac'));
  const song = put(join(mount, 'Artist/Album/deep/01.MP3'));
  process.env.MUSIC_LIBRARY_PATH = mount;

  assert.equal((await proveLibraryMount())?.sample, song);
});

test('a re-proof keeps its sample, and walks again when that file has gone', async () => {
  const first = (await proveLibraryMount())?.sample as string;
  // A symlink still opens, and a walk would pass it by: only the kept sample finds it.
  rmSync(first);
  symlinkSync(put(join(base, `elsewhere-${run}.flac`)), first);
  assert.deepEqual(await proveLibraryMount(), { mount: root, state: 'proven', sample: first });
  assert.deepEqual(commands, [`path_readable ${first}`, `path_readable ${first}`]);

  rmSync(first);
  const second = put(join(root, 'Artist/Album/02 - Other.flac'));
  assert.equal((await proveLibraryMount())?.sample, second);
});

for (const [name, setup] of [
  ['a mount with no audio on it', (mount: string) => put(join(mount, 'cover.jpg'))],
  ['a mount that is not there', () => {}],
] as const) {
  test(`${name} is not proven, and the mixer is not asked`, async () => {
    const mount = join(base, `none-${run}`);
    setup(mount);
    process.env.MUSIC_LIBRARY_PATH = mount;
    assert.equal((await proveLibraryMount())?.state, 'no-sample');
    assert.deepEqual(commands, []);
    assert.equal(libraryMountProven(mount), false);
  });
}

// The pick's own file (#2222). The proof reads one sample, so it can't speak for
// a file the mixer's copy lacks, or for a mount that dropped since the last tick.
const OTHER = 'Other/Album/01 - Elsewhere.flac';
const other = { id: 'def', title: 'Elsewhere', artist: 'Other', album: 'Album', path: OTHER };

test('a pick goes local only on the mixer\'s yes to its own file', async () => {
  await proveLibraryMount();
  commands.length = 0;
  assert.equal(await mixerReadablePath(getLocalPath(track), 1500), `${root}/${SONG}`);
  assert.deepEqual(commands, [`path_readable ${root}/${SONG}`], 'asked about the pick, not the sample');
});

test('a file the mixer\'s copy lacks streams, and the mount stays proven for the rest', async () => {
  put(join(root, OTHER));
  missing.add(join(root, OTHER));
  await proveLibraryMount();
  assert.equal(getLocalPath(other), `${root}/${OTHER}`, 'the proof alone would have sent it local');
  commands.length = 0;

  assert.equal(await mixerReadablePath(getLocalPath(other), 1500), null);
  await proveLibraryMount();
  assert.deepEqual(commands.slice(0, 2), [`path_readable ${root}/${OTHER}`, `path_readable ${join(root, SONG)}`],
    'a no re-proves the mount at once');
  playsLocal();
  assert.equal(lost, 0, 'the coast keeps its paths');
});

test('a mount that dropped under the mixer streams the pick and takes the coast with it at once', async () => {
  await proveLibraryMount();
  reply = NO;
  assert.equal(await mixerReadablePath(getLocalPath(track), 1500), null);
  await waitFor(() => lost === 1);
  streams();
  assert.equal(libraryMountStands(), false);
});

test('no proof, no file or no budget asks nothing, and streams', async () => {
  assert.equal(await mixerReadablePath(`${root}/${SONG}`, 1500), null, 'unproven');
  await proveLibraryMount();
  commands.length = 0;
  assert.equal(await mixerReadablePath(null, 1500), null, 'no file on the mount');
  for (const budget of [0, -5, Number.NaN]) {
    assert.equal(await mixerReadablePath(getLocalPath(track), budget), null, `budget ${budget}`);
  }
  assert.deepEqual(commands, []);
});

for (const [name, answer] of [
  ['an answer past the budget', 'hang'],
  ['an empty close', ''],
  ['a dropped connection', 'drop'],
] as const) {
  test(`${name} streams the pick, and leaves the proof alone`, async () => {
    await proveLibraryMount();
    reply = answer;
    const started = Date.now();
    assert.equal(await mixerReadablePath(getLocalPath(track), 150), null);
    assert.ok(Date.now() - started < 1000, 'within the budget, not the 2 s default');
    reply = YES;
    assert.ok(libraryMountStands(), 'only a no re-proves');
    assert.equal(lost, 0);
  });
}

test('a yes from the mixer a restart replaced streams the pick, even once the new one is proven', async () => {
  await proveLibraryMount();
  reply = 'hang';
  const before = held.length;
  const asking = mixerReadablePath(getLocalPath(track), 1500);
  await waitFor(() => held.length > before);

  reply = YES;
  await restartLiquidsoap();
  await listen();
  await proveLibraryMount();
  held.pop()?.end(YES);

  assert.equal(await asking, null);
  playsLocal();
});

test('the proof the drain checks as it writes is the standing one', async () => {
  assert.equal(libraryMountStands(), false);
  await proveLibraryMount();
  assert.equal(libraryMountStands(), true);
  const restarting = restartLiquidsoap();
  try {
    assert.equal(libraryMountStands(), false, 'a restart drops it before it is sent');
  } finally {
    await restarting.catch(() => {});
    await listen();
  }
});

test('pathReadable believes an exact answer and nothing else', async () => {
  for (const [answer, expected] of [
    [YES, 'yes'], ['yes\r\nEND\r\n', 'yes'], [NO, 'no'], ['no\r\nEND\r\n', 'no'],
    [OLDER_MIXER, 'unknown'], ['', 'unknown'], ['yes\n', 'unknown'], ['yes\nEND', 'unknown'],
    ['maybe\nEND\n', 'unknown'], ['yes no\nEND\n', 'unknown'],
  ] as const) {
    reply = answer;
    assert.equal(await pathReadable('/music/a.flac'), expected, JSON.stringify(answer));
  }
});

test('pathReadable sends one line, or nothing', async () => {
  reply = YES;
  for (const path of ['', '/music/a\nskip', '/music/a\rrestart', '/music/a\0b']) {
    assert.equal(await pathReadable(path), 'unknown', JSON.stringify(path));
  }
  assert.deepEqual(commands, [], 'a newline would be a second telnet command');

  await pathReadable('/music/Chunga\'s Revenge (1970)/01 - Sóng.flac');
  assert.deepEqual(commands, ['path_readable /music/Chunga\'s Revenge (1970)/01 - Sóng.flac']);
});

// Every path handed to Liquidsoap has to pass the proof; a reader in this
// container must not. A new caller belongs in one list or the other.
test('only Liquidsoap-bound callers go through getLocalPath', () => {
  const src = new URL('../src', import.meta.url).pathname;
  const callers: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.ts') && /\bgetLocalPath\(/.test(readFileSync(path, 'utf8').replace(/^\s*\/\/.*$/gm, ''))) {
        callers.push(path.slice(src.length + 1));
      }
    }
  };
  walk(src);
  assert.deepEqual(callers.sort(), ['broadcast/queue.ts', 'music/subsonic.ts']);

  const queue = readFileSync(join(src, 'broadcast/queue.ts'), 'utf8');
  assert.equal(queue.match(/\bgetLocalPath\(/g)?.length, 1, 'the drain decides once, and the URI is built from that decision');
  assert.match(queue, /const onMount = subsonic\.getLocalPath\(item\.track\);\n\s*let localPath = await libraryMount\.mixerReadablePath\(onMount, /);
  assert.match(queue, /item\.resolveProbeId = localPath \? undefined : randomBytes/);
  assert.match(queue, /source = subsonic\.findLibraryFile\(item\.track\)/, 'ffprobe reads it from this container');
});

test('the coast rebuilds as soon as the proof is lost', async () => {
  const scheduler = readFileSync(new URL('../src/broadcast/scheduler.ts', import.meta.url), 'utf8');
  const wiring = scheduler.slice(scheduler.indexOf('onLibraryMountLost(() =>'));
  assert.match(wiring.slice(0, 400), /refreshAutoPlaylist\(\{ automatic: true \}\)/);
  assert.match(scheduler, /cron\.schedule\('\* \* \* \* \*', libraryMountTick\)/, 're-proven every minute');
});

test('the Doctor asks the mixer, and only on a station with a mount', async () => {
  const { checkBroadcast } = await import('../src/doctor/checks-services.js');
  const row = async () => (await checkBroadcast()).find(f => f.label === 'library mount');

  assert.equal((await row())?.status, 'ok');
  assert.ok(commands.some(c => c.startsWith('path_readable ')));

  reply = NO;
  const warned = await row();
  assert.equal(warned?.status, 'warn');
  assert.match(warned?.hint || '', /same path as the controller/);
  streams();

  reply = OLDER_MIXER;
  assert.equal((await row())?.status, 'warn');

  delete process.env.MUSIC_LIBRARY_PATH;
  assert.equal(await row(), undefined);
});

test('the Doctor reads each state, with the fix', () => {
  const finding = (state: 'proven' | 'unreadable' | 'unknown' | 'no-sample') =>
    libraryMountFinding({ mount: '/music', state, sample: null });

  assert.deepEqual(finding('proven'), { status: 'ok', detail: 'the mixer reads /music' });

  const unreadable = finding('unreadable');
  assert.equal(unreadable.status, 'warn');
  assert.match(unreadable.detail, /can't read/);
  assert.match(unreadable.hint || '', /broadcast container/);
  assert.match(unreadable.hint || '', /same path/);

  const unknown = finding('unknown');
  assert.equal(unknown.status, 'warn');
  assert.match(unknown.hint || '', /update the broadcast image/);

  assert.equal(finding('no-sample').status, 'warn');
  for (const state of ['unreadable', 'unknown', 'no-sample'] as const) {
    assert.match(finding(state).hint || '', /every track streams/, 'and says the music stays on air');
  }
});

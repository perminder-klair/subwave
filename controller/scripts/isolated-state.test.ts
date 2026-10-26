// The operator tools that call a model from a clone (llm-bench,
// leanings:replay) run on a disposable copy of the station's keys, never on
// the station's own state root. Importing src/ against that root was enough to
// write into it: logs/ and voice/ created, an oversized picks.log renamed over
// the station's picks.log.old, and every model call appended to its events log.
// See test-utils/isolated-state.ts.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  copyStationKeys, isolateStationState, STATION_KEY_FILES, sweepAbandonedDirs,
} from './test-utils/isolated-state.js';
import { createTempDir } from './test-utils/temp-dir.js';

const controller = fileURLToPath(new URL('../', import.meta.url));
const helper = pathToFileURL(join(controller, 'scripts/test-utils/isolated-state.ts')).href;

// telemetry/log.ts and subsonic-log.ts rotate their logs past 10 MiB on module
// load.
const OVERSIZED_LOG = Math.ceil(10.1 * 1024 * 1024);

// Every entry under `root`, directories included: a tool that only created an
// empty logs/ or voice/ must show up too.
function snapshot(root: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = join(prefix, entry.name);
    if (entry.isDirectory()) {
      out[`${rel}/`] = 'dir';
      Object.assign(out, snapshot(root, rel));
    } else {
      const path = join(root, rel);
      const mode = (statSync(path).mode & 0o777).toString(8);
      out[rel] = `${mode} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
    }
  }
  return out;
}

function stationRoot(): string {
  const root = createTempDir(join(tmpdir(), 'subwave-isolated-source-'));
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ llm: { provider: 'openai-compatible', model: 'source-model' } }), { mode: 0o600 });
  writeFileSync(join(root, 'schedule.json'), JSON.stringify({ shows: [], schedule: [] }));
  writeFileSync(join(root, 'secrets.env'), 'OPENROUTER_API_KEY=sk-from-the-station\n', { mode: 0o600 });
  writeFileSync(join(root, 'setup-config.json'), '{"navidrome":{}}');
  writeFileSync(join(root, 'library.db'), 'not a database');
  writeFileSync(join(root, 'queue.json'), '{"queue":[]}');
  mkdirSync(join(root, 'logs'));
  writeFileSync(join(root, 'logs', 'picks.log'), Buffer.alloc(OVERSIZED_LOG, 0x61));
  writeFileSync(join(root, 'logs', 'subsonic.log'), Buffer.alloc(OVERSIZED_LOG, 0x62));
  writeFileSync(join(root, 'logs', 'picks.log.old'), 'the station\'s previous rotation\n');
  writeFileSync(join(root, 'logs', 'events-2026-01-01.jsonl'), '{"type":"llm","usage":{"total":99}}\n');
  return root;
}

// The pid of a process that has exited, for a dir whose owner is gone.
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  await once(child, 'exit');
  assert.ok(child.pid);
  return child.pid;
}

async function run(args: string[], env: Record<string, string>) {
  const child = spawn(process.execPath, ['--import', 'tsx', ...args], {
    cwd: controller, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
  child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 60_000);
  try {
    const [code] = await once(child, 'exit');
    return { code, output };
  } finally { clearTimeout(timeout); }
}

test('copies the active station\'s settings, schedule and secrets at 0600, and nothing else', () => {
  const root = stationRoot();
  const dest = createTempDir(join(tmpdir(), 'subwave-isolated-dest-'));
  assert.deepEqual(copyStationKeys(root, dest), [...STATION_KEY_FILES]);
  assert.deepEqual(readdirSync(dest).sort(), ['schedule.json', 'secrets.env', 'settings.json']);
  for (const name of STATION_KEY_FILES) {
    assert.equal(readFileSync(join(dest, name), 'utf8'), readFileSync(join(root, name), 'utf8'), name);
    assert.equal(statSync(join(dest, name)).mode & 0o777, 0o600, `${name} must not be readable by others`);
  }
});

test('a multi-station root copies the ACTIVE station\'s files', () => {
  const root = createTempDir(join(tmpdir(), 'subwave-isolated-source-'));
  for (const id of ['main', 'night']) {
    mkdirSync(join(root, 'stations', id), { recursive: true });
    writeFileSync(join(root, 'stations', id, 'settings.json'), JSON.stringify({ station: id }));
    writeFileSync(join(root, 'stations', id, 'secrets.env'), `OPENAI_API_KEY=${id}\n`);
  }
  writeFileSync(join(root, 'stations', 'active.json'), JSON.stringify({ activeId: 'night' }));
  const dest = createTempDir(join(tmpdir(), 'subwave-isolated-dest-'));
  assert.deepEqual(copyStationKeys(root, dest), ['settings.json', 'secrets.env']);
  assert.equal(readFileSync(join(dest, 'settings.json'), 'utf8'), '{"station":"night"}');
  assert.equal(readFileSync(join(dest, 'secrets.env'), 'utf8'), 'OPENAI_API_KEY=night\n');
});

// A Ctrl-C while a tool is still loading src/ ends as SIGKILL (tsx's parent
// gives the busy child ~60 ms to answer), so no 'exit' runs and the next run
// has to clear the dir. Only names the helper mints, only a directory, and only
// for a dead owner.
test('a dir whose owner has gone is swept; a live owner\'s, and any other name or entry, is kept', async () => {
  const parent = createTempDir(join(tmpdir(), 'subwave-isolated-sweep-'));
  const at = (name: string) => join(parent, name);
  const withKeys = (path: string) => {
    mkdirSync(path);
    writeFileSync(join(path, 'secrets.env'), 'OPENROUTER_API_KEY=sk-left-behind\n');
  };
  const dead = await deadPid();
  // In creation order: the symlink needs its target first.
  const fixtures: Array<{ name: string; make: (path: string) => void; swept: boolean }> = [
    { name: `subwave-x-${dead}-AbC123`, make: withKeys, swept: true },
    { name: `subwave-x-${process.pid}-AbC123`, make: withKeys, swept: false },
    // Pid 1 answers EPERM to a non-root runner and is alive to root: kept either way.
    { name: 'subwave-x-1-AbC123', make: withKeys, swept: false },
    { name: 'subwave-x-notes', make: withKeys, swept: false },
    { name: `subwave-y-${dead}-AbC123`, make: withKeys, swept: false },
    // The helper only ever mints directories.
    { name: `subwave-x-${dead}-File01`, make: (p) => writeFileSync(p, 'not a dir'), swept: false },
    { name: 'target', make: withKeys, swept: false },
    { name: `subwave-x-${dead}-Link01`, make: (p) => symlinkSync(at('target'), p), swept: false },
  ];
  for (const { name, make } of fixtures) make(at(name));

  assert.deepEqual(sweepAbandonedDirs(parent, 'subwave-x-'), fixtures.filter((f) => f.swept).map((f) => f.name));
  for (const { name, swept } of fixtures) {
    assert.equal(existsSync(at(name)), !swept, `${name} is ${swept ? 'swept' : 'kept'}`);
  }
});

// A dir another user owns cannot be made without root, so the sweep is told
// this one belongs to someone else instead.
test('an abandoned dir another user owns is never swept', { skip: process.getuid === undefined }, async () => {
  const parent = createTempDir(join(tmpdir(), 'subwave-isolated-sweep-'));
  const name = `subwave-x-${await deadPid()}-AbC123`;
  mkdirSync(join(parent, name));

  assert.deepEqual(sweepAbandonedDirs(parent, 'subwave-x-', process.getuid!() + 1), []);
  assert.ok(existsSync(join(parent, name)), 'another user\'s dir is kept');
  assert.deepEqual(sweepAbandonedDirs(parent, 'subwave-x-'), [name], 'the same dir is swept as its owner\'s');
});

// The usage error is reached only after every src/ import has run, so a tool
// that loads src/ against the station's root has already written to it.
for (const [tool, args, prefix] of [
  ['llm-bench', ['scripts/llm-bench/cli.ts'], 'subwave-llm-bench-'],
  ['leanings:replay', ['scripts/agentic-leanings-replay.ts', 'unused-fixture.json', '0'], 'subwave-agentic-leanings-replay-'],
] as const) {
  test(`${tool} leaves the station's state root untouched and removes its own`, { timeout: 90_000 }, async () => {
    const root = stationRoot();
    const tmp = createTempDir(join(tmpdir(), 'subwave-isolated-tmp-'));
    mkdirSync(join(tmp, `${prefix}${await deadPid()}-AbC123`));
    const before = snapshot(root);
    const { code, output } = await run([...args], { STATE_DIR: root, TMPDIR: tmp });
    assert.equal(code, 2, output);
    assert.match(output, /Usage: npm run/);
    assert.deepEqual(snapshot(root), before, 'no new dir, no rotated picks.log, no appended line');
    assert.deepEqual(readdirSync(tmp).filter((name) => name.startsWith(prefix)), [], 'its own dir is removed on exit, and a killed run\'s is swept');
  });
}

test('module-load writes and telemetry appends land in the isolated dir; keys still resolve from the station', { timeout: 60_000 }, async () => {
  const root = stationRoot();
  const before = snapshot(root);
  delete process.env.OPENROUTER_API_KEY;
  process.env.STATE_DIR = root;
  const { sourceRoot, dir } = isolateStationState('subwave-isolated-inproc-');
  assert.equal(sourceRoot, root);
  assert.equal(process.env.STATE_DIR, dir);

  const { recordPick } = await import('../src/llm/log.js');
  const { logEvent } = await import('../src/observability/events.js');
  await import('../src/audio/piper.js');
  const { loadSecretsIntoEnv } = await import('../src/setup/secrets.js');
  const settings = await import('../src/settings.js');
  await settings.load();
  assert.equal(settings.get().llm.model, 'source-model');
  await loadSecretsIntoEnv();
  assert.equal(process.env.OPENROUTER_API_KEY, 'sk-from-the-station');

  recordPick({ song: { id: 'bench-id', artist: 'Bench', title: 'Run' }, reason: 'bench', source: 'bench' });
  logEvent('llm', { kind: 'bench', usage: { total: 7 } });
  const picksLog = join(dir, 'logs', 'picks.log');
  const deadline = Date.now() + 5_000;
  while (!(existsSync(picksLog) && readdirSync(join(dir, 'logs')).some((name) => name.startsWith('events-')))) {
    assert.ok(Date.now() < deadline, 'appends never reached the isolated dir');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.match(readFileSync(picksLog, 'utf8'), /Bench — Run/);
  assert.ok(existsSync(join(dir, 'voice')));
  assert.deepEqual(snapshot(root), before);
});

const SIGNAL_PREFIX = 'subwave-isolated-signal-';

// A process that has made its isolated dir and idles, as a tool waiting on a
// model does. `setup` runs between the two.
async function startIsolated(tmp: string, setup = '') {
  const code = [
    `const { isolateStationState } = await import(${JSON.stringify(helper)});`,
    `const { dir } = isolateStationState(${JSON.stringify(SIGNAL_PREFIX)});`,
    setup,
    'console.log(`READY ${dir}`);',
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: controller, env: { ...process.env, STATE_DIR: stationRoot(), TMPDIR: tmp }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
  const dir = await new Promise<string>((resolve, reject) => {
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString();
      const ready = /READY (\S+)/.exec(output);
      if (ready) resolve(ready[1]);
    });
    child.on('exit', () => reject(new Error(output)));
  });
  assert.ok(existsSync(dir));
  return { child, dir, output: () => output };
}

// A signal's default action skips 'exit' listeners, so the helper turns it
// into process.exit() — or, when the tool has a handler of its own (llm-bench
// flushes its report), lets that handler exit instead.
for (const ownHandler of [false, true]) {
  test(`Ctrl-C removes the isolated dir${ownHandler ? ' after the tool\'s own handler' : ''}`, { timeout: 30_000 }, async () => {
    const tmp = createTempDir(join(tmpdir(), 'subwave-isolated-tmp-'));
    const { child, dir, output } = await startIsolated(tmp, ownHandler
      ? 'process.on("SIGINT", () => { console.log("tool handler ran"); process.exit(130); });'
      : '');
    const exited = once(child, 'exit');
    child.kill('SIGINT');
    const [exitCode] = await exited;
    assert.equal(exitCode, 130, output());
    assert.equal(/tool handler ran/.test(output()), ownHandler, output());
    assert.equal(existsSync(dir), false, 'the isolated dir must not outlive a Ctrl-C');
  });
}

// SIGKILL runs nothing, so the dir outlives the run. The name the helper
// minted must be one its own sweep recognises once that pid has gone.
test('a SIGKILLed run\'s dir is left behind, then swept as abandoned', { timeout: 30_000 }, async () => {
  const tmp = createTempDir(join(tmpdir(), 'subwave-isolated-tmp-'));
  const { child, dir } = await startIsolated(tmp);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  assert.ok(existsSync(dir), 'nothing ran to remove it');
  assert.deepEqual(sweepAbandonedDirs(tmp, SIGNAL_PREFIX), [basename(dir)]);
  assert.equal(existsSync(dir), false);
});

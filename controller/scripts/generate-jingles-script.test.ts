// scripts/generate-jingles.sh writes jingles.m3u itself, from the host, so the
// controller's own reload after each write never covers it: the script sends
// `jingles.reload` through the broadcast container (#2008). The renders are
// already on disk by then, so whatever the mixer answers, the script must
// exit 0 and say what happened. Driven against a stand-in `docker` on PATH.
// Run: npm test -- generate-jingles-script

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', '..', 'scripts', 'generate-jingles.sh');

// Logs every call, answers `ps` with a running controller, writes the file
// piper was asked for (container path mapped back to the host state dir), and
// answers the broadcast exec as the mode under test.
const FAKE_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
case " $* " in
  *" ps "*) echo controller ;;
  *" exec -T controller "*)
    cat > /dev/null
    out=""; prev=""
    for a in "$@"; do [ "$prev" = "--output_file" ] && out="$a"; prev="$a"; done
    : > "$STATE_DIR\${out#/var/sub-wave}" ;;
  *" exec -T broadcast "*)
    case "$FAKE_MIXER" in
      ok) printf 'OK\\r\\nEND\\r\\nBye!\\r\\n' ;;
      no-rotate) printf 'ERROR: unknown command, type "help" to get a list of commands.\\r\\nEND\\r\\nBye!\\r\\n' ;;
      *) echo 'service "broadcast" is not running' >&2; exit 1 ;;
    esac ;;
esac
`;

function run(mixer: 'ok' | 'no-rotate' | 'down') {
  const root = createTempDir(join(tmpdir(), 'subwave-gen-jingles-'));
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  const stateDir = join(root, 'state');
  for (const dir of [join(repo, 'scripts'), bin, stateDir]) mkdirSync(dir, { recursive: true });
  copyFileSync(SCRIPT, join(repo, 'scripts', 'generate-jingles.sh'));
  writeFileSync(join(bin, 'docker'), FAKE_DOCKER);
  chmodSync(join(bin, 'docker'), 0o755);
  const log = join(root, 'docker.log');
  writeFileSync(log, '');
  const env: NodeJS.ProcessEnv = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`,
    STATE_DIR: stateDir, FAKE_LOG: log, FAKE_MIXER: mixer,
  };
  delete env.COMPOSE_FILE;
  const res = spawnSync('bash', [join(repo, 'scripts', 'generate-jingles.sh')], { env, encoding: 'utf8' });
  return {
    ...res,
    calls: readFileSync(log, 'utf8').trim().split('\n'),
    playlist: readFileSync(join(stateDir, 'jingles.m3u'), 'utf8'),
  };
}

test('the reload goes to the broadcast container, through the same compose files, after the playlist', () => {
  const { status, stdout, calls, playlist } = run('ok');
  assert.equal(status, 0);
  assert.equal(playlist.trim().split('\n').filter(l => l.startsWith('/var/sub-wave/jingles/')).length, 5);
  const reloads = calls.filter(c => c.includes(' exec -T broadcast '));
  assert.equal(reloads.length, 1);
  assert.ok(reloads[0].startsWith('compose -f docker-compose.yml exec -T broadcast timeout 5 bash -c '), reloads[0]);
  assert.match(reloads[0], /\/dev\/tcp\/127\.0\.0\.1\/1234/);
  assert.match(reloads[0], /jingles\.reload/);
  assert.equal(calls.at(-1), reloads[0], 'the reload is the last thing the script does');
  assert.match(stdout, /✓ Mixer reloaded the playlist/);
});

test('a mixer with no rotate of its own is named, and the run still succeeds', () => {
  const { status, stdout, stderr, playlist } = run('no-rotate');
  assert.equal(status, 0);
  assert.ok(playlist.includes('jingle-04.wav'));
  assert.doesNotMatch(stdout, /Mixer reloaded/);
  assert.match(stderr, /runs no jingle rotate of its own/);
});

test('an unreachable mixer warns, and never aborts a run whose renders are written', () => {
  const { status, stdout, stderr, playlist } = run('down');
  assert.equal(status, 0);
  assert.ok(playlist.includes('jingle-04.wav'));
  assert.doesNotMatch(stdout, /Mixer reloaded/);
  assert.match(stderr, /Could not reach the mixer/);
  assert.match(stderr, /docker compose -f docker-compose\.yml restart broadcast/);
});

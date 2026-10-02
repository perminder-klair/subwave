// HLS is one feature spread across five files that never import each other:
// radio.liq writes it, the two edges serve and log it, docker-compose.yml wires
// the compose edge to the state dir, the entrypoints create the directories,
// and the controller reads it all back. Nothing but this test notices when one
// of them drifts — a renamed rung or a moved log is a silently empty count, not
// an error. Static reads only; no mixer, no edge.
// Run: npm test -- hls-wiring

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const read = (p: string) => readFileSync(join(repo, p), 'utf8');

const liq = read('liquidsoap/radio.liq');
const aioCaddy = read('docker/aio/Caddyfile');
const composeCaddy = read('docker/Caddyfile');
const compose = read('docker-compose.yml');
const entrypoint = read('docker/broadcast-entrypoint.sh');
const supervisor = read('docker/aio/supervisor.sh');
const listenersSrc = read('controller/src/broadcast/hls-listeners.ts');
const debugSrc = read('controller/src/routes/debug.ts');

const RUNGS = ['aac_320', 'aac_256', 'aac_192', 'aac_128'];

// The hls output block, so assertions below can't be satisfied by a comment
// somewhere else in a 2000-line file.
function hlsOutputBlock(): string {
  const start = liq.indexOf('hls_out = output.file.hls(');
  assert.ok(start > 0, 'radio.liq builds output.file.hls');
  return liq.slice(start, liq.indexOf('hls_out.shutdown', start));
}

test('the mixer is opt-in: only an explicit "true" enables HLS', () => {
  assert.match(liq, /^hls_enabled = ref\(false\)$/m);
  assert.match(liq, /hls_enabled := \(raw == "true"\)/);
  assert.match(liq, /liquidsoap_hls_enabled\.txt/);
});

test('the mixer writes under the install root, the directory the edges serve', () => {
  assert.match(liq, /state_root = environment\.get\(default="\/var\/sub-wave", "SUBWAVE_STATE_ROOT"\)/);
  assert.match(liq, /hls_dir = "#\{state_root\}\/hls"/);
  // Both entrypoints must export the root, or a multi-station install writes
  // HLS under the default path while its state lives elsewhere.
  assert.match(entrypoint, /export SUBWAVE_STATE_ROOT="\$STATE_ROOT"/);
  assert.match(supervisor, /export SUBWAVE_STATE_ROOT="\$STATE_ROOT"/);
});

test('whatever the output leaves in the served directory is cleared', () => {
  // The edge serves hls/ as it finds it, so playlists and segments must go when
  // HLS is off at boot and whenever the output is taken down (stream_off).
  assert.match(liq, /def hls_clear\(\) =[\s\S]*?r\/\\\.\(m3u8\|ts\)\$\/\.test\(f\)/, 'hls_clear removes playlists AND segments');
  assert.match(liq, /^if not hls_enabled\(\) then hls_clear\(\) end$/m, 'cleared at boot when off');
  const block = hlsOutputBlock();
  const after = liq.slice(liq.indexOf(block) + block.length, liq.indexOf('# Hourly archive.'));
  assert.match(after, /hls_out\.shutdown\(\)\s*\n\s*hls_clear\(\)/, 'cleared when the output is taken down');
  // The writer flushes its in-flight segment after shutdown returns, so
  // stream_down clears once more a few seconds later, unless back on air.
  const down = liq.slice(liq.indexOf('def stream_down() ='), liq.indexOf('# On air at startup'));
  assert.match(down, /thread\.run\(delay=\d+\., fun \(\) -> if not stream_on\(\) then hls_clear\(\) end\)/, 'late flush cleared, but never on air');
  // It runs from thread.run, where a raise kills the thread for good.
  const clear = liq.slice(liq.indexOf('def hls_clear() ='), liq.indexOf('if not hls_enabled() then hls_clear() end'));
  assert.match(clear, /^  try\n[\s\S]*^  catch err do\n/m, 'hls_clear wraps its whole body');
});

test('the rungs, the master and the segment length agree everywhere', () => {
  const block = hlsOutputBlock();
  assert.match(block, /playlist="live\.m3u8"/);
  for (const rung of RUNGS) {
    assert.ok(block.includes(`("${rung}",`), `${rung} is a rung in the output`);
  }
  const bitrates = RUNGS.map(r => r.slice(4));
  for (const kbps of bitrates) assert.ok(block.includes(`b="${kbps}k"`), `${kbps}k encoder`);
  assert.ok(debugSrc.includes(`[${bitrates.join(', ')}]`), 'debug states the same ladder');

  // Segment length → the controller's listener window.
  const seg = /segment_duration=(\d+)\./.exec(block)?.[1];
  const controllerSeg = /HLS_SEGMENT_SECONDS = (\d+);/.exec(listenersSrc)?.[1];
  assert.equal(seg, controllerSeg, 'hls-listeners.ts sizes its window off radio.liq\'s segment length');
  // The controller skips the master when counting (it is fetched once).
  assert.match(listenersSrc, /const MASTER_PLAYLIST = 'live';/);
});

test('both edges route /hls, type the playlists, and log only playlist polls', () => {
  for (const [name, cf] of [['aio', aioCaddy], ['compose', composeCaddy]] as const) {
    assert.match(cf, /handle \/hls\/\* \{/, `${name}: /hls/* is served`);
    assert.match(cf, /@hls_playlist path \*\.m3u8/, `${name}: playlists are matched by extension`);
    assert.match(cf, /header @hls_playlist Content-Type application\/vnd\.apple\.mpegurl/, `${name}: Apple's playlist type`);
    assert.match(cf, /header @hls_segment Content-Type video\/mp2t/, `${name}: segment type`);
    assert.match(cf, /log_name @hls_playlist hls_access/, `${name}: playlist polls go to their own log`);
    assert.doesNotMatch(cf, /log_name @hls_segment/, `${name}: segments are never logged`);
    assert.match(cf, /log hls_access \{[\s\S]*?format json[\s\S]*?no_hostname/, `${name}: JSON, playlist polls only`);
    assert.match(cf, /roll_uncompressed/, `${name}: the reader walks rolled files, so no gzip`);
    // The audio mounts keep their own compression exclusion; /hls joins it.
    assert.match(cf, /@compressible not path [^\n]*\/hls\/\*/, `${name}: no gzip on HLS`);
  }
});

test('each edge writes the log where the controller reads it', () => {
  // Controller: <state root>/edge/hls-access.log.
  assert.match(listenersSrc, /const LOG_DIR = join\(config\.stateRoot, 'edge'\);/);
  assert.match(listenersSrc, /const LOG_PATH = join\(LOG_DIR, 'hls-access\.log'\);/);
  assert.match(listenersSrc, /const HLS_DIR = join\(config\.stateRoot, 'hls'\);/);

  // AIO: same filesystem as the controller, under the (overridable) root.
  assert.match(aioCaddy, /output file \{\$SUBWAVE_STATE_ROOT:\/var\/sub-wave\}\/edge\/hls-access\.log/);
  assert.match(aioCaddy, /root \* \{\$SUBWAVE_STATE_ROOT:\/var\/sub-wave\}\n/);

  // Compose: the edge container sees those two state dirs through bind mounts,
  // at the paths its Caddyfile names.
  assert.match(compose, /- \$\{STATE_DIR:-\.\/state\}\/hls:\/srv\/hls:ro/);
  assert.match(compose, /- \$\{STATE_DIR:-\.\/state\}\/edge:\/var\/log\/subwave-edge/);
  assert.match(composeCaddy, /root \* \/srv\n/);
  assert.match(composeCaddy, /output file \/var\/log\/subwave-edge\/hls-access\.log/);
});

test('both entrypoints create the install-level directories writable', () => {
  for (const [name, sh] of [['broadcast-entrypoint.sh', entrypoint], ['aio/supervisor.sh', supervisor]] as const) {
    assert.match(sh, /state_prepare_dir "\$root\/hls"/, `${name} prepares hls/`);
    assert.match(sh, /state_prepare_dir "\$root\/edge"/, `${name} prepares edge/`);
  }
});

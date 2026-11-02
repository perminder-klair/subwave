// The controller-written stream buffer depth is the single source of truth
// for both Icecast renderers. An environment override would silently outrank
// the saved setting, and a controller older than stream-mounts.json (#2142)
// would keep advertising that setting, so listeners would hear one offset
// while every consumer is told another.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const docker = join(here, '..', '..', 'docker');

const RENDERERS = [
  {
    name: 'broadcast entrypoint',
    path: join(docker, 'broadcast-entrypoint.sh'),
    lib: 'SUBWAVE_BROADCAST_LIB',
  },
  {
    name: 'AIO supervisor',
    path: join(docker, 'aio', 'supervisor.sh'),
    lib: 'SUBWAVE_SUPERVISOR_LIB',
  },
] as const;

function resolvedBufferSeconds(
  script: string,
  lib: string,
  stateDir: string,
  envOverride: string,
): string {
  const cmd = [
    'set -eu',
    'STATE_DIR="$1"',
    `${lib}=1 source "$2"`,
    'stream_buffer_seconds',
  ].join('; ');
  return execFileSync('bash', ['-c', cmd, 'bash', stateDir, script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ICECAST_BUFFER_SECONDS: envOverride,
      SUBWAVE_STATE_ROOT: stateDir,
    },
  }).trim();
}

for (const renderer of RENDERERS) {
  test(`${renderer.name} uses controller state even when ICECAST_BUFFER_SECONDS is set`, () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'subwave-stream-buffer-renderer-'));
    try {
      writeFileSync(join(stateDir, 'liquidsoap_stream_buffer_seconds.txt'), '17');

      assert.equal(
        resolvedBufferSeconds(renderer.path, renderer.lib, stateDir, '9'),
        '17',
      );
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
}

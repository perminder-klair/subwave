// The conformance kit against every plugin that can run here:
//   - mock (built-in, offline),
//   - the minimal third-party fixture,
//   - navidrome, against a second router serving the mock over Subsonic —
//     a real Subsonic server, so the plugin's client code runs for real,
//   - jellyfin / plex / navidrome against live servers, only when their
//     environment is set (CONFORMANCE_JELLYFIN_URL etc.; see README).

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runConformance, type Report } from './conformance.js';
import { PASS, USER, configWith, makeMusicFolder, startRouter, type RunningRouter } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCES = resolve(here, '../src/sources');

function assertPasses(report: Report): void {
  const failed = report.checks.filter((c) => c.outcome === 'fail');
  assert.equal(failed.length, 0, failed.map((c) => `${c.name}: ${c.detail}`).join('\n'));
  assert.ok(report.ok);
}

let upstream: RunningRouter;

before(async () => {
  upstream = await startRouter();
  upstream.writeConfig(configWith([{ plugin: 'mock' }]));
  await upstream.internal('/reload', { method: 'POST' });
});

after(async () => {
  await upstream.close();
});

test('mock passes, writes included', async () => {
  const report = await runConformance(resolve(SOURCES, 'mock'), { builtin: true, allowWrites: true });
  assertPasses(report);
  assert.ok(report.checks.every((c) => c.outcome !== 'skip'), 'the mock implements every optional op');
});

test('the minimal fixture passes with only the required ops', async () => {
  const report = await runConformance(resolve(here, 'fixtures/plugins/good'), { config: { greeting: 'hi' } });
  assertPasses(report);
  assert.ok(report.checks.some((c) => c.outcome === 'skip'), 'optional ops are reported as skipped');
});

test('the documented example plugin (a music folder) passes, as a third-party plugin', async () => {
  const music = makeMusicFolder();
  try {
    const report = await runConformance(resolve(here, '../../docs/examples/sources/folder'), { config: { path: music } });
    assertPasses(report);
    assert.equal(report.checks.find((c) => c.name.startsWith('stream honours Range'))?.outcome, 'pass');
  } finally {
    rmSync(music, { recursive: true, force: true });
  }
});

test('a plugin with missing config fails to load, with the reason', async () => {
  const report = await runConformance(resolve(here, 'fixtures/plugins/good'));
  assert.equal(report.ok, false);
  assert.match(report.checks[0]!.detail ?? '', /missing required config: greeting/);
});

test('navidrome passes against a live Subsonic server, writes included', async () => {
  const report = await runConformance(resolve(SOURCES, 'navidrome'), {
    builtin: true,
    allowWrites: true,
    config: { url: upstream.base, user: USER, password: PASS },
  });
  assertPasses(report);
});

test('navidrome with a wrong password is unhealthy, not empty', async () => {
  const report = await runConformance(resolve(SOURCES, 'navidrome'), {
    builtin: true,
    config: { url: upstream.base, user: USER, password: 'wrong-wrong-wrong-wrong' },
  });
  assert.equal(report.ok, false);
  assert.match(report.checks.find((c) => c.name.startsWith('health'))?.detail ?? '', /Wrong username or password/);
});

// Live backends: opt-in through the environment.
const LIVE: Record<string, { env: string[]; config: (e: NodeJS.ProcessEnv) => Record<string, string> }> = {
  jellyfin: {
    env: ['CONFORMANCE_JELLYFIN_URL', 'CONFORMANCE_JELLYFIN_API_KEY'],
    config: (e) => ({ url: e.CONFORMANCE_JELLYFIN_URL!, apiKey: e.CONFORMANCE_JELLYFIN_API_KEY!, ...(e.CONFORMANCE_JELLYFIN_USER ? { user: e.CONFORMANCE_JELLYFIN_USER } : {}) }),
  },
  plex: {
    env: ['CONFORMANCE_PLEX_URL', 'CONFORMANCE_PLEX_TOKEN'],
    config: (e) => ({ url: e.CONFORMANCE_PLEX_URL!, token: e.CONFORMANCE_PLEX_TOKEN!, ...(e.CONFORMANCE_PLEX_SECTION ? { section: e.CONFORMANCE_PLEX_SECTION } : {}) }),
  },
  navidrome: {
    env: ['CONFORMANCE_NAVIDROME_URL', 'CONFORMANCE_NAVIDROME_USER', 'CONFORMANCE_NAVIDROME_PASS'],
    config: (e) => ({ url: e.CONFORMANCE_NAVIDROME_URL!, user: e.CONFORMANCE_NAVIDROME_USER!, password: e.CONFORMANCE_NAVIDROME_PASS! }),
  },
};

for (const [name, live] of Object.entries(LIVE)) {
  const missing = live.env.filter((k) => !process.env[k]);
  test(`${name} passes against a live server`, { skip: missing.length ? `set ${missing.join(', ')}` : false }, async () => {
    const report = await runConformance(resolve(SOURCES, name), { builtin: true, config: live.config(process.env) });
    for (const c of report.checks) if (c.outcome !== 'pass') console.log(`  [${name}] ${c.outcome}: ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    assertPasses(report);
  });
}

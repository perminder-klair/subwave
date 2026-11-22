// The router is the default path (#692), so a router outage must not silence a
// station its Navidrome could keep playing: music/source-failover.ts plays the
// station's Navidrome directly until the router answers again — only when
// that is the same library (the station's Navidrome alone, raw ids).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const stateRoot = mkdtempSync(join(tmpdir(), 'subwave-failover-'));
process.env.STATE_DIR = stateRoot;
process.env.MUSIC_ROUTER_URL = 'http://router.test:4534';
delete process.env.NAVIDROME_URL;
delete process.env.NAVIDROME_USER;
delete process.env.NAVIDROME_PASS;

const { config } = await import('../src/config.js');
const setupConfig = await import('../src/setup/config.js');
const ms = await import('../src/setup/music-source.js');
const fo = await import('../src/music/source-failover.js');

after(() => rmSync(stateRoot, { recursive: true, force: true }));

test('the decision: two failed checks and a live Navidrome to fall over; two good ones to come back', () => {
  const step = (o: Partial<Parameters<typeof fo.nextFailoverStep>[0]>) =>
    fo.nextFailoverStep({ eligible: true, active: false, downStreak: 0, upStreak: 0, directOk: true, ...o });
  assert.equal(step({ downStreak: 1 }), 'hold', 'one miss is a router still starting');
  assert.equal(step({ downStreak: 2 }), 'activate');
  assert.equal(step({ downStreak: 2, directOk: false }), 'hold', 'nothing better to fall over to');
  assert.equal(step({ downStreak: 5, eligible: false }), 'hold', 'not the same library — nothing to stand in');
  assert.equal(step({ active: true, upStreak: 1 }), 'hold', 'one good check could be a flap');
  assert.equal(step({ active: true, upStreak: 2 }), 'restore');
  assert.equal(step({ active: true, eligible: false }), 'restore', 'a new selection applies its own connection');
});

const nav = { url: 'http://nd.test:4533', user: 'u', pass: 'p' };

async function station(music?: unknown) {
  await setupConfig.saveSetupConfig({ navidrome: nav, ...(music ? { music } : {}) });
  if (!music) {
    const sc = await setupConfig.loadSetupConfig();
    delete sc.music;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(stateRoot, 'setup-config.json'), JSON.stringify(sc));
  }
  await setupConfig.syncRouterConfig();
  await setupConfig.loadNavidromeConfig();
  fo.resetFailover();
}

function deps(router: () => boolean, direct = true) {
  let switches = 0;
  return {
    deps: {
      probeRouter: async () => (router() ? { ok: true } : { ok: false, reason: 'ECONNREFUSED' }),
      probeDirect: async () => direct,
      afterSwitch: () => {
        switches++;
      },
    },
    switches: () => switches,
  };
}

test('the default station falls over to its Navidrome and back, with the same ids', async () => {
  await station();
  const routerUrl = config.navidrome.url;
  assert.equal(routerUrl, 'http://router.test:4534');
  let up = false;
  const d = deps(() => up);

  assert.equal(await fo.failoverTick(d.deps), 'hold');
  assert.equal(config.navidrome.url, routerUrl, 'one failed check changes nothing');
  assert.equal(await fo.failoverTick(d.deps), 'activate');
  const { url, user, password } = config.navidrome;
  assert.deepEqual({ url, user, password }, { url: nav.url, user: nav.user, password: nav.pass });
  assert.equal(fo.failoverState().active, true);
  assert.equal(fo.failoverState().reason, 'ECONNREFUSED');
  assert.equal(d.switches(), 1, 'caches and auto.m3u are rebuilt for the new connection');

  up = true;
  assert.equal(await fo.failoverTick(d.deps), 'hold');
  assert.equal(await fo.failoverTick(d.deps), 'restore');
  assert.equal(config.navidrome.url, routerUrl);
  assert.equal(config.navidrome.user, ms.readRouterAuth()!.user);
  assert.equal(fo.failoverState().active, false);
  assert.equal(d.switches(), 2);
});

test('a dead Navidrome too: nothing to fall over to, so it stays on the router', async () => {
  await station();
  const d = deps(() => false, false);
  for (let i = 0; i < 4; i++) assert.equal(await fo.failoverTick(d.deps), 'hold');
  assert.equal(config.navidrome.url, 'http://router.test:4534');
  assert.equal(d.switches(), 0);
});

test('another source has no stand-in: the monitor does not even probe', async () => {
  await station({ mode: 'router', merge: false, sources: [{ plugin: 'jellyfin', config: { url: 'http://jf' } }] });
  let probes = 0;
  const d = deps(() => {
    probes++;
    return false;
  });
  for (let i = 0; i < 3; i++) assert.equal(await fo.failoverTick(d.deps), 'hold');
  assert.equal(probes, 0);
  assert.equal(fo.failoverState().eligible, false);
});

test('a selection changed while failed over takes its own connection', async () => {
  await station();
  const d = deps(() => false);
  await fo.failoverTick(d.deps);
  assert.equal(await fo.failoverTick(d.deps), 'activate');
  // The operator moved to another source by hand-editing, then the process
  // reloaded the selection without a save resetting the monitor.
  await setupConfig.saveSetupConfig({ music: { mode: 'router', merge: false, sources: [{ plugin: 'jellyfin', config: {} }] } });
  await setupConfig.loadNavidromeConfig();
  config.navidrome.url = nav.url; // still pointing at the stand-in
  assert.equal(await fo.failoverTick(d.deps), 'restore');
  assert.equal(config.navidrome.url, 'http://router.test:4534');
});

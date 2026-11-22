// Music-source selection (#692): the saved shape, what a save refuses, secrets
// never reaching the browser, the router's config.json, and the first-run gate.
//
// The load-bearing default: no `music` block means direct Navidrome, so an
// upgraded install behaves exactly as before.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const stateRoot = mkdtempSync(join(tmpdir(), 'subwave-music-source-'));
process.env.STATE_DIR = stateRoot;
delete process.env.NAVIDROME_URL;
delete process.env.NAVIDROME_USER;
delete process.env.NAVIDROME_PASS;
process.env.MUSIC_ROUTER_URL = 'http://router.test:4534';

const schema = await import('../src/schemas/music-source.js');
const ms = await import('../src/setup/music-source.js');
const setupConfig = await import('../src/setup/config.js');
const firstRun = await import('../src/setup/firstRun.js');
const { config } = await import('../src/config.js');

after(() => rmSync(stateRoot, { recursive: true, force: true }));

const NO_NAV = { url: '', user: '', password: '' };

const jellyfin = {
  name: 'jellyfin',
  label: 'Jellyfin',
  description: '',
  version: '1.0.0',
  apiVersion: 1,
  idPrefix: 'jf',
  builtin: true,
  homepage: null,
  envLocked: [] as string[],
  error: null,
  capabilities: null,
  devOnly: false,
  config: [
    { key: 'url', label: 'Server URL', type: 'url' as const, required: true },
    { key: 'apiKey', label: 'API key', type: 'secret' as const, required: true },
    { key: 'user', label: 'User', type: 'string' as const },
  ],
};

test('an absent or damaged selection is the router serving the station\'s own Navidrome', () => {
  const dflt = { mode: 'router', merge: false, sources: [{ plugin: 'navidrome', config: {}, rawIds: true }] };
  assert.deepEqual(ms.readSelection({}), dflt);
  assert.deepEqual(ms.readSelection(null), dflt);
  assert.deepEqual(ms.readSelection({ music: { mode: 'spotify' } }), dflt);
  assert.deepEqual(ms.readSelection({ music: 'garbage' }), dflt);
  assert.deepEqual(ms.readSelection({ music: { mode: 'router', sources: [] } }), dflt, 'a router selection with nothing in it');
  const sel = ms.readSelection({ music: { mode: 'router', sources: [{ plugin: 'jellyfin', config: { url: 'http://jf' } }] } });
  assert.equal(sel.mode, 'router');
  assert.equal(sel.sources[0]!.plugin, 'jellyfin');
  // Direct mode is still a choice.
  assert.equal(ms.readSelection({ music: { mode: 'navidrome' } }).mode, 'navidrome');
  // The navidrome source plays the station connection; settings an older save stored are ignored.
  const old = ms.readSelection({ music: { mode: 'router', sources: [{ plugin: 'navidrome', config: { url: 'http://elsewhere', password: 'x' }, rawIds: true }] } });
  assert.deepEqual(old.sources[0]!.config, {});
});

test('the station\'s Navidrome behind the router is the same library as a direct connection', () => {
  const identity = schema.musicSelectionIdentity;
  const behind = ms.readSelection({});
  assert.equal(identity(behind), 'navidrome', 'the default publishes the ids a direct connection did');
  assert.equal(identity({ mode: 'navidrome', sources: [] }), 'navidrome');
  assert.notEqual(identity({ mode: 'router', sources: [{ plugin: 'navidrome', config: {}, rawIds: false }] }), 'navidrome', 'namespaced ids are a different library');
  assert.notEqual(identity({ mode: 'router', merge: true, sources: [...behind.sources, { plugin: 'jellyfin', config: { url: 'http://jf' } }] }), 'navidrome');
  assert.deepEqual(
    ms.stationSources(behind.sources, { url: 'http://nd', user: 'u', password: 'p' }),
    [{ plugin: 'navidrome', rawIds: true, config: { url: 'http://nd', user: 'u', password: 'p' } }],
    'the router is handed the station connection',
  );
});

test('a save refuses selections that cannot play', () => {
  const bad = (body: unknown) => schema.musicSelectionPatchSchema.safeParse(body).success === false;
  assert.ok(bad({ mode: 'router', sources: [] }), 'router mode needs a source');
  assert.ok(bad({ mode: 'router', sources: [{ plugin: 'a1' }, { plugin: 'b1' }] }), 'two sources need merge');
  assert.ok(bad({ mode: 'router', merge: true, sources: [{ plugin: 'a1' }, { plugin: 'a1' }] }), 'no duplicates');
  assert.ok(bad({ mode: 'router', merge: true, sources: [{ plugin: 'a1', rawIds: true }, { plugin: 'b1', rawIds: true }] }), 'one raw-id source');
  assert.ok(bad({ mode: 'router', sources: [{ plugin: 'BAD NAME' }] }));
  assert.ok(!bad({ mode: 'navidrome' }));
  assert.ok(!bad({ mode: 'router', merge: true, sources: [{ plugin: 'mock' }, { plugin: 'jellyfin', config: { url: 'x' } }] }));
});

test('required fields are checked against the manifest, honouring env locks and kept secrets', () => {
  const entry = { plugin: 'jellyfin', config: { url: 'http://jf' } };
  assert.deepEqual(schema.missingMusicFields(entry, jellyfin), ['apiKey']);
  assert.deepEqual(schema.missingMusicFields(entry, jellyfin, ['apiKey']), []);
  assert.deepEqual(schema.missingMusicFields({ plugin: 'jellyfin', config: {} }, { ...jellyfin, envLocked: ['url', 'apiKey'] }), []);
  assert.deepEqual(schema.missingMusicFields({ plugin: 'jellyfin', config: { url: '  ', apiKey: 'k' } }, jellyfin), ['url']);
});

test('secrets never leave the process, and a blank secret keeps the stored one', () => {
  const saved = { mode: 'router' as const, merge: false, sources: [{ plugin: 'jellyfin', config: { url: 'http://jf', apiKey: 'SECRET', user: 'me' } }] };
  const masked = ms.maskSelection(saved, [jellyfin]);
  assert.deepEqual(masked.sources[0]!.config, { url: 'http://jf', user: 'me' });
  assert.deepEqual(masked.sources[0]!.secretsSet, ['apiKey']);
  assert.ok(!JSON.stringify(masked).includes('SECRET'));
  // A plugin whose manifest is unknown shows nothing at all — nor one whose
  // manifest failed to load, which is listed with no config fields.
  assert.deepEqual(ms.maskSelection(saved, []).sources[0]!.config, {});
  const broken = { ...jellyfin, config: [], error: 'invalid subwave-source.json' };
  assert.deepEqual(ms.maskSelection(saved, [broken]).sources[0]!.config, {});
  assert.ok(!JSON.stringify(ms.maskSelection(saved, [broken])).includes('SECRET'));

  const draft = [{ plugin: 'jellyfin', config: { url: 'http://jf', apiKey: '', user: 'someone-else' } }];
  const kept = ms.keepStoredSecrets(draft, saved.sources, [jellyfin]);
  assert.equal(kept[0]!.config.apiKey, 'SECRET', 'same server, so the stored key is kept');
  assert.equal(kept[0]!.config.user, 'someone-else');
  assert.deepEqual(ms.keptSecretKeys(draft[0]!, saved.sources, jellyfin), ['apiKey']);
  const replaced = ms.keepStoredSecrets([{ plugin: 'jellyfin', config: { url: 'http://jf', apiKey: 'NEW' } }], saved.sources, [jellyfin]);
  assert.equal(replaced[0]!.config.apiKey, 'NEW');
});

// #1827 review: a blank secret used to fall back to the stored one whatever the
// draft pointed at, so Test (or Save) sent the stored key to any host typed in.
test('a stored secret is not sent to a server it was not stored for', () => {
  const saved = [{ plugin: 'jellyfin', config: { url: 'http://jf', apiKey: 'SECRET' } }];
  const moved = { plugin: 'jellyfin', config: { url: 'http://attacker.example', apiKey: '' } };
  assert.equal(ms.keepStoredSecrets([moved], saved, [jellyfin])[0]!.config.apiKey, '');
  assert.deepEqual(ms.keptSecretKeys(moved, saved, jellyfin), [], 'so a save asks for the key again');
  assert.deepEqual(schema.missingMusicFields(moved, jellyfin, ms.keptSecretKeys(moved, saved, jellyfin)), ['apiKey']);
  // Whitespace is not a different server.
  const padded = { plugin: 'jellyfin', config: { url: ' http://jf ', apiKey: '' } };
  assert.equal(ms.keepStoredSecrets([padded], saved, [jellyfin])[0]!.config.apiKey, 'SECRET');
});

test('selection identity: a new password is the same library, a new server is not', () => {
  const a = { mode: 'router' as const, merge: false, sources: [{ plugin: 'jellyfin', config: { url: 'http://jf', apiKey: 'one' } }] };
  const samePlace = { ...a, sources: [{ plugin: 'jellyfin', config: { url: 'http://jf', apiKey: 'two' } }] };
  const elsewhere = { ...a, sources: [{ plugin: 'jellyfin', config: { url: 'http://other', apiKey: 'one' } }] };
  assert.equal(ms.selectionIdentity(a, [jellyfin]), ms.selectionIdentity(samePlace, [jellyfin]));
  assert.notEqual(ms.selectionIdentity(a, [jellyfin]), ms.selectionIdentity(elsewhere, [jellyfin]));
  assert.equal(ms.selectionIdentity({ mode: 'navidrome', merge: false, sources: a.sources }), 'navidrome');
});

// #1827 review: every non-secret field counted, so flipping a display toggle
// wrote a switch marker and started a full re-link walk. A manifest now marks
// the fields that change ids; one that marks none keeps the old reading.
test('selection identity follows the manifest\'s affectsIds marks', () => {
  const plex = {
    ...jellyfin,
    name: 'plex',
    config: [
      { key: 'url', label: 'URL', type: 'url' as const, affectsIds: true },
      { key: 'token', label: 'Token', type: 'secret' as const },
      { key: 'section', label: 'Section', type: 'string' as const, affectsIds: true },
      { key: 'sonicSimilarity', label: 'Sonic', type: 'boolean' as const, affectsIds: false },
    ],
  };
  const sel = (config: Record<string, string | boolean>) => ({ mode: 'router' as const, merge: false, sources: [{ plugin: 'plex', config }] });
  const base = ms.selectionIdentity(sel({ url: 'http://px', token: 't', section: '1', sonicSimilarity: true }), [plex]);
  assert.equal(ms.selectionIdentity(sel({ url: 'http://px', token: 't', section: '1', sonicSimilarity: false }), [plex]), base, 'a toggle is not a switch');
  assert.notEqual(ms.selectionIdentity(sel({ url: 'http://px', token: 't', section: '2', sonicSimilarity: true }), [plex]), base, 'another library section is');
  assert.notEqual(ms.selectionIdentity(sel({ url: 'http://px2', token: 't', section: '1', sonicSimilarity: true }), [plex]), base);
  assert.equal(ms.selectionIdentity(sel({ url: 'http://px', token: 't', section: '1', sonicSimilarity: true, extra: 'x' }), [plex]), base, 'an unmarked key does not count once any field is marked');
  // Unmarked manifest (jellyfin above): every non-secret field still counts.
  const jf = (user: string) => ({ mode: 'router' as const, merge: false, sources: [{ plugin: 'jellyfin', config: { url: 'http://jf', user } }] });
  assert.notEqual(ms.selectionIdentity(jf('a'), [jellyfin]), ms.selectionIdentity(jf('b'), [jellyfin]));
  // A blank value is an absent one.
  assert.equal(ms.selectionIdentity(sel({ url: 'http://px', section: '' }), [plex]), ms.selectionIdentity(sel({ url: 'http://px' }), [plex]));
});

test('the built-in manifests mark which settings change ids', async () => {
  const { readFileSync: read } = await import('node:fs');
  const marks = (name: string) => Object.fromEntries(
    JSON.parse(read(new URL(`../../router/src/sources/${name}/subwave-source.json`, import.meta.url), 'utf8')).config
      .filter((f: any) => f.type !== 'secret').map((f: any) => [f.key, f.affectsIds]),
  );
  assert.deepEqual(marks('jellyfin'), { url: true, user: false });
  assert.deepEqual(marks('navidrome'), { url: true, user: false });
  assert.deepEqual(marks('plex'), { url: true, section: true, sonicSimilarity: false });
  assert.deepEqual(marks('mock'), { songMinSec: false, songMaxSec: false, sonicSimilarity: false });
});

test('router config.json: generated credentials, 0600, kept across writes, idle in navidrome mode', async () => {
  assert.equal(ms.readRouterAuth(), null);
  const auth = await ms.writeRouterConfig({ mode: 'navidrome', merge: false, sources: [{ plugin: 'mock', config: {} }] }, NO_NAV);
  assert.equal(auth.user, 'subwave');
  assert.ok(auth.pass.length >= 32);
  const file = join(stateRoot, 'router', 'config.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const written = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(written.sources, [], 'navidrome mode leaves the router idle');
  assert.ok(existsSync(join(stateRoot, 'router', 'plugins')), 'the plugin drop folder exists');
  const again = await ms.writeRouterConfig({ mode: 'router', merge: false, sources: [{ plugin: 'mock', config: {} }] }, NO_NAV);
  assert.deepEqual(again, auth, 'credentials are stable');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).sources, [{ plugin: 'mock', config: {} }]);
  const stamp = statSync(file).mtimeMs;
  await new Promise((ok) => setTimeout(ok, 20));
  await ms.writeRouterConfig({ mode: 'router', merge: false, sources: [{ plugin: 'mock', config: {} }] }, NO_NAV);
  assert.equal(statSync(file).mtimeMs, stamp, 'an unchanged selection does not touch the file the router polls');
});

test('the live connection and the first-run gate follow the mode', async () => {
  // Fresh station: the default plays its Navidrome through the router, so it
  // needs that Navidrome connection before it is set up.
  assert.equal((await firstRun.getSetupStatus()).needsSetup, true);

  await setupConfig.saveSetupConfig({ navidrome: { url: 'http://nd:4533', user: 'u', pass: 'p' } });
  await setupConfig.syncRouterConfig();
  await setupConfig.loadNavidromeConfig();
  // Behind the router: the live connection is the router, with its own
  // credentials, and the router is handed the station's Navidrome.
  const auth = ms.readRouterAuth()!;
  assert.equal(config.navidrome.url, 'http://router.test:4534');
  assert.equal(config.navidrome.user, auth.user);
  assert.equal(config.navidrome.password, auth.pass);
  const routed = JSON.parse(readFileSync(join(stateRoot, 'router', 'config.json'), 'utf8'));
  assert.deepEqual(routed.sources, [{ plugin: 'navidrome', config: { url: 'http://nd:4533', user: 'u', password: 'p' }, rawIds: true }]);
  let status = await firstRun.getSetupStatus();
  assert.equal(status.needsSetup, false);
  assert.equal(status.musicMode, 'router');
  assert.equal(status.navidromeSource, 'setup-config');
  assert.equal(firstRun.getSetupStatusSync().needsSetup, false);

  // Another source: set up without Navidrome, which stays on file.
  await setupConfig.saveSetupConfig({ music: { mode: 'router', merge: false, sources: [{ plugin: 'mock', config: {} }] } });
  await setupConfig.loadNavidromeConfig();
  assert.equal(config.navidrome.url, 'http://router.test:4534');
  assert.equal((await firstRun.getSetupStatus()).needsSetup, false);
  assert.equal((await setupConfig.loadSetupConfig()).navidrome?.url, 'http://nd:4533');

  // Direct mode: the stored connection is live.
  await setupConfig.saveSetupConfig({ music: { mode: 'navidrome', merge: false, sources: [] } });
  await setupConfig.loadNavidromeConfig();
  assert.equal(config.navidrome.url, 'http://nd:4533');
  status = await firstRun.getSetupStatus();
  assert.equal(status.needsSetup, false);
  assert.equal(status.musicMode, 'navidrome');
});

test('a source switch leaves a marker the next walk reads', async () => {
  const { pendingSourceSwitch, clearSourceSwitch } = await import('../src/music/source-switch.js');
  assert.equal(pendingSourceSwitch(), null);
  await ms.markSourceSwitch('navidrome', '[{"plugin":"jellyfin"}]');
  assert.equal(pendingSourceSwitch()?.from, 'navidrome');
  clearSourceSwitch();
  assert.equal(pendingSourceSwitch(), null);
  writeFileSync(join(stateRoot, 'music-source-switch.json'), 'not json');
  assert.equal(pendingSourceSwitch(), null, 'a damaged marker is ignored, not fatal');
});

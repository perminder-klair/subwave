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
  config: [
    { key: 'url', label: 'Server URL', type: 'url' as const, required: true },
    { key: 'apiKey', label: 'API key', type: 'secret' as const, required: true },
    { key: 'user', label: 'User', type: 'string' as const },
  ],
};

test('an absent or damaged selection is direct Navidrome', () => {
  assert.deepEqual(ms.readSelection({}), { mode: 'navidrome', merge: false, sources: [] });
  assert.deepEqual(ms.readSelection(null), { mode: 'navidrome', merge: false, sources: [] });
  assert.equal(ms.readSelection({ music: { mode: 'spotify' } }).mode, 'navidrome');
  assert.equal(ms.readSelection({ music: 'garbage' }).mode, 'navidrome');
  const sel = ms.readSelection({ music: { mode: 'router', sources: [{ plugin: 'jellyfin', config: { url: 'http://jf' } }] } });
  assert.equal(sel.mode, 'router');
  assert.equal(sel.sources[0]!.plugin, 'jellyfin');
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
  // A plugin whose manifest is unknown shows nothing at all.
  assert.deepEqual(ms.maskSelection(saved, []).sources[0]!.config, {});

  const draft = [{ plugin: 'jellyfin', config: { url: 'http://jf2', apiKey: '' } }];
  const kept = ms.keepStoredSecrets(draft, saved.sources, [jellyfin]);
  assert.equal(kept[0]!.config.apiKey, 'SECRET');
  assert.equal(kept[0]!.config.url, 'http://jf2');
  assert.deepEqual(ms.keptSecretKeys(draft[0]!, saved.sources, jellyfin), ['apiKey']);
  const replaced = ms.keepStoredSecrets([{ plugin: 'jellyfin', config: { apiKey: 'NEW' } }], saved.sources, [jellyfin]);
  assert.equal(replaced[0]!.config.apiKey, 'NEW');
});

test('selection identity: a new password is the same library, a new server is not', () => {
  const a = { mode: 'router' as const, merge: false, sources: [{ plugin: 'jellyfin', config: { url: 'http://jf', apiKey: 'one' } }] };
  const samePlace = { ...a, sources: [{ plugin: 'jellyfin', config: { url: 'http://jf', apiKey: 'two' } }] };
  const elsewhere = { ...a, sources: [{ plugin: 'jellyfin', config: { url: 'http://other', apiKey: 'one' } }] };
  assert.equal(ms.selectionIdentity(a, [jellyfin]), ms.selectionIdentity(samePlace, [jellyfin]));
  assert.notEqual(ms.selectionIdentity(a, [jellyfin]), ms.selectionIdentity(elsewhere, [jellyfin]));
  assert.equal(ms.selectionIdentity({ mode: 'navidrome', merge: false, sources: a.sources }), 'navidrome');
});

test('router config.json: generated credentials, 0600, kept across writes, idle in navidrome mode', async () => {
  assert.equal(ms.readRouterAuth(), null);
  const auth = await ms.writeRouterConfig({ mode: 'navidrome', merge: false, sources: [{ plugin: 'mock', config: {} }] });
  assert.equal(auth.user, 'subwave');
  assert.ok(auth.pass.length >= 32);
  const file = join(stateRoot, 'router', 'config.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const written = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(written.sources, [], 'navidrome mode leaves the router idle');
  assert.ok(existsSync(join(stateRoot, 'router', 'plugins')), 'the plugin drop folder exists');
  const again = await ms.writeRouterConfig({ mode: 'router', merge: false, sources: [{ plugin: 'mock', config: {} }] });
  assert.deepEqual(again, auth, 'credentials are stable');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).sources, [{ plugin: 'mock', config: {} }]);
  const stamp = statSync(file).mtimeMs;
  await new Promise((ok) => setTimeout(ok, 20));
  await ms.writeRouterConfig({ mode: 'router', merge: false, sources: [{ plugin: 'mock', config: {} }] });
  assert.equal(statSync(file).mtimeMs, stamp, 'an unchanged selection does not touch the file the router polls');
});

test('the live connection and the first-run gate follow the mode', async () => {
  // Fresh station, no music at all.
  assert.equal((await firstRun.getSetupStatus()).needsSetup, true);

  // Direct Navidrome, complete.
  await setupConfig.saveSetupConfig({ navidrome: { url: 'http://nd:4533', user: 'u', pass: 'p' } });
  await setupConfig.loadNavidromeConfig();
  assert.equal(config.navidrome.url, 'http://nd:4533');
  let status = await firstRun.getSetupStatus();
  assert.equal(status.needsSetup, false);
  assert.equal(status.musicMode, 'navidrome');

  // Router mode: the connection points at the router with its own credentials,
  // and the Navidrome block stays on file.
  await setupConfig.saveSetupConfig({ music: { mode: 'router', merge: false, sources: [{ plugin: 'mock', config: {} }] } });
  await setupConfig.loadNavidromeConfig();
  const auth = ms.readRouterAuth()!;
  assert.equal(config.navidrome.url, 'http://router.test:4534');
  assert.equal(config.navidrome.user, auth.user);
  assert.equal(config.navidrome.password, auth.pass);
  status = await firstRun.getSetupStatus();
  assert.equal(status.needsSetup, false);
  assert.equal(status.musicMode, 'router');
  assert.equal(firstRun.getSetupStatusSync().needsSetup, false);
  assert.equal((await setupConfig.loadSetupConfig()).navidrome?.url, 'http://nd:4533');

  // Router mode with no source is not set up, whatever Navidrome says.
  await setupConfig.saveSetupConfig({ music: { mode: 'router', merge: false, sources: [] } });
  assert.equal((await firstRun.getSetupStatus()).needsSetup, true);

  // Back to Navidrome: the stored connection is live again.
  await setupConfig.saveSetupConfig({ music: { mode: 'navidrome', merge: false, sources: [] } });
  await setupConfig.loadNavidromeConfig();
  assert.equal(config.navidrome.url, 'http://nd:4533');
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

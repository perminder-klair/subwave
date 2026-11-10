import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { migrateNavidromeProfiles, NAVIDROME_MIGRATION_ERROR, NAVIDROME_MIGRATION_FILE } from '../src/stations/navidrome-migration.js';
import { activateStation, createStation } from '../src/stations/manager.js';
import { resolveNavidrome } from '../src/setup/navidrome-policy.js';
import { writeFileAtomicSync } from '../src/util/atomic-file.js';

const run = promisify(execFile);
const saved = { url: 'http://saved:4533', user: 'saved-user', pass: ' saved password ' };
const envNv = { url: 'http://env:4533', user: 'env-user', pass: ' env password ' };
const vars = ['NAVIDROME_URL', 'NAVIDROME_USER', 'NAVIDROME_PASS'] as const;

function withEnv(nv: Partial<typeof saved>, fn: () => void) {
  const original = vars.map(key => process.env[key]);
  const values = [nv.url, nv.user, nv.pass];
  try {
    vars.forEach((key, i) => {
      if (values[i] === undefined) delete process.env[key];
      else process.env[key] = values[i];
    });
    fn();
  } finally {
    vars.forEach((key, i) => {
      if (original[i] === undefined) delete process.env[key];
      else process.env[key] = original[i];
    });
  }
}

function fixture(fn: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'subwave-nv-upgrade-'));
  try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

function profile(root: string, id: string, setup?: unknown) {
  const dir = join(root, 'stations', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'station.json'), JSON.stringify({ name: id, createdAt: 'earlier' }));
  if (setup !== undefined) writeFileSync(join(dir, 'setup-config.json'), JSON.stringify(setup));
  return dir;
}

const journalPath = (root: string) => join(root, 'stations', NAVIDROME_MIGRATION_FILE);
const setupPath = (root: string, id: string) => join(root, 'stations', id, 'setup-config.json');
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

test('legacy field precedence: env overrides, empty vs whitespace, partial saves, URL default and password bytes', () => {
  const cases = [
    { env: envNv, stored: saved, expected: envNv },
    { env: {}, stored: saved, expected: saved },
    { env: { user: ' env-user ' }, stored: saved, expected: { ...saved, user: 'env-user' } },
    { env: { pass: envNv.pass }, stored: { url: saved.url, user: saved.user }, expected: { ...saved, pass: envNv.pass } },
    { env: { url: '', user: '', pass: '' }, stored: saved, expected: saved },
    { env: { url: '  ', user: '  ', pass: '  ' }, stored: saved, expected: { url: 'http://navidrome:4533', user: '', pass: '  ' } },
    { env: { user: envNv.user, pass: envNv.pass }, stored: {}, expected: { url: 'http://navidrome:4533', user: envNv.user, pass: envNv.pass } },
    { env: { url: 'invalid-url' }, stored: saved, expected: { ...saved, url: 'http://navidrome:4533' } },
    { env: { url: ' http://env:4533/ ' }, stored: saved, expected: { ...saved, url: 'http://env:4533/' } },
  ];
  for (const { env, stored, expected } of cases) withEnv(env, () => {
    const actual = resolveNavidrome(stored, true, { reportIssue: false });
    assert.deepEqual({ url: actual.url, user: actual.user, pass: actual.password }, expected);
    fixture(root => {
      profile(root, 'main', { navidrome: stored, setupCompletedAt: 'earlier', extra: { retained: true } });
      migrateNavidromeProfiles(root);
      const setup = json(setupPath(root, 'main'));
      assert.deepEqual(setup.navidrome, expected);
      assert.equal(setup.setupCompletedAt, 'earlier');
      assert.deepEqual(setup.extra, { retained: true });
      assert.equal(statSync(setupPath(root, 'main')).mode & 0o777, 0o600);
    });
  });
});

test('first boot covers inactive profiles, protects explicitly independent profiles and completes without credentials', () => {
  fixture(root => withEnv(envNv, () => {
    profile(root, 'main');
    profile(root, 'inactive', { navidrome: saved });
    profile(root, 'protected', { navidrome: saved, navidromePolicy: 'profile-v1' });
    const modern = profile(root, 'new-empty');
    writeFileSync(join(modern, 'station.json'), '{"navidromePolicy":"profile-v1"}');
    symlinkSync(modern, join(root, 'stations', 'linked'), 'dir');
    const protectedBefore = readFileSync(setupPath(root, 'protected'), 'utf8');
    migrateNavidromeProfiles(root);
    for (const id of ['main', 'inactive']) assert.deepEqual(json(setupPath(root, id)).navidrome, envNv);
    assert.equal(readFileSync(setupPath(root, 'protected'), 'utf8'), protectedBefore);
    assert.equal(existsSync(setupPath(root, 'new-empty')), false);
    assert.deepEqual(json(journalPath(root)), { version: 1, phase: 'complete' });
    assert.equal(statSync(journalPath(root)).mode & 0o777, 0o600);
    const mainBefore = readFileSync(setupPath(root, 'main'), 'utf8');
    withEnv(saved, () => migrateNavidromeProfiles(root));
    assert.equal(readFileSync(setupPath(root, 'main'), 'utf8'), mainBefore);
    profile(root, 'later');
    migrateNavidromeProfiles(root);
    assert.equal(existsSync(setupPath(root, 'later')), false, 'completion boundary never expands');
  }));
});

test('failure at each publication retries the frozen cohort and values without overriding a later repair', () => {
  for (const failAt of [1, 2, 3, 4]) fixture(root => withEnv(envNv, () => {
    profile(root, 'a', { navidrome: saved });
    profile(root, 'b');
    let writes = 0;
    assert.throws(() => migrateNavidromeProfiles(root, (path, contents, options) => {
      if (++writes === failAt) throw new Error('write failed with a credential that must stay private');
      writeFileAtomicSync(path, contents, options);
    }), { message: NAVIDROME_MIGRATION_ERROR });
    assert.equal(existsSync(journalPath(root)), failAt !== 1);
    if (failAt !== 1) {
      assert.equal(json(journalPath(root)).phase, 'pending');
      assert.equal(statSync(journalPath(root)).mode & 0o777, 0o600);
      profile(root, 'later');
      withEnv(saved, () => migrateNavidromeProfiles(root));
      assert.equal(existsSync(setupPath(root, 'later')), false);
    } else migrateNavidromeProfiles(root);
    for (const id of ['a', 'b']) assert.deepEqual(json(setupPath(root, id)).navidrome, envNv);
    assert.equal(json(journalPath(root)).phase, 'complete');
    assert.equal(readdirSync(join(root, 'stations')).some(name => name.endsWith('.tmp')), false);
  }));
  fixture(root => withEnv(envNv, () => {
    profile(root, 'main');
    assert.throws(() => migrateNavidromeProfiles(root, (path, contents, options) => {
      if (path === setupPath(root, 'main')) throw new Error('failure');
      writeFileAtomicSync(path, contents, options);
    }));
    writeFileSync(setupPath(root, 'main'), JSON.stringify({ navidrome: saved, navidromePolicy: 'profile-v1' }));
    withEnv({}, () => migrateNavidromeProfiles(root));
    assert.deepEqual(json(setupPath(root, 'main')).navidrome, saved);
  }));
});

test('malformed/unreadable inputs and unwritable destinations do not complete or leak source text', () => {
  fixture(root => withEnv(envNv, () => {
    profile(root, 'main');
    writeFileSync(setupPath(root, 'main'), 'private-password-broken-json');
    assert.throws(() => migrateNavidromeProfiles(root), { message: NAVIDROME_MIGRATION_ERROR });
    assert.equal(readFileSync(setupPath(root, 'main'), 'utf8'), 'private-password-broken-json');
    assert.equal(existsSync(journalPath(root)), false);
    rmSync(setupPath(root, 'main'));
    assert.throws(() => migrateNavidromeProfiles(root, (path, contents, options) => {
      writeFileAtomicSync(path, contents, options);
      if (path === journalPath(root) && json(path).phase === 'pending') mkdirSync(setupPath(root, 'main'));
    }), { message: NAVIDROME_MIGRATION_ERROR });
    assert.equal(json(journalPath(root)).phase, 'pending');
    rmSync(setupPath(root, 'main'), { recursive: true });
    migrateNavidromeProfiles(root);
    assert.deepEqual(json(setupPath(root, 'main')).navidrome, envNv);
  }));
});

test('single-station roots retain env support and have no migration journal', () => {
  fixture(root => withEnv(envNv, () => {
    migrateNavidromeProfiles(root);
    assert.equal(existsSync(join(root, 'stations')), false);
  }));
});

test('a competing boot cannot replace the journal or connections already published by another boot', () => {
  fixture(root => withEnv(envNv, () => {
    profile(root, 'main');
    let competed = false;
    migrateNavidromeProfiles(root, (path, contents, options) => {
      if (!competed) {
        competed = true;
        withEnv(saved, () => migrateNavidromeProfiles(root));
      }
      writeFileAtomicSync(path, contents, options);
    });
    assert.deepEqual(json(setupPath(root, 'main')).navidrome, saved);
    assert.equal(json(journalPath(root)).phase, 'complete');
  }));
});

test('SIGKILL after one profile commit resumes the original snapshot in a new process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'subwave-nv-killed-'));
  try {
    profile(root, 'a');
    profile(root, 'b');
    await assert.rejects(run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      const { migrateNavidromeProfiles } = await import('./src/stations/navidrome-migration.ts');
      const { writeFileAtomicSync } = await import('./src/util/atomic-file.ts');
      migrateNavidromeProfiles(process.env.STATE_DIR, (path, contents, options) => {
        writeFileAtomicSync(path, contents, options);
        if (path.endsWith('/a/setup-config.json')) process.kill(process.pid, 'SIGKILL');
      });
    `], { cwd: new URL('..', import.meta.url), env: { ...process.env, STATE_DIR: root,
      NAVIDROME_URL: envNv.url, NAVIDROME_USER: envNv.user, NAVIDROME_PASS: envNv.pass } }),
    { signal: 'SIGKILL' });
    assert.equal(json(journalPath(root)).phase, 'pending');
    assert.equal(existsSync(setupPath(root, 'b')), false);
    await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      await import('./src/config.ts');
    `], { cwd: new URL('..', import.meta.url), env: { ...process.env, STATE_DIR: root,
      NAVIDROME_URL: saved.url, NAVIDROME_USER: saved.user, NAVIDROME_PASS: saved.pass } });
    for (const id of ['a', 'b']) assert.deepEqual(json(setupPath(root, id)).navidrome, envNv);
    assert.equal(json(journalPath(root)).phase, 'complete');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('fresh process restart and profile switch retain setup status and authenticated library access', async () => {
  const root = mkdtempSync(join(tmpdir(), 'subwave-nv-process-'));
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    assert.equal(url.pathname, '/rest/getPlaylists');
    assert.equal(url.searchParams.get('u'), envNv.user);
    assert.equal(url.searchParams.get('t'), createHash('md5').update(envNv.pass + url.searchParams.get('s')).digest('hex'));
    requests.push(url.pathname);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ 'subsonic-response': { status: 'ok', playlists: { playlist: [{ id: 'working' }] } } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const url = `http://127.0.0.1:${addr.port}`;
  const boot = async (expectSetup = false) => {
    const { stdout } = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      const { config, NAVIDROME_ENV_ENABLED } = await import('./src/config.ts');
      const { loadNavidromeConfig } = await import('./src/setup/config.ts');
      const { getSetupStatus, getSetupStatusSync } = await import('./src/setup/firstRun.ts');
      await loadNavidromeConfig();
      assert.equal(NAVIDROME_ENV_ENABLED, false);
      assert.equal((await getSetupStatus()).needsSetup, ${expectSetup});
      assert.equal(getSetupStatusSync().needsSetup, ${expectSetup});
      if (!${expectSetup}) {
        const { getPlaylists } = await import('./src/music/subsonic.ts');
        assert.equal((await getPlaylists())[0].id, 'working');
      }
      console.log('verified');
    `], { cwd: new URL('..', import.meta.url), env: { ...process.env, STATE_DIR: root,
      NAVIDROME_URL: url, NAVIDROME_USER: envNv.user, NAVIDROME_PASS: envNv.pass } });
    assert.ok(stdout.includes('verified'));
  };
  try {
    profile(root, 'main');
    profile(root, 'inactive', { navidrome: { url: saved.url } });
    writeFileSync(join(root, 'stations', 'active.json'), '{"activeId":"main"}');
    await boot();
    await boot();
    activateStation(root, 'inactive');
    await boot();
    const fresh = await createStation(root, { name: 'New', currentName: 'main' });
    const duplicate = await createStation(root, { name: 'Copy', currentName: 'main', mode: 'duplicate' });
    for (const id of [fresh.id, duplicate.id]) {
      activateStation(root, id);
      await boot(true);
    }
    assert.equal(requests.length, 3);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

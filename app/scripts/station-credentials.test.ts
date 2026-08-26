import assert from 'node:assert/strict';
import test from 'node:test';
import { createCredentialVault } from '../src/lib/credential-vault.ts';
import { forgetStoredStation } from '../src/lib/station-store.ts';
import {
  authorizationFor,
  credentialedBase,
  migrateLegacyStationStore,
  resolveStationConnection,
  splitStationAddress,
  stationProbeCandidates,
  type StationCredentials,
} from '../src/lib/station-credentials.ts';

function memoryStore() {
  const values = new Map<string, string>();
  return {
    getItemAsync: async (key: string) => values.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

test('splits percent-encoded credentials from a legacy station address', () => {
  assert.deepEqual(splitStationAddress('https://dj:p%40ss@radio.example.com/'), {
    base: 'https://radio.example.com',
    credentials: { username: 'dj', password: 'p@ss' },
  });
});

test('leaves a public station address credential-free and unauthenticated', () => {
  assert.deepEqual(splitStationAddress('radio.example.com/'), {
    base: 'https://radio.example.com',
    credentials: null,
  });
});

test('builds a UTF-8 Basic authorization header from separate credentials', () => {
  assert.equal(
    authorizationFor({ username: 'djä', password: 'sëcret' }),
    'Basic ZGrDpDpzw6tjcmV0',
  );
});

test('embeds encoded credentials only in the in-memory request base', () => {
  assert.equal(
    credentialedBase('https://radio.example.com', {
      username: 'dj@example.com',
      password: 'p@ss/word',
    }),
    'https://dj%40example.com:p%40ss%2Fword@radio.example.com',
  );
});

test('resolves a clean public base, authenticated request base, and audio header together', () => {
  assert.deepEqual(
    resolveStationConnection('https://radio.example.com', {
      username: 'dj',
      password: 'p@ss',
    }),
    {
      base: 'https://radio.example.com',
      requestBase: 'https://dj:p%40ss@radio.example.com',
      authorization: 'Basic ZGo6cEBzcw==',
    },
  );
});

test('keeps supporting a legacy credentialed address until storage migration runs', () => {
  assert.deepEqual(resolveStationConnection('https://dj:p%40ss@radio.example.com'), {
    base: 'https://radio.example.com',
    requestBase: 'https://dj:p%40ss@radio.example.com',
    authorization: 'Basic ZGo6cEBzcw==',
  });
});

test('migrates legacy active and recent URLs without leaving secrets in the station store', () => {
  const migrated = migrateLegacyStationStore({
    activeStation: 'https://dj:p%40ss@radio.example.com',
    recents: [
      {
        url: 'https://dj:p%40ss@radio.example.com',
        name: 'Private radio',
        lastUsed: 123,
      },
      { url: 'https://public.example.com', name: 'Public radio', lastUsed: 100 },
    ],
  });

  assert.deepEqual(migrated.store, {
    activeStation: 'https://radio.example.com',
    recents: [
      { url: 'https://radio.example.com', name: 'Private radio', lastUsed: 123 },
      { url: 'https://public.example.com', name: 'Public radio', lastUsed: 100 },
    ],
  });
  assert.deepEqual(migrated.credentials, {
    'https://radio.example.com': { username: 'dj', password: 'p@ss' },
  });
  assert.equal(migrated.changed, true);
});

test('reports no migration when the saved station store is already credential-free', () => {
  const store = {
    activeStation: 'https://radio.example.com',
    recents: [{ url: 'https://radio.example.com', name: 'Radio' }],
  };

  assert.deepEqual(migrateLegacyStationStore(store), {
    store,
    credentials: {},
    changed: false,
  });
});

test('legacy migration prefers the active station login over duplicate recents', () => {
  const migrated = migrateLegacyStationStore({
    activeStation: 'https://active:secret@radio.example.com',
    recents: [
      { url: 'https://newest:recent@radio.example.com', name: 'Newest' },
      { url: 'https://oldest:recent@radio.example.com', name: 'Oldest' },
    ],
  });

  assert.deepEqual(migrated.credentials['https://radio.example.com'], {
    username: 'active',
    password: 'secret',
  });
});

test('legacy migration prefers the newest recent login when the active URL is clean', () => {
  const migrated = migrateLegacyStationStore({
    activeStation: 'https://radio.example.com',
    recents: [
      { url: 'https://newest:recent@radio.example.com', name: 'Newest' },
      { url: 'https://oldest:recent@radio.example.com', name: 'Oldest' },
    ],
  });

  assert.deepEqual(migrated.credentials['https://radio.example.com'], {
    username: 'newest',
    password: 'recent',
  });
});

test('an authenticated bare host never silently downgrades from HTTPS to HTTP', () => {
  assert.deepEqual(stationProbeCandidates('radio.example.com', true), [
    'https://radio.example.com',
  ]);
  assert.deepEqual(stationProbeCandidates('radio.example.com', false), [
    'https://radio.example.com',
    'http://radio.example.com',
  ]);
});

test('an explicit HTTP address remains available for an authenticated station', () => {
  assert.deepEqual(stationProbeCandidates('http://radio.example.com', true), [
    'http://radio.example.com',
  ]);
});

test('credential vault stores secrets by credential-free station URL', async () => {
  const vault = createCredentialVault(memoryStore());

  await vault.set('https://radio.example.com', { username: 'dj', password: 'secret' });

  assert.deepEqual(await vault.get('https://radio.example.com'), {
    username: 'dj',
    password: 'secret',
  });
  assert.equal(await vault.get('https://other.example.com'), null);
});

test('credential vault merges migrations without replacing existing stations', async () => {
  const vault = createCredentialVault(memoryStore());
  await vault.set('https://one.example.com', { username: 'one', password: 'first' });

  await vault.merge({
    'https://two.example.com': { username: 'two', password: 'second' },
  });

  assert.deepEqual(await vault.get('https://one.example.com'), {
    username: 'one',
    password: 'first',
  });
  assert.deepEqual(await vault.get('https://two.example.com'), {
    username: 'two',
    password: 'second',
  });
});

test('credential vault migration never replaces a login already in secure storage', async () => {
  const vault = createCredentialVault(memoryStore());
  await vault.set('https://radio.example.com', { username: 'saved', password: 'current' });

  await vault.merge({
    'https://radio.example.com': { username: 'legacy', password: 'stale' },
  });

  assert.deepEqual(await vault.get('https://radio.example.com'), {
    username: 'saved',
    password: 'current',
  });
});

test('credential vault does not erase other logins when secure storage cannot be read', async () => {
  let writes = 0;
  const vault = createCredentialVault({
    getItemAsync: async () => {
      throw new Error('secure storage locked');
    },
    setItemAsync: async () => {
      writes++;
    },
  });

  await assert.rejects(
    vault.set('https://radio.example.com', { username: 'dj', password: 'secret' }),
    /secure storage locked/,
  );
  assert.equal(writes, 0);
});

test('credential vault removes only the forgotten station secret', async () => {
  const vault = createCredentialVault(memoryStore());
  await vault.merge({
    'https://one.example.com': { username: 'one', password: 'first' },
    'https://two.example.com': { username: 'two', password: 'second' },
  });

  await vault.remove('https://one.example.com');

  assert.equal(await vault.get('https://one.example.com'), null);
  assert.deepEqual(await vault.get('https://two.example.com'), {
    username: 'two',
    password: 'second',
  });
});

test('forget migrates a retained legacy login before deleting its secure credential', async () => {
  const events: string[] = [];
  const secure = new Map<string, StationCredentials>();
  const legacy = {
    activeStation: 'https://dj:secret@radio.example.com',
    recents: [{ url: 'https://dj:secret@radio.example.com', name: 'Radio' }],
  };

  const result = await forgetStoredStation('https://radio.example.com', {
    load: async () => {
      events.push('load-and-migrate');
      const migrated = migrateLegacyStationStore(legacy);
      for (const [base, credentials] of Object.entries(migrated.credentials)) {
        secure.set(base, credentials);
      }
      return migrated.store;
    },
    removeCredential: async (base) => {
      events.push('remove-credential');
      secure.delete(base);
    },
    persist: async () => {
      events.push('persist');
    },
  });

  assert.deepEqual(events, ['load-and-migrate', 'remove-credential', 'persist']);
  assert.equal(secure.has('https://radio.example.com'), false);
  assert.deepEqual(result.recents, []);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createCredentialVault } from '../src/lib/credential-vault.ts';
import {
  authorizationFor,
  credentialedBase,
  migrateLegacyStationStore,
  resolveStationConnection,
  splitStationAddress,
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

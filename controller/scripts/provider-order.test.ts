// The provider lists GET /settings serves keep one order. The embedding list is
// the LLM list's embedding-capable subset in the LLM list's order, and the env
// flags report every key SECRET_ENV_KEYS lets the wizard write, in that list's
// order, so neither can drift into an order of its own again.
//
// Run: `npm test -- provider-order`.

import assert from 'node:assert/strict';
import { listen as listenHttp } from './test-utils/http.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-provider-order-'));
process.env.STATE_DIR = stateRoot;
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;

const express = (await import('express')).default;
const settings = await import('../src/settings.js');
const { SECRET_ENV_KEYS } = await import('../src/setup/secrets.js');
const { router } = await import('../src/routes/settings/core.js');
await settings.load();

test('the embedding providers are the LLM providers that embed, in LLM order', () => {
  const llm = settings.LLM_PROVIDERS as readonly string[];
  const embed = settings.EMBEDDING_PROVIDERS as readonly string[];
  assert.deepEqual(llm.filter(p => embed.includes(p)), [...embed]);
});

test('GET /settings flags exactly the writable secrets, in SECRET_ENV_KEYS order', async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  const { server, url } = await listenHttp(app);
  server.unref();
  const body = await (await fetch(`${url}/settings`)).json() as {
    env: Record<string, boolean>;
    llm: { providers: string[] };
    embedding: { providers: string[] };
  };
  assert.deepEqual(Object.keys(body.env), [...SECRET_ENV_KEYS]);
  assert.deepEqual(body.llm.providers, [...settings.LLM_PROVIDERS]);
  assert.deepEqual(body.embedding.providers, [...settings.EMBEDDING_PROVIDERS]);
});

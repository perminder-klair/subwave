// Regression test for the embedding preflight + dimension handling (#319).
//
// Exercises the real modules end-to-end — no mocks of our own code:
//   1. probeOnce() reports the dimension measured from a LIVE embedding call
//      (ollama nomic-embed-text). Skipped if ollama isn't reachable.
//   2. ensureReady() classifies a chat-model / no-pooling server as
//      `not_embedding_model` with an actionable message — driven through the
//      real AI SDK error path via a throwaway HTTP server that mimics the two
//      llama.cpp error strings operators actually hit.
//   3. library-db migrate() honours the stored dim at runtime (adoptStoredDim),
//      refuses a silent dim change for the tagger, and rebuilds on --reseed.
//      Run against real sqlite-vec.
//
// Usage (from controller/):
//   npm run test:embed
//
// Self-contained: points STATE_DIR at a throwaway dir and mutates settings
// in-memory, so it never touches a live install's state/.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

// Must be set BEFORE importing anything that reads config (config.ts captures
// STATE_DIR at import time).
process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-embed-test-'));

const settings = await import('../src/settings.js');
const embeddings = await import('../src/music/embeddings.js');
const db = await import('../src/music/library-db.js');
const embProvider = await import('../src/llm/internal/provider/embedding.js');

let pass = 0;
let fail = 0;
let skip = 0;
function ok(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`);
  }
}
function skipped(name: string, why: string) {
  skip++;
  console.log(`  SKIP  ${name} — ${why}`);
}

await settings.load();
const S: any = settings.get();

// ---- 1. Live ollama probe → authoritative dim (#2) ------------------------
console.log('\n[1] probe reports the live embedding dimension');
S.llm = { provider: 'ollama', model: '', apiKey: '', ollamaUrl: '', baseUrl: '', reasoning: false };
S.embedding = { enabled: true, provider: 'ollama', model: 'nomic-embed-text' };
{
  const r = await embeddings.ensureReady();
  if (r.code === 'ok') {
    ok('probe returns a measured dim', typeof r.dim === 'number' && r.dim! > 0, `dim=${r.dim}`);
    ok('nomic-embed-text measures 768', r.dim === 768, `dim=${r.dim}`);
  } else {
    // No local ollama / model not pulled — don't fail the suite for that.
    skipped('live ollama probe', `probe code=${r.code} (ollama+nomic-embed-text not available)`);
  }
}

// ---- 2. Chat model / no pooling → not_embedding_model (#1) -----------------
console.log('\n[2] a chat model (no pooling) is classified, not left as "unknown"');
async function probeAgainst(errMsg: string) {
  const server = http.createServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: errMsg, type: 'server_error' } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  S.embedding = {
    enabled: true,
    provider: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: 'qwen3.5',
    apiKey: '',
  };
  try {
    return await embeddings.ensureReady();
  } finally {
    server.close();
  }
}
for (const msg of [
  'This server does not support embeddings. Start it with `--embeddings`',
  "Pooling type 'none' is not OAI compatible. Please use a different pooling type",
]) {
  const r = await probeAgainst(msg);
  ok('classified not_embedding_model', r.code === 'not_embedding_model', `"${msg.slice(0, 38)}..."`);
  ok('message points at the fix', /--embeddings|pooling|embedding model/i.test(r.message));
}

// ---- 3. chat-only provider → no_embeddings (#493) -------------------------
// deepseek / gateway have no embeddings endpoint; buildEmbeddingModel throws
// synchronously (no network), so this is classified offline. (openrouter shipped
// an embeddings endpoint and is now embedding-capable — see #522.)
console.log('\n[3] a chat-only provider is classified no_embeddings (offline)');
for (const provider of ['deepseek', 'gateway']) {
  S.embedding = { enabled: true, provider, model: '', apiKey: '', baseUrl: '', ollamaUrl: '' };
  const r = await embeddings.ensureReady();
  ok(`${provider} → no_embeddings`, r.code === 'no_embeddings', `code=${r.code}`);
  ok(`${provider} message names the real fix`, /chat-only|embedding-capable|Ollama/i.test(r.message));
}

// ---- 3b. openrouter BUILDS an embedding model (#522) ----------------------
// OpenRouter shipped an OpenAI-compatible embeddings endpoint, so it must no
// longer be rejected as chat-only. Offline: buildEmbeddingModel constructs the
// client without any network call — we only assert it doesn't throw the
// "no text-embedding support" error the chat-only providers above still do.
console.log('\n[3b] openrouter builds an embedding model (offline, #522)');
{
  let built = false;
  let threw = '';
  try {
    embProvider.buildEmbeddingModel({
      enabled: true,
      provider: 'openrouter',
      model: '',
      apiKey: 'test-key',
      ollamaUrl: '',
      baseUrl: '',
    });
    built = true;
  } catch (e: any) {
    threw = e?.message || String(e);
  }
  ok('openrouter builds without the no-embeddings error', built, threw ? `threw: ${threw.slice(0, 48)}` : 'ok');
}

// ---- 4. library-db dim handling (#2) --------------------------------------
console.log('\n[4] library-db honours the stored dim');
// Seed a 768-d DB the way the tagger would.
await db.open({ embeddingDim: 768, reseed: false });
db.setEmbeddingMeta('ollama:nomic-embed-text', 768);
db.upsertTrackMeta('t1', { title: 'x', artist: 'y' });
db.upsertTrackVector('t1', new Array(768).fill(0.01));
ok('seed: 768-d vector accepted', true);
db.close();

// 3a. Runtime opens with the WRONG name-guessed dim but adoptStoredDim → adopt
//     the stored 768 and keep the index instead of wiping it.
await db.open({ embeddingDim: 1536, adoptStoredDim: true });
ok('adopt: stored meta still 768 (index not wiped)', db.getEmbeddingMeta()?.dim === 768);
let accepted768 = false;
try {
  db.upsertTrackVector('t1', new Array(768).fill(0.02));
  accepted768 = true;
} catch { /* table width wrong */ }
ok('adopt: table really is 768 (768-d upsert accepted)', accepted768);
let rejected1536 = false;
try {
  db.upsertTrackVector('t1', new Array(1536).fill(0.02));
} catch {
  rejected1536 = true;
}
ok('adopt: 1536-d upsert rejected', rejected1536);
db.close();

// 3b. Tagger opens with a changed dim and NO --reseed → instructive throw.
let threw = false;
let msg = '';
try {
  await db.open({ embeddingDim: 1536, reseed: false });
} catch (e: any) {
  threw = true;
  msg = e?.message || '';
}
ok('mismatch: throws without --reseed', threw);
ok('mismatch: message names --reseed', /--reseed/.test(msg));
if (db.isOpen()) db.close();

// 3c. Tagger opens with a changed dim WITH --reseed → rebuild at the new dim.
await db.open({ embeddingDim: 1536, reseed: true });
db.setEmbeddingMeta('other:model-1536', 1536);
let accepted1536 = false;
try {
  db.upsertTrackVector('t1', new Array(1536).fill(0.03));
  accepted1536 = true;
} catch { /* */ }
ok('reseed: table rebuilt at 1536', accepted1536);
db.close();

console.log(`\n==== ${pass} passed, ${fail} failed, ${skip} skipped ====`);
process.exit(fail ? 1 : 0);

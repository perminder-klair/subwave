// Unit tests for embedding task-prefix handling — the per-model prefix table
// (llm/internal/provider/embedding.ts) and the index-mode resolution + pure
// prefix application in music/embeddings.ts.
//
// nomic-embed-text (the shipped default) is trained with mandatory
// `search_document:` / `search_query:` prefixes; embedding bare degrades
// retrieval. Documents and queries must agree, so the index records its mode
// (embedding_meta.text_mode) and these tests pin the consistency rules:
// stored mode always wins, a populated legacy index stays plain, a fresh
// index adopts the model's preference.
// Run: `tsx scripts/embedding-prefix.test.ts` (folded into `npm run test`).

import assert from 'node:assert/strict';
import { embeddingTextPrefixes } from '../src/llm/provider.js';
import {
  preferredTextMode,
  resolveIndexTextMode,
  applyDocPrefix,
  applyQueryPrefix,
} from '../src/music/embeddings.js';

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures++; console.error(`  ✗ ${name}\n      ${err?.message || err}`); });
}

const NOMIC = embeddingTextPrefixes('nomic-embed-text');
const MXBAI = embeddingTextPrefixes('mxbai-embed-large');
const NONE = embeddingTextPrefixes('text-embedding-3-small');

async function main() {
  console.log('embeddingTextPrefixes (per-model table):');

  await test('nomic family prefixes both sides, tag-suffix tolerant', () => {
    assert.equal(NOMIC.document, 'search_document: ');
    assert.equal(NOMIC.query, 'search_query: ');
    assert.deepEqual(embeddingTextPrefixes('nomic-embed-text:latest'), NOMIC);
    assert.deepEqual(embeddingTextPrefixes('nomic-embed-text-v1.5'), NOMIC);
  });

  await test('mxbai-embed-large prefixes queries only', () => {
    assert.equal(MXBAI.document, '');
    assert.ok(MXBAI.query.length > 0);
  });

  await test('unknown models get no prefixes', () => {
    assert.deepEqual(NONE, { document: '', query: '' });
    assert.deepEqual(embeddingTextPrefixes(''), { document: '', query: '' });
  });

  console.log('resolveIndexTextMode (index-mode resolution):');

  await test('stored mode always wins — consistency beats preference', () => {
    assert.equal(resolveIndexTextMode('plain', 5000), 'plain');
    assert.equal(resolveIndexTextMode('prefixed', 5000), 'prefixed');
    assert.equal(resolveIndexTextMode('plain', 0), 'plain');
  });

  await test('populated index with no recorded mode = legacy = plain', () => {
    assert.equal(resolveIndexTextMode(null, 5000), 'plain');
    assert.equal(resolveIndexTextMode(undefined, 1), 'plain');
  });

  await test('empty index adopts the active model\'s preference (default = nomic = prefixed)', () => {
    // DEFAULTS: provider ollama, model '' → nomic-embed-text → prefixed. If the
    // shipped default embedding model ever changes, revisit this pin.
    assert.equal(preferredTextMode(), 'prefixed');
    assert.equal(resolveIndexTextMode(null, 0), 'prefixed');
  });

  console.log('applyDocPrefix / applyQueryPrefix (pure application):');

  await test('doc prefix only applies in prefixed mode', () => {
    assert.equal(applyDocPrefix('Artist — Title', 'prefixed', NOMIC), 'search_document: Artist — Title');
    assert.equal(applyDocPrefix('Artist — Title', 'plain', NOMIC), 'Artist — Title');
    assert.equal(applyDocPrefix('Artist — Title', 'prefixed', NONE), 'Artist — Title');
  });

  await test('query prefix follows the index mode for doc-prefixing models', () => {
    assert.equal(applyQueryPrefix('hopeful lyrics', 'prefixed', NOMIC), 'search_query: hopeful lyrics');
    // A prefixed query against bare documents is worse than bare-vs-bare.
    assert.equal(applyQueryPrefix('hopeful lyrics', 'plain', NOMIC), 'hopeful lyrics');
  });

  await test('query-only models prefix regardless of index mode', () => {
    assert.equal(applyQueryPrefix('hopeful lyrics', 'plain', MXBAI), MXBAI.query + 'hopeful lyrics');
    assert.equal(applyQueryPrefix('hopeful lyrics', 'prefixed', MXBAI), MXBAI.query + 'hopeful lyrics');
  });

  await test('no-prefix models pass text through untouched', () => {
    assert.equal(applyQueryPrefix('hopeful lyrics', 'prefixed', NONE), 'hopeful lyrics');
    assert.equal(applyDocPrefix('x', 'prefixed', NONE), 'x');
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('\nall embedding-prefix tests passed');
}

main();

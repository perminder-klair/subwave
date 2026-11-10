// Pins for state/secrets.env parsing (src/setup/secrets.ts).
//
// This file holds every cloud API key and is deliberately hand-editable, so a
// misread is a wrong SECRET — which surfaces only as a provider 401, pointing
// nowhere near the file. Two properties matter:
//
//   • ordinary .env syntax reads the way the operator meant it (that is what
//     the hand-rolled splitter got wrong: `export KEY=…` was dropped entirely,
//     and a trailing `# note` became part of the value), and
//   • save→load ROUND-TRIPS, because saveSecrets rewrites the whole file from
//     what it just read — a value the reader gets wrong is a stored secret
//     destroyed on disk, not merely one that fails to load.
//
// Run: `npm test -- secrets-env`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// STATE_DIR must be set before config.js resolves it at import time.
const stateDir = createTempDir(join(tmpdir(), 'secrets-env-test-'));
process.env.STATE_DIR = stateDir;

const { readSecretsFile, saveSecrets, SECRET_ENV_KEYS } = await import('../src/setup/secrets.js');
const FILE = join(stateDir, 'secrets.env');

test('a plain wizard-written file reads back exactly', () => {
  const { values, warnings } = readSecretsFile('OPENAI_API_KEY=sk-abc123\nELEVENLABS_API_KEY=el-xyz\n');
  assert.deepEqual(values, { OPENAI_API_KEY: 'sk-abc123', ELEVENLABS_API_KEY: 'el-xyz' });
  assert.deepEqual(warnings, []);
});

test('`export KEY=…` is honoured — it used to be skipped entirely', () => {
  // The old splitter took everything before the first `=` as the key, so this
  // parsed as `export OPENAI_API_KEY`, matched no known key, and was dropped:
  // the operator saw an unset credential with nothing explaining why.
  const { values } = readSecretsFile('export OPENAI_API_KEY=sk-abc123\n');
  assert.equal(values.OPENAI_API_KEY, 'sk-abc123');
});

test('a trailing comment is a comment, not part of the key', () => {
  const { values } = readSecretsFile('OPENAI_API_KEY=sk-abc123 # personal account\n');
  assert.equal(values.OPENAI_API_KEY, 'sk-abc123');
});

test('quoting styles all resolve to the bare value', () => {
  const { values } = readSecretsFile(
    `OPENAI_API_KEY='sk-single'\nELEVENLABS_API_KEY="el-double"\nFISH_API_KEY=fish-bare\n`,
  );
  assert.equal(values.OPENAI_API_KEY, 'sk-single');
  assert.equal(values.ELEVENLABS_API_KEY, 'el-double');
  assert.equal(values.FISH_API_KEY, 'fish-bare');
});

test('full-line comments and blank lines are ignored', () => {
  const { values, warnings } = readSecretsFile('# a note\n\n  \nOPENAI_API_KEY=sk-abc\n');
  assert.deepEqual(values, { OPENAI_API_KEY: 'sk-abc' });
  assert.deepEqual(warnings, []);
});

test('an empty value is preserved — it means "fall back to env", not "absent"', () => {
  const { values } = readSecretsFile('OPENAI_API_KEY=\n');
  assert.equal(values.OPENAI_API_KEY, '');
  assert.ok('OPENAI_API_KEY' in values);
});

test('keys this module does not own are dropped', () => {
  // The allow-list is the defence against the wizard form being used as a
  // generic env-var setter; reading must respect it too.
  const { values } = readSecretsFile('PATH=/evil\nNODE_OPTIONS=--inspect\nOPENAI_API_KEY=sk-abc\n');
  assert.deepEqual(Object.keys(values), ['OPENAI_API_KEY']);
  assert.ok(!SECRET_ENV_KEYS.includes('PATH'));
});

test('an unquoted # truncates — and says so, rather than truncating silently', () => {
  // The one case where .env semantics are LESS forgiving than the old splitter.
  // Truncation is correct .env behaviour; going quiet about it would just trade
  // one silent wrong secret for another.
  const { values, warnings } = readSecretsFile('OPENAI_API_KEY=sk-abc#def\n');
  assert.equal(values.OPENAI_API_KEY, 'sk-abc');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /OPENAI_API_KEY/);
  assert.match(warnings[0], /single quotes/, 'the warning names the fix');
});

test('a QUOTED # is part of the secret, and draws no warning', () => {
  const { values, warnings } = readSecretsFile(`OPENAI_API_KEY='sk-abc#def'\n`);
  assert.equal(values.OPENAI_API_KEY, 'sk-abc#def');
  assert.deepEqual(warnings, []);
});

test('a # in a key we do not own does not warn', () => {
  const { warnings } = readSecretsFile('SOME_OTHER_VAR=a#b\n');
  assert.deepEqual(warnings, []);
});

test('a multi-line value is dropped, loudly — this file cannot store one', () => {
  // envEscape refuses to persist a newline, so carrying the value would put the
  // live env out of lockstep with the file AND make the next saveSecrets throw
  // on a key the operator never touched.
  const { values, warnings } = readSecretsFile('OPENAI_API_KEY="line1\nline2"\nFISH_API_KEY=ok\n');
  assert.ok(!('OPENAI_API_KEY' in values));
  assert.equal(values.FISH_API_KEY, 'ok');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /multiple lines/);
});

test('junk never throws — a hand-edited file must not wedge boot', () => {
  for (const junk of ['', '\0\0\0', 'OPENAI_API_KEY', '=====', '{"json": true}', 'a'.repeat(10_000)]) {
    assert.doesNotThrow(() => readSecretsFile(junk), `threw on ${JSON.stringify(junk.slice(0, 20))}`);
  }
});

test('save → read round-trips every awkward secret shape', async () => {
  // The load-bearing one: saveSecrets rewrites the file from what it read, so a
  // reader/writer disagreement destroys a stored key rather than just failing.
  const secrets = {
    OPENAI_API_KEY: 'sk-plain123',
    ELEVENLABS_API_KEY: 'has spaces in it',
    FISH_API_KEY: 'hash#inside',
    SEARCH_API_KEY: 'sym=bols&and?more',
    LASTFM_API_KEY: '#leading-hash',
    LISTENBRAINZ_API_URL: 'https://api.listenbrainz.org/1/submit-listens',
    DEEPSEEK_API_KEY: '',
  };
  await saveSecrets(secrets);
  const { values, warnings } = readSecretsFile(readFileSync(FILE, 'utf8'));
  assert.deepEqual(warnings, [], 'the writer must never emit a shape the reader warns about');
  for (const [key, value] of Object.entries(secrets)) {
    assert.equal(values[key], value, `${key} did not round-trip`);
  }
});

test('a second save preserves keys it was not given', async () => {
  await saveSecrets({ OPENAI_API_KEY: 'sk-first', FISH_API_KEY: 'fish#one' });
  await saveSecrets({ OPENAI_API_KEY: 'sk-second' });
  const { values } = readSecretsFile(readFileSync(FILE, 'utf8'));
  assert.equal(values.OPENAI_API_KEY, 'sk-second');
  assert.equal(values.FISH_API_KEY, 'fish#one', 'an untouched key survives the merge intact');
});

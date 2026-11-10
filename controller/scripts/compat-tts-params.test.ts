// Extra generation parameters for the openai-compatible cloud TTS provider
// (issue #1317). The pure rules are unit-checked; the wire behaviour runs
// against a loopback mock of /v1/audio/speech, so no credentials, no external
// host and no billable synthesis are involved.

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// STATE_DIR is redirected at a throwaway dir BEFORE the first import of
// anything config-derived, so settings.load() touches nothing real — hence the
// dynamic imports below (same pattern as scripts/archive-retention.test.ts).
const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-compat-params-'));
process.env.STATE_DIR = stateRoot;

const {
  COMPAT_PARAM_MAX_ENTRIES,
  coerceCompatParamValue,
  compatParamsBody,
  validateCompatParams,
} = await import('../src/settings/compat-params.js');
const { getDefaults, setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { speak } = await import('../src/llm/internal/speech/cloud-speech.js');

const SETTINGS_PATH = path.join(stateRoot, 'settings.json');

// Load a hand-written settings.json the way a controller restart would.
async function loadStoredCloud(cloud: unknown) {
  writeFileSync(SETTINGS_PATH, JSON.stringify({ tts: { cloud } }));
  setCache(null);
  await settings.load();
  return settings.get().tts.cloud;
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(err => {
      res.statusCode = 500;
      res.end(String(err));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
}

// Point the settings cache at a mock compatibility server for the duration of
// one call, then restore. setCache is the store's single writer, which is the
// same seam load()/update() use.
async function withCompatCloud(
  cloud: Record<string, unknown>,
  run: () => Promise<void>,
): Promise<void> {
  const before = getDefaults();
  setCache({
    ...before,
    tts: {
      ...before.tts,
      cloud: { ...before.tts.cloud, enabled: true, provider: 'openai-compatible', ...cloud },
    },
  });
  try {
    await run();
  } finally {
    setCache(null);
  }
}

test('coerceCompatParamValue sends real JSON types, not the operator’s text', () => {
  // Numbers and booleans must not arrive quoted — a server reading
  // `temperature` as a float rejects the string "0.8".
  assert.equal(coerceCompatParamValue('0.8'), 0.8);
  assert.equal(coerceCompatParamValue('42'), 42);
  assert.equal(coerceCompatParamValue('-1'), -1);
  assert.equal(coerceCompatParamValue('true'), true);
  assert.equal(coerceCompatParamValue('false'), false);
  assert.equal(coerceCompatParamValue('null'), null);
  assert.deepEqual(coerceCompatParamValue('{"a":1}'), { a: 1 });
  assert.deepEqual(coerceCompatParamValue('[1,2]'), [1, 2]);
  // Anything that isn't a JSON literal stays a plain string.
  assert.equal(coerceCompatParamValue('alba'), 'alba');
  assert.equal(coerceCompatParamValue('42abc'), '42abc');
  assert.equal(coerceCompatParamValue(' spaced '), 'spaced');
  assert.equal(coerceCompatParamValue(''), '');
  // A leading zero reads as an id, not a number — servers use these as voice
  // and preset handles, and 7 is not the same handle as 007.
  assert.equal(coerceCompatParamValue('007'), '007');
});

test('validateCompatParams accepts a Chatterbox tuning set and drops blank rows', () => {
  assert.deepEqual(validateCompatParams([
    { key: 'temperature', value: '0.8' },
    { key: '', value: '' },
    { key: 'seed', value: '1234' },
    { key: 'exaggeration', value: '0.5' },
    { key: '  cfg_weight  ', value: '  0.3  ' },
  ]), [
    { key: 'temperature', value: '0.8' },
    { key: 'seed', value: '1234' },
    { key: 'exaggeration', value: '0.5' },
    { key: 'cfg_weight', value: '0.3' },
  ]);
  assert.deepEqual(validateCompatParams([]), []);
  assert.deepEqual(validateCompatParams(undefined), []);
  assert.deepEqual(validateCompatParams(null), []);
});

test('validateCompatParams refuses the fields SUB/WAVE sets for every request', () => {
  // `speed` is the subtle one: compat renders at 1x and the rate is applied
  // locally with ffmpeg (#942), so a server-side speed would COMPOUND with it.
  for (const key of ['model', 'input', 'voice', 'speed']) {
    assert.throws(
      () => validateCompatParams([{ key, value: '1' }]),
      new RegExp(`cannot override "${key}"`),
      key,
    );
  }
});

test('validateCompatParams rejects malformed rows rather than saving a request that 4xxs', () => {
  assert.throws(() => validateCompatParams('temperature=0.8'), /must be an array/);
  assert.throws(() => validateCompatParams([['temperature', '0.8']]), /must be objects/);
  assert.throws(() => validateCompatParams([{ key: '', value: '0.8' }]), /need a parameter name/);
  assert.throws(() => validateCompatParams([{ key: '2fast', value: '1' }]), /must start with a letter/);
  assert.throws(() => validateCompatParams([{ key: 'temp erature', value: '1' }]), /must start with a letter/);
  assert.throws(() => validateCompatParams([{ key: 'a'.repeat(61), value: '1' }]), /must be 1-60 chars/);
  assert.throws(() => validateCompatParams([{ key: 'x', value: 'v'.repeat(401) }]), /must be 0-400 chars/);
  assert.throws(
    () => validateCompatParams([{ key: 'seed', value: '1' }, { key: 'seed', value: '2' }]),
    /duplicate name "seed"/,
  );
  assert.throws(
    () => validateCompatParams(
      Array.from({ length: COMPAT_PARAM_MAX_ENTRIES + 1 }, (_, i) => ({ key: `k${i}`, value: '1' })),
    ),
    /limited to 20 entries/,
  );
});

test('compatParamsBody skips junk instead of throwing inside a live render', () => {
  // settings.json is hand-editable, so the send path must survive a shape the
  // validator would have rejected: a dropped param costs one un-tuned line, a
  // throw costs the segment and drops the show to a local fallback voice.
  assert.deepEqual(compatParamsBody([
    { key: 'temperature', value: '0.8' },
    null,
    'nonsense',
    { key: '', value: '9' },
    { key: 'model', value: 'hijacked' },
    { key: 'input', value: 'different words entirely' },
    { key: 'seed', value: '7' },
  ]), { temperature: 0.8, seed: 7 });
  assert.deepEqual(compatParamsBody(undefined), {});
  assert.deepEqual(compatParamsBody('temperature'), {});
});

test('configured params survive a controller restart', async () => {
  // Regression: settings.load() composes tts.cloud field by field rather than
  // spreading DEFAULTS, so a key it doesn't read is a key that saves to disk
  // and then vanishes on the next boot. Caught only by actually restarting —
  // the params wrote through fine and simply stopped being sent, with nothing
  // in the log to say why.
  const loaded = await loadStoredCloud({
    provider: 'openai-compatible',
    baseUrl: 'http://192.168.1.50:5000/v1',
    model: 'chatterbox',
    compatParams: [{ key: 'temperature', value: '0.85' }, { key: 'seed', value: '4242' }],
  });
  assert.deepEqual(loaded.compatParams, [
    { key: 'temperature', value: '0.85' },
    { key: 'seed', value: '4242' },
  ]);

  // A settings.json with no params at all (every install before #1317) loads
  // as an empty list, not undefined.
  assert.deepEqual((await loadStoredCloud({ provider: 'openai' })).compatParams, []);

  // A hand-edited list the validator would reject degrades to none instead of
  // throwing: settings.load() raising means the controller doesn't boot.
  assert.deepEqual((await loadStoredCloud({ compatParams: 'temperature=0.8' })).compatParams, []);
  assert.deepEqual(
    (await loadStoredCloud({ compatParams: [{ key: 'model', value: 'hijacked' }] })).compatParams,
    [],
  );
  setCache(null);
});

test('an openai-compatible render carries the operator’s extra params in the request body', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'subwave-compat-tts-'));
  const outPath = path.join(work, 'line.wav');
  const audio = Buffer.from('RIFF....WAVEfmt bytes');
  let body: any = null;
  try {
    await withServer(async (req, res) => {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/audio/speech');
      body = await readJson(req);
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.end(audio);
    }, async origin => {
      await withCompatCloud({
        baseUrl: `${origin}/v1`,
        model: 'chatterbox',
        voice: 'night-host',
        compatParams: [
          { key: 'temperature', value: '0.85' },
          { key: 'seed', value: '4242' },
          { key: 'exaggeration', value: '0.4' },
          { key: 'use_cache', value: 'true' },
          { key: 'preset', value: 'latenight' },
        ],
      }, async () => {
        assert.equal(await speak('Testing the night shift.', { outPath }), outPath);
      });
    });

    // The station's own fields survive untouched...
    assert.equal(body.model, 'chatterbox');
    assert.equal(body.input, 'Testing the night shift.');
    assert.equal(body.voice, 'night-host');
    // ...and the extras ride alongside them with real JSON types.
    assert.equal(body.temperature, 0.85);
    assert.equal(body.seed, 4242);
    assert.equal(body.exaggeration, 0.4);
    assert.equal(body.use_cache, true);
    assert.equal(body.preset, 'latenight');
    assert.deepEqual(await readFile(outPath), audio);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('no configured params leaves the openai-compatible request shape untouched', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'subwave-compat-tts-'));
  const outPath = path.join(work, 'line.wav');
  let body: any = null;
  try {
    await withServer(async (req, res) => {
      body = await readJson(req);
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.end(Buffer.from('RIFF....WAVEfmt bytes'));
    }, async origin => {
      await withCompatCloud({
        baseUrl: `${origin}/v1`,
        model: 'chatterbox',
        voice: 'night-host',
        compatParams: [],
      }, async () => {
        await speak('Unchanged default station.', { outPath });
      });
    });
    // Exactly the pre-#1317 field set — an untouched station must not start
    // sending anything new.
    assert.deepEqual(
      Object.keys(body).sort(),
      ['input', 'model', 'response_format', 'voice'],
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

// Regression coverage for Remote TTS speech-rate handling.
// Each ffmpeg availability scenario runs in a fresh process because hasFfmpeg()
// intentionally caches its first result.
// Run: npm test -- remote-tts-speed

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scenario = process.env.REMOTE_TTS_SPEED_SCENARIO;

if (scenario) {
  const stateDir = process.env.STATE_DIR!;
  const audio = Buffer.from('remote-audio-at-one-times-speed');
  const settingsPath = path.join(stateDir, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({
    tts: {
      defaultEngine: 'remote',
      remote: { url: 'https://remote.test' },
      speed: { remote: 1 },
    },
  }));

  const settings = await import('../src/settings.js');
  await settings.load();
  const remoteTts = await import('../src/audio/remoteTts.js');
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const warnings: string[] = [];
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/health')) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    requests.push({
      url,
      body: JSON.parse(String(init?.body || '{}')) as Record<string, unknown>,
    });
    if (scenario === 'errors' && requests.length === 1) {
      return new Response('renderer unavailable', { status: 503, statusText: 'Unavailable' });
    }
    if (scenario === 'errors' && requests.length === 2) {
      return new Response(new Uint8Array(), { status: 200, headers: { 'content-type': 'audio/wav' } });
    }
    return new Response(audio, {
      status: 200,
      headers: {
        'content-type': 'audio/wav',
        'x-tts-fell-back': '1',
        'x-tts-voice-used': 'default',
        'x-tts-fell-back-reason': 'unknown voice',
      },
    });
  }) as typeof fetch;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));

  try {
    if (scenario === 'unity') {
      const values = [undefined, 1, Number.NaN, Number.POSITIVE_INFINITY, 0, -0.5];
      for (const [index, speedScale] of values.entries()) {
        const outPath = index === 0 ? undefined : path.join(stateDir, `unity-${index}.wav`);
        const result = await remoteTts.speak('  Keep the wire contract.  ', {
          outPath,
          voice: 'night-host',
          speedScale,
        });
        assert.deepEqual(readFileSync(result), audio);
      }
      assert.deepEqual(requests[0]?.body, { text: 'Keep the wire contract.', voice: 'night-host' });
      assert.deepEqual(Object.keys(requests[0]?.body || {}).sort(), ['text', 'voice']);
      assert.equal(requests.length, values.length);
      assert.equal(warnings.length, values.length, 'voice substitution warnings survive every unity bypass');
    } else if (scenario === 'success') {
      const directCases = [0.5, 0.9, 1.06, 2];
      for (const speedScale of directCases) {
        const outPath = path.join(stateDir, `direct-${speedScale}.wav`);
        assert.equal(
          await remoteTts.speak('Rate-shaped line.', { outPath, voice: 'alba', speedScale }),
          outPath,
        );
        assert.equal(readFileSync(outPath, 'utf8'), `processed:${speedScale}`);
      }

      const tts = await import('../src/audio/tts.js');
      await remoteTts.refresh();
      const dispatchPath = path.join(stateDir, 'dispatch.wav');
      assert.equal(
        await tts.speak('Dispatcher rate.', { kind: 'default', outPath: dispatchPath, speedScale: 0.94 }),
        dispatchPath,
      );
      assert.equal(readFileSync(dispatchPath, 'utf8'), 'processed:0.94');

      const previewPath = await tts.synthesizeSample({ engine: 'remote', voice: 'preview-host', speed: 1.1 });
      assert.equal(readFileSync(previewPath, 'utf8'), 'processed:1.1');

      // A persona preview composes two saved 0.05-grid controls before it gets
      // here. The product is an effective rate, not another saved knob, so it
      // must keep its non-grid precision just like the on-air dispatcher.
      const composedPreviewPath = await tts.synthesizeSample({
        engine: 'remote',
        voice: 'preview-host',
        speed: 1.035, // 0.90 engine × 1.15 persona
      });
      assert.equal(readFileSync(composedPreviewPath, 'utf8'), 'processed:1.035');

      assert.ok(requests.every(request => Object.keys(request.body).sort().join(',') === 'text,voice'));
      const args = readFileSync(process.env.FFMPEG_CAPTURE!, 'utf8');
      for (const factor of ['0.5000', '0.9000', '1.0600', '2.0000', '0.9400', '1.1000', '1.0350']) {
        assert.match(args, new RegExp(`atempo=${factor.replace('.', '\\.')}`));
      }
      assert.match(args, /-c:a pcm_s16le/);
      assert.doesNotMatch(args, /loudnorm/);
      assert.equal(warnings.length, directCases.length + 3, 'voice warnings survive stretched direct, dispatch and preview paths');
    } else if (scenario === 'missing' || scenario === 'failed') {
      const outPath = path.join(stateDir, `${scenario}.wav`);
      assert.equal(
        await remoteTts.speak('Degrade without changing voice.', { outPath, voice: 'alba', speedScale: 0.9 }),
        outPath,
      );
      assert.deepEqual(readFileSync(outPath), audio, 'degraded processing restores exact original bytes');
      assert.ok(
        warnings.some(line => line.includes('[remote]') && line.includes('0.9') && /original|1x/.test(line)),
        'degradation warning identifies Remote, the rate, and original audio',
      );
      assert.ok(warnings.some(line => line.includes('requested voice')), 'voice warning remains observable');
    } else if (scenario === 'errors') {
      const outPath = path.join(stateDir, 'errors.wav');
      await assert.rejects(
        remoteTts.speak('HTTP failure.', { outPath, speedScale: 0.9 }),
        /remote TTS 503: renderer unavailable/,
      );
      await assert.rejects(
        remoteTts.speak('Empty failure.', { outPath, speedScale: 0.9 }),
        /empty response body/,
      );
      await assert.rejects(
        remoteTts.speak('Storage failure.', { outPath: stateDir, speedScale: 1 }),
        /EISDIR|illegal operation on a directory/,
      );
    } else {
      throw new Error(`unknown scenario: ${scenario}`);
    }
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  }
} else {
  const testFile = fileURLToPath(import.meta.url);

  function runScenario(name: string, ffmpeg: 'missing' | 'success' | 'failed') {
    const root = mkdtempSync(path.join(tmpdir(), `subwave-remote-speed-${name}-`));
    const binDir = path.join(root, 'bin');
    const capturePath = path.join(root, 'ffmpeg-args.txt');
    mkdirSync(binDir);

    if (ffmpeg !== 'missing') {
      const fakeFfmpeg = path.join(binDir, 'ffmpeg');
      writeFileSync(fakeFfmpeg, `#!/bin/sh\nif [ "$1" = "-version" ]; then exit 0; fi\nprintf '%s\\n' "$*" >> "$FFMPEG_CAPTURE"\nout=''\nfor arg in "$@"; do out="$arg"; done\nfactor=$(printf '%s' "$*" | /usr/bin/sed -n 's/.*atempo=\\([0-9.]*\\).*/\\1/p')\nif [ "${ffmpeg}" = "failed" ]; then printf 'partial-output' > "$out"; exit 23; fi\nprintf 'processed:%s' "$(printf '%s' "$factor" | /usr/bin/sed 's/0*$//;s/\\.$//')" > "$out"\n`);
      chmodSync(fakeFfmpeg, 0o755);
    }

    try {
      execFileSync(process.execPath, ['--import', 'tsx', testFile], {
        cwd: path.dirname(path.dirname(testFile)),
        encoding: 'utf8',
        env: {
          ...process.env,
          STATE_DIR: root,
          PATH: binDir,
          FFMPEG_CAPTURE: capturePath,
          REMOTE_TTS_SPEED_SCENARIO: name,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test('unity and invalid direct rates bypass ffmpeg and preserve original bytes', () => {
    runScenario('unity', 'missing');
  });

  test('valid rates are applied locally through direct, dispatcher and preview paths', () => {
    runScenario('success', 'success');
  });

  test('missing ffmpeg degrades to original audio without changing TTS voice', () => {
    runScenario('missing', 'missing');
  });

  test('failed ffmpeg overwrites partial output with original audio', () => {
    runScenario('failed', 'failed');
  });

  test('HTTP, empty-body and storage failures remain genuine errors', () => {
    runScenario('errors', 'missing');
  });
}

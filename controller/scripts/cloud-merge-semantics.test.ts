// Pins how the controller MERGES the cloud block, which is the assumption the
// admin save's omit-or-send decision rests on.
//
// `settings.ts` handles each field independently —
//
//   if (c.model !== undefined) { ... next.tts.cloud.model = v; }
//   if (c.voice !== undefined) { ... next.tts.cloud.voice  = v; }
//
// — so an ABSENT key KEEPS whatever is stored. The web half of this contract
// lives in `web/tests/cloud-save-payload.test.ts`, and it can only be evaluated
// correctly if this behaviour is true. Nothing on the controller side pinned it.
//
// That is not a hypothetical gap. The first version of the web fix omitted a
// blank model and voice UNCONDITIONALLY, to stop a stale form 400-ing the whole
// save — and because omission means "retain", switching OpenAI -> Fish with a
// blank voice then wrote `provider: 'fish-audio'` while inheriting voice `alloy`.
// Nothing rejected it: the configuration is wrong, but not wrong in isolation.
// A station with a configured Fish key saved "successfully" and would have voiced
// every segment with an OpenAI id.
//
// So: omitted fields are retained (asserted here), and the web sends them
// VERBATIM on a real transition so the controller can reject them (asserted in
// both files). If the merge semantics ever change, this file fails first.
//
// STATE_DIR is redirected at a throwaway dir BEFORE the first import, so
// settings.load()/update() touch nothing real — hence the dynamic imports.
// Scenarios rewrite settings.json and reset the store cache between loads.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'subwave-cloudmerge-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const store = await import('../src/settings/store.js');

const SETTINGS_PATH = join(root, 'settings.json');

/** Seed a stored configuration and reload, the way a real station boots. */
async function seed(ttsCloud: Record<string, unknown>) {
  writeFileSync(SETTINGS_PATH, JSON.stringify({ tts: { cloud: ttsCloud } }));
  store.setCache(null);
  await settings.load();
}

async function patch(ttsCloud: Record<string, unknown>) {
  await settings.update({ tts: { cloud: ttsCloud } } as never);
  return settings.get().tts.cloud;
}

try {
  await seed({
    enabled: true, provider: 'openai', model: 'gpt-4o-mini-tts', voice: 'alloy',
  });

  await test('an omitted cloud field is RETAINED, not cleared', async () => {
    await patch({ provider: 'fish-audio' });

    const after = settings.get().tts.cloud;
    assert.equal(after.provider, 'fish-audio', 'the provider did move');
    assert.equal(after.model, 'gpt-4o-mini-tts',
      'omitting model KEEPS the openai model — why a transition must send it');
    assert.equal(after.voice, 'alloy',
      'omitting voice KEEPS the openai voice — why a transition must send it');
  });

  await test('a transition that sends a blank voice is REJECTED, not completed', async () => {
    await seed({
      enabled: true, provider: 'openai', model: 'gpt-4o-mini-tts', voice: 'alloy',
    });
    await assert.rejects(
      () => patch({ provider: 'fish-audio', voice: '' }),
      /tts\.cloud\.voice must be 1-100 chars/,
      'an incomplete transition must be rejected loudly rather than inheriting openai voice ids',
    );
    const after = settings.get().tts.cloud;
    assert.equal(after.provider, 'openai', 'a rejected save changes nothing');
    assert.equal(after.voice, 'alloy');
  });

  await test('a blank model is rejected for EVERY provider, transition or not', async () => {
    // Unconditional, which is exactly what makes omission worthwhile on a
    // same-provider save. Pinned per provider so a future provider that does
    // accept a blank becomes a deliberate change rather than an accident.
    await seed({
      enabled: true, provider: 'openai', model: 'gpt-4o-mini-tts', voice: 'alloy',
    });
    for (const provider of ['openai', 'elevenlabs', 'fish-audio', 'openai-compatible']) {
      await assert.rejects(
        () => patch({ provider, model: '' }),
        /tts\.cloud\.model must be 1-100 chars/,
        `${provider} must reject a blank model`,
      );
    }
  });

  await test('openai-compatible is the one provider that accepts a blank voice', async () => {
    await seed({
      enabled: true, provider: 'openai', model: 'gpt-4o-mini-tts', voice: 'alloy',
    });
    const after = await patch({
      provider: 'openai-compatible', baseUrl: 'https://example.test/v1', model: 'local', voice: '',
    });
    assert.equal(after.provider, 'openai-compatible');
    assert.equal(after.voice, '', 'a compat server may take its own default voice');
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}
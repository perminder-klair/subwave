// Backup restore must not delete the stored inline LLM API keys (issue #1351).
//
// `settings.llm.apiKey` is a legacy WRITE-ONLY channel: load() hardcodes it to
// '' because the real store is the per-provider `llm.keys` map (#657). So
// getRedacted()'s `s.llm?.apiKey ? 'set' : ''` could never emit the sentinel and
// the backup always carried `llm.apiKey: ""` — which applyInlineKey() reads as
// "clear this provider's key". Restoring a backup therefore deleted the key for
// whichever provider was the primary leg, and for whichever was the fallback,
// while every other provider's key (and every other secret in the file)
// survived. The station came back up pointing at a provider whose key had just
// been deleted, and failed auth on the first call with nothing in the logs.
//
// A COLD LOAD is load-bearing here, exactly as in llm-repeat-penalty.test.ts: an
// in-process assertion passes on the broken code, because the bug needs load()'s
// composition to have blanked llm.apiKey first.
//
// No credentials and no network — everything runs against a throwaway STATE_DIR.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// STATE_DIR is redirected at a throwaway dir BEFORE the first import of
// anything config-derived (same pattern as scripts/llm-repeat-penalty.test.ts).
const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-llm-key-backup-'));
process.env.STATE_DIR = stateRoot;

const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');

const SETTINGS_PATH = path.join(stateRoot, 'settings.json');

// Three providers with a key on file; two of them are the legs. openrouter is
// the control — it is neither leg, and its key was never at risk.
const THREE_KEYS = {
  openrouter: 'sk-openrouter-CONTROL',
  openai: 'sk-openai-PRIMARY',
  anthropic: 'sk-anthropic-FALLBACK',
};

// Load a hand-written settings.json the way a controller restart would.
async function coldLoad(llm: Record<string, unknown>) {
  writeFileSync(SETTINGS_PATH, JSON.stringify({ llm }));
  setCache(null);
  await settings.load();
  return settings.get().llm;
}

async function coldLoadThreeKeys() {
  return coldLoad({
    provider: 'openai',
    model: 'gpt-4o-mini',
    keys: { ...THREE_KEYS },
    fallback: { enabled: true, provider: 'anthropic', model: 'claude-sonnet-4-5' },
  });
}

// Exactly what routes/backup.ts:99 writes into the zip and :218 replays through
// update() — the JSON round trip included, since that is what a real restore
// hands back.
async function roundTripThroughBackup() {
  const backup = JSON.parse(JSON.stringify(settings.getRedacted()));
  await settings.update(backup);
  return settings.get().llm.keys;
}

test('the exported backup masks the legacy key field rather than blanking it', async () => {
  const llm = await coldLoadThreeKeys();
  // The premise: load() blanks the legacy field on both legs, always.
  assert.equal(llm.apiKey, '', 'legacy primary slot is write-only');
  assert.equal(llm.fallback.apiKey, '', 'legacy fallback slot is write-only');

  const redacted = settings.getRedacted();
  // Masked against the leg's RESOLVED key (keys[provider]) — the secret the
  // field is a channel for — not against the always-empty field itself.
  assert.equal(redacted.llm.apiKey, 'set', 'primary leg has a key on file');
  assert.equal(redacted.llm.fallback.apiKey, 'set', 'fallback leg has a key on file');
  // The map itself was already redacted correctly; pinned so it stays that way.
  assert.deepEqual(redacted.llm.keys, { openrouter: 'set', openai: 'set', anthropic: 'set' });
  // And no real key ever leaves the box.
  const wire = JSON.stringify(redacted);
  for (const v of Object.values(THREE_KEYS)) assert.ok(!wire.includes(v), `${v} must not be exported`);
});

test('a backup round trip keeps every stored provider key', async () => {
  await coldLoadThreeKeys();
  assert.deepEqual(await roundTripThroughBackup(), THREE_KEYS);

  // And it still holds after the restart the restore prompts for — the restore
  // writes settings.json, so a key that survives in memory but not on disk is
  // the same outage one boot later.
  setCache(null);
  await settings.load();
  assert.deepEqual(settings.get().llm.keys, THREE_KEYS, 'and survives the restart');
});

test('a leg whose provider has no key on file redacts to empty, and restores as a no-op', async () => {
  // ollama takes no key: the primary leg's masked field must not claim one.
  await coldLoad({
    provider: 'ollama',
    model: 'qwen3',
    keys: { ...THREE_KEYS },
    fallback: { enabled: true, provider: 'anthropic', model: 'claude-sonnet-4-5' },
  });
  const redacted = settings.getRedacted();
  assert.equal(redacted.llm.apiKey, '', 'no ollama key on file');
  assert.equal(redacted.llm.fallback.apiKey, 'set');

  // '' still means "clear this provider's key" — it just clears nothing here.
  assert.deepEqual(await roundTripThroughBackup(), THREE_KEYS);
});

test("'' still clears a key when an operator really sends one", async () => {
  // The sentinel semantics are deliberate and stay intact: the fix is that the
  // redaction layer stops emitting '' unconditionally, not that '' stops
  // clearing. PUT /settings is the only affordance for dropping an inline key.
  await coldLoadThreeKeys();
  await settings.update({ llm: { apiKey: '' } } as never);
  assert.deepEqual(settings.get().llm.keys, {
    openrouter: THREE_KEYS.openrouter,
    anthropic: THREE_KEYS.anthropic,
  }, 'the primary leg key is cleared, the others are untouched');

  // Same for the fallback leg, routed by ITS provider.
  await coldLoadThreeKeys();
  await settings.update({ llm: { fallback: { apiKey: '' } } } as never);
  assert.deepEqual(settings.get().llm.keys, {
    openrouter: THREE_KEYS.openrouter,
    openai: THREE_KEYS.openai,
  }, 'the fallback leg key is cleared, the others are untouched');
});

test('an llm patch that omits apiKey leaves every key alone', async () => {
  // The invariant every non-key-bearing caller relies on — the admin LLM panel
  // omits the field unless the operator typed one, and since #1351 so does the
  // onboarding wizard, which used to send apiKey: '' on every re-run and
  // deleted the primary provider's key with it.
  await coldLoadThreeKeys();
  await settings.update({
    llm: { provider: 'openai', model: 'gpt-4o', baseUrl: '', ollamaUrl: 'http://ollama:11434' },
  } as never);
  assert.deepEqual(settings.get().llm.keys, THREE_KEYS);
});

test('the other redacted secrets keep round-tripping', async () => {
  // Scope check from the issue: llm was the only field that lost its secret.
  // These already worked; pinned so the fix cannot quietly change the shape of
  // the sentinel for anyone else reading it.
  await coldLoadThreeKeys();
  await settings.update({
    tts: { cloud: { apiKey: 'sk-tts' } },
    search: { apiKey: 'sk-search' },
    embedding: { apiKey: 'sk-embed' },
    scrobble: { lastfm: { apiKey: 'sk-lastfm' }, listenbrainz: { userToken: 'tok-lb' } },
    privacy: { password: 'hunter2' },
  } as never);

  await roundTripThroughBackup();
  const s = settings.get();
  assert.equal(s.tts.cloud.apiKey, 'sk-tts');
  assert.equal(s.search.apiKey, 'sk-search');
  assert.equal(s.embedding.apiKey, 'sk-embed');
  assert.equal(s.scrobble.lastfm.apiKey, 'sk-lastfm');
  assert.equal(s.scrobble.listenbrainz.userToken, 'tok-lb');
  assert.equal(s.privacy.password, 'hunter2');
});

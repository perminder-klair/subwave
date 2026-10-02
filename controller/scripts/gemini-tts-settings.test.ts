// The `tts.gemini` station block: validation, round-trip, and the upgrade path.
//
// Split from gemini-tts.test.ts on purpose. settings.js captures SETTINGS_PATH at
// import time and caches what it loads, so a file that both asserts on settings
// and imports modules that pull settings in transitively ends up testing against
// whatever loaded first. This file owns a temp STATE_DIR and nothing else, the
// same shape archive-retention.test.ts uses.
//
// Run: `npm test -- gemini-tts-settings`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-gemini-tts-settings-'));
process.env.STATE_DIR = root;
process.on('exit', () => rmSync(root, { recursive: true, force: true }));

const settings = await import('../src/settings.js');
const store = await import('../src/settings/store.js');

async function fresh() {
  store.setCache(null);
  await settings.load();
}

test('a fresh install gets the engine defaults', async () => {
  await fresh();
  // Empty model = "walk the engine's fallback chain", which is the upgrade-safe
  // default. Pinning a model at install time would freeze the chain at whatever
  // happened to be newest today.
  assert.equal(settings.get().tts?.gemini?.model, '');
  assert.equal(settings.get().tts?.gemini?.voice, 'Puck');
});

test('a model or voice Google does not accept is rejected at save time', async () => {
  await fresh();
  // These must fail HERE, with a form error. Left to speak time they become a 400
  // from inside the request, and the operator reads a stack trace instead.
  await assert.rejects(
    () => settings.update({ tts: { gemini: { model: 'gemini-nope-tts' } } }),
    /tts\.gemini\.model must be one of/,
  );
  // Rejected because the engine sends a speech annotation this model refuses —
  // it synthesises audio through generateContent but would 400 on every render.
  await assert.rejects(
    () => settings.update({ tts: { gemini: { model: 'gemini-2.5-pro-preview-tts' } } }),
    /tts\.gemini\.model must be one of/,
  );
  await assert.rejects(
    () => settings.update({ tts: { gemini: { voice: 'NotAVoice' } } }),
    /tts\.gemini\.voice must be one of/,
  );
  // A blank voice is not a voice — the engine has no voice to fall back to.
  await assert.rejects(
    () => settings.update({ tts: { gemini: { voice: '   ' } } }),
    /tts\.gemini\.voice must not be blank/,
  );
});

test('the real choices round-trip', async () => {
  await fresh();
  await settings.update({ tts: { gemini: { model: '', voice: 'Kore' } } });
  assert.equal(settings.get().tts?.gemini?.voice, 'Kore');
  assert.equal(settings.get().tts?.gemini?.model, '', 'a blank model is a real choice');
  await settings.update({ tts: { gemini: { model: 'gemini-3.8-flash-tts' } } });
  assert.equal(settings.get().tts?.gemini?.model, 'gemini-3.8-flash-tts');
  // And it survives a reload, so it is actually persisted rather than cached.
  await fresh();
  assert.equal(settings.get().tts?.gemini?.model, 'gemini-3.8-flash-tts');
  assert.equal(settings.get().tts?.gemini?.voice, 'Kore');
});

test('the station pick is a FLOOR under the persona, not a lock', async () => {
  await fresh();
  await settings.update({ tts: { gemini: { model: 'gemini-3.8-flash-tts', voice: 'Kore' } } });
  const { stationGeminiPick } = await import('../src/audio/tts.js');

  // A persona that names a voice still wins...
  assert.equal(stationGeminiPick({}, { engine: 'gemini', voice: 'Puck' }).voice, 'Puck');
  // ...and one that leaves it blank inherits the station default. Without that
  // fallback the panel's "default voice" does nothing for exactly the personas
  // that leave it alone, which is most of them.
  assert.equal(stationGeminiPick({}, { engine: 'gemini', voice: '' }).voice, 'Kore');
  assert.equal(stationGeminiPick({}, null).voice, 'Kore');
  assert.equal(stationGeminiPick({}, { engine: 'cloud', voice: 'ElevenLabs' }).voice, 'Kore',
    "another engine's voice must not leak into a gemini render");
  assert.equal(stationGeminiPick({}, {}).model, 'gemini-3.8-flash-tts');

  // The admin preview's UNSAVED model outranks the saved one, or "Play sample"
  // auditions last week's model instead of the one in the dropdown.
  assert.equal(
    stationGeminiPick({ geminiModel: 'gemini-3.8-flash-lite-tts' }, null).model,
    'gemini-3.8-flash-lite-tts',
  );
  assert.equal(
    stationGeminiPick({ geminiModel: '   ' }, null).model,
    'gemini-3.8-flash-tts',
    'a blank preview model is not a choice — fall through to the saved one',
  );

  // Both callers must resolve through the SAME helper, or the exchange and the
  // single-speaker path drift apart on which voice a station actually uses.
  const fs = await import('node:fs');
  const tts = fs.readFileSync(new URL('../src/audio/tts.ts', import.meta.url), 'utf8');
  const uses = (tts.match(/stationGeminiPick\(/g) || []).length;
  assert.equal(uses, 4,
    'the definition plus three call sites (single-speaker, exchange voice, exchange model) — '
    + 'a fourth copy of this precedence is the bug this extraction exists to prevent');
  assert.match(tts, /gemini\.speakMulti\(geminiLines, \{ outPath, model \}\)/,
    'an exchange must honour the operator\'s chosen model too');
});

test('the pronunciation note is station-owned, empty by default, and editable', async () => {
  await fresh();
  // Nobody inherits another operator's regional pronunciation. A station that has
  // never touched it renders exactly as it did before the field existed.
  assert.equal(settings.get().tts?.gemini?.pronunciation, '');

  // Free text, so NO vocabulary validation — any grammar is legitimate. Length
  // is the only bound, and it fails HERE with a form error rather than silently
  // truncating a note the operator deliberately wrote.
  const note = 'Sook rhymes with look; Launceston sounds like LON-sess-tun';
  await settings.update({ tts: { gemini: { pronunciation: note } } });
  assert.equal(settings.get().tts?.gemini?.pronunciation, note);
  await assert.rejects(
    () => settings.update({ tts: { gemini: { pronunciation: 'x'.repeat(301) } } }),
    /tts\.gemini\.pronunciation must be at most 300 characters/,
  );

  // Round-trips through a reload — it is persisted, not just cached.
  await fresh();
  assert.equal(settings.get().tts?.gemini?.pronunciation, note);
  // Clearing it is a real choice: '' must survive rather than be treated as blank.
  await settings.update({ tts: { gemini: { pronunciation: '' } } });
  assert.equal(settings.get().tts?.gemini?.pronunciation, '');
});

test('the web field ceiling agrees with the engine and the save path', async () => {
  const fs = await import('node:fs');
  // Stated once per package (the web package cannot import controller/src), so
  // the two can drift. A drift would make the admin Textarea stop accepting
  // input at a different length from the save path rejecting it.
  const engine = fs.readFileSync(new URL('../src/audio/gemini.ts', import.meta.url), 'utf8');
  const web = fs.readFileSync(
    new URL('../../web/lib/geminiLimits.ts', import.meta.url), 'utf8');
  const pick = (src: string) => Number(/GEMINI_PRONUNCIATION_MAX\s*=\s*(\d+)/.exec(src)?.[1]);
  assert.equal(pick(engine), 300, 'the engine must still declare the bound');
  assert.equal(pick(web), pick(engine), 'the web copy must match the engine');
  // And the save path must validate against the SAME number, not a literal.
  const settingsSrc = fs.readFileSync(new URL('../src/settings.ts', import.meta.url), 'utf8');
  assert.match(settingsSrc, /pronunciation must be at most \$\{GEMINI_PRONUNCIATION_MAX\}/,
    'the save path must reject against the imported constant');
});

test('a settings.json predating the block loads at the defaults', async () => {
  // The upgrade has to be a no-op: an install that never touched this block must
  // come up with a working voice, not an undefined one the dispatcher trips over.
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ tts: { defaultEngine: 'gemini' } }));
  await fresh();
  assert.equal(settings.get().tts?.gemini?.voice, 'Puck');
  assert.equal(settings.get().tts?.gemini?.model, '');
  assert.equal(settings.get().tts?.gemini?.pronunciation, '',
    'an install that predates the field must come up with none, not undefined');
  assert.equal(settings.get().tts?.defaultEngine, 'gemini', 'the rest of tts survives');
});

test('a junk stored value is repaired, not propagated', async () => {
  writeFileSync(join(root, 'settings.json'), JSON.stringify({
    tts: { gemini: { model: 42, voice: { nested: true }, pronunciation: { nested: true } } },
  }));
  await fresh();
  assert.equal(settings.get().tts?.gemini?.model, '');
  assert.equal(settings.get().tts?.gemini?.voice, 'Puck');
  assert.equal(settings.get().tts?.gemini?.pronunciation, '',
    'a non-string note is repaired to empty, never propagated');
});

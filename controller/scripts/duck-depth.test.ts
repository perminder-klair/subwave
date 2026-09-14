// settings.ducking — the two `smooth_add` depths radio.liq used to carry as the
// literals `p={0.22}` (heavy, say.txt) and `p={0.30}` (light, intro.txt).
// FR 6 of #1485.
//
// `p` is the fraction of the music LEFT UP under a voice channel, so it reads
// backwards from a dB cut: smaller is a DEEPER duck, 1 is no duck and 0 mutes
// the music while the DJ talks. That inversion is why the bounds matter in both
// directions — a stored 3.0 would reach the mixer as a music BOOST under the
// voice, and there is no operator-visible symptom short of listening.
//
// Three halves are pinned, because each fails silently on its own:
//
//   1. The DEFAULT is byte-identical to the literals radio.liq shipped. An
//      upgrade must not move the duck, so the absent-key case IS the upgrade
//      case and is checked against the same numbers the mixer defaults to.
//
//   2. The setting survives a controller restart. settings.load() composes each
//      block explicitly rather than spreading DEFAULTS, so a field missing from
//      load() saves fine, works for the rest of that process, and then vanishes
//      on the next cold start — after which the handoff file carries the default
//      and the operator's duck quietly reverts. Hence a cold-load round trip: an
//      in-process assertion passes on the broken code. (Same class as
//      tts.cloud.compatParams #1317 and llm.repeatPenalty #918.)
//
//   3. The clamp holds on BOTH paths, from ONE constant. The save path refuses
//      (the operator typed it) and the load path repairs (a hand-edited
//      settings.json must not wedge boot) — the split every settings key here
//      follows — and a hand-copied bound in either is how the two drift.
//
// Plus the writer and the restart flag: the files are read ONCE at mixer
// startup, so a save that doesn't flag a restart is a save the listener never
// hears, and an idempotent save that DOES flag one drags a restart banner onto
// every unrelated settings write.
//
// No containers and no network.
//
// Run: `npm test -- duck-depth`.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// STATE_DIR is redirected at a throwaway dir BEFORE the first import of
// anything config-derived (same pattern as scripts/max-listeners.test.ts).
const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-duck-depth-'));
process.env.STATE_DIR = stateRoot;

const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { DEFAULTS } = await import('../src/settings/defaults.js');
const { LIQ_DUCK_VOICE_PATH, LIQ_DUCK_INTRO_PATH } = await import('../src/settings/liquidsoap.js');
const { DUCK_DEPTH_BOUNDS, duckingPatchSchema } = await import('../src/schemas/settings.js');

const SETTINGS_PATH = path.join(stateRoot, 'settings.json');

// Load a hand-written settings.json the way a controller restart would.
async function coldLoad(ducking: Record<string, unknown> | undefined) {
  writeFileSync(SETTINGS_PATH, JSON.stringify(ducking === undefined ? {} : { ducking }));
  setCache(null);
  await settings.load();
  return settings.get().ducking;
}

// ---------------------------------------------------------------------------
// 1. The default is the depth radio.liq shipped
// ---------------------------------------------------------------------------

test('an absent block coerces to the literals radio.liq carried', async () => {
  const d = await coldLoad(undefined);
  // Byte-identical audio on upgrade is the whole point: these are the two
  // numbers that were `p={0.22}` / `p={0.30}` in the source.
  assert.equal(d.voice, 0.22);
  assert.equal(d.intro, 0.3);
  assert.equal(DEFAULTS.ducking.voice, 0.22);
  assert.equal(DEFAULTS.ducking.intro, 0.3);
});

test('a half-filled block keeps the shipped depth for the missing side', async () => {
  // A backup from a build that only knew one of them, or a hand edit. The
  // sibling must not come back undefined — that reaches the mixer as the
  // string "undefined" and float_of_string falls back, which happens to be
  // right and would hide the bug on the day the fallback changes.
  const d = await coldLoad({ voice: 0.1 });
  assert.equal(d.voice, 0.1);
  assert.equal(d.intro, DEFAULTS.ducking.intro);
});

// ---------------------------------------------------------------------------
// 2. A configured depth survives a controller restart
// ---------------------------------------------------------------------------

test('a configured pair survives a cold load', async () => {
  const d = await coldLoad({ voice: 0.05, intro: 0.55 });
  assert.equal(d.voice, 0.05);
  assert.equal(d.intro, 0.55);
});

test('the edges of the range are legal, both ends', async () => {
  // 0 = the music is muted under the voice (not the music-PAUSED interlude,
  // which is out of scope) and 1 = no duck at all. Both are real operator
  // tastes, so neither may be repaired away.
  const d = await coldLoad({ voice: DUCK_DEPTH_BOUNDS.min, intro: DUCK_DEPTH_BOUNDS.max });
  assert.equal(d.voice, 0);
  assert.equal(d.intro, 1);
});

// ---------------------------------------------------------------------------
// 3. The clamp: refuse on save, repair on load, one constant
// ---------------------------------------------------------------------------

test('the load path repairs anything outside the shared bounds', async () => {
  for (const bad of [-0.1, 1.01, 3, Number.NaN, Number.POSITIVE_INFINITY, '0.5', null, {}, []]) {
    const d = await coldLoad({ voice: bad, intro: bad });
    assert.equal(
      d.voice,
      DEFAULTS.ducking.voice,
      `stored ducking.voice=${JSON.stringify(bad)} should fall back`,
    );
    assert.equal(
      d.intro,
      DEFAULTS.ducking.intro,
      `stored ducking.intro=${JSON.stringify(bad)} should fall back`,
    );
  }
});

test('the save path refuses what the load path repairs', () => {
  assert.equal(duckingPatchSchema.safeParse({ voice: 0.4, intro: 0.6 }).success, true);
  for (const bad of [-0.1, 1.01, 3, 'loud']) {
    for (const field of ['voice', 'intro'] as const) {
      const r = duckingPatchSchema.safeParse({ [field]: bad });
      assert.equal(
        r.success,
        false,
        `ducking.${field}=${JSON.stringify(bad)} should be refused`,
      );
    }
  }
});

test('the refusal message names its own dotted field and the shared bounds', () => {
  const r = duckingPatchSchema.safeParse({ voice: 4 });
  assert.equal(r.success, false);
  // The flat `error` string is the zod message verbatim (see the patch
  // registry), so it has to name the field itself or the operator's toast
  // reads as a bare constraint.
  assert.equal(
    r.error!.issues[0].message,
    `ducking.voice must be number in [${DUCK_DEPTH_BOUNDS.min}, ${DUCK_DEPTH_BOUNDS.max}]`,
  );
});

test('a non-object block is a no-op, not an error', async () => {
  // settingsBlockOf's leniency: `patch.ducking || {}` no-ops on anything that
  // is not an object, and a backup restore is what meets that.
  await coldLoad(undefined);
  await settings.update({ ducking: null });
  assert.equal(settings.get().ducking.voice, DEFAULTS.ducking.voice);
});

// ---------------------------------------------------------------------------
// The writer and the restart flag
// ---------------------------------------------------------------------------

test('a save writes both handoff files radio.liq reads', async () => {
  await coldLoad(undefined);
  await settings.update({ ducking: { voice: 0.15, intro: 0.45 } });
  assert.ok(existsSync(LIQ_DUCK_VOICE_PATH), 'liquidsoap_duck_voice.txt not written');
  assert.ok(existsSync(LIQ_DUCK_INTRO_PATH), 'liquidsoap_duck_intro.txt not written');
  assert.equal(readFileSync(LIQ_DUCK_VOICE_PATH, 'utf8'), '0.15');
  assert.equal(readFileSync(LIQ_DUCK_INTRO_PATH, 'utf8'), '0.45');
});

test('the default station writes the shipped depths, not an empty file', async () => {
  // The upgrade path: a station that never touches this setting still has both
  // files rewritten on its next unrelated save, and float_of_string must find
  // the literals rather than '' or 'undefined'.
  await coldLoad(undefined);
  await settings.update({ station: 'SUB/WAVE test' });
  assert.equal(readFileSync(LIQ_DUCK_VOICE_PATH, 'utf8'), '0.22');
  assert.equal(readFileSync(LIQ_DUCK_INTRO_PATH, 'utf8'), '0.3');
});

test('changing a depth asks for a mixer restart', async () => {
  await coldLoad({ voice: 0.15, intro: 0.45 });
  // Both files are read ONCE at mixer startup, so a change that does not
  // bounce the container is a change the listener never hears.
  const changed = await settings.update({ ducking: { voice: 0.2, intro: 0.45 } });
  assert.equal(changed.requiresRestart, true);
  // …and an idempotent save must NOT: the panel posts the whole block, so
  // without per-field change gating every save in the Danger section would
  // raise a restart banner.
  const same = await settings.update({ ducking: { voice: 0.2, intro: 0.45 } });
  assert.equal(same.requiresRestart, false);
});

test('the intro side flags a restart on its own', async () => {
  await coldLoad({ voice: 0.2, intro: 0.45 });
  const changed = await settings.update({ ducking: { intro: 0.5 } });
  assert.equal(changed.requiresRestart, true);
  assert.equal(settings.get().ducking.voice, 0.2);
  assert.equal(settings.get().ducking.intro, 0.5);
});

// ---------------------------------------------------------------------------
// The route inventory
// ---------------------------------------------------------------------------

test('the key is in the patch inventory, so POST /settings accepts it', async () => {
  const { SETTINGS_PATCH_KEYS, validateSettingsPatch, SETTINGS_PATCH_SHAPE_ONLY } =
    await import('../src/settings/patch-registry.js');
  // A key absent from this list is rejected at the route — the panel would
  // post it and get a 400 naming an unknown key, with everything else saving.
  assert.ok(SETTINGS_PATCH_KEYS.includes('ducking'));
  assert.equal(
    validateSettingsPatch({ ducking: { voice: 0.3 } }, SETTINGS_PATCH_SHAPE_ONLY),
    null,
  );
  const bad = validateSettingsPatch({ ducking: { voice: 9 } }, SETTINGS_PATCH_SHAPE_ONLY);
  assert.ok(bad, 'an out-of-range depth should be refused at the route');
  // The fieldErrors channel is the point of registering the key: the admin
  // input can only highlight itself if the error is keyed by its dotted path.
  assert.ok(bad!.fieldErrors?.['ducking.voice']);
});

// Imaging moved onto a shared zod schema (controller/src/schemas/imaging.ts),
// mirrored into web/lib/schemas.generated.ts. Sound effects, beds, jingles and
// clone voices are four routes but ONE contract wearing four hats — these tests
// pin that the contract really is shared, that the per-kind duration bands
// agree with the modules that enforce them at render time, and the two traps
// the conversion notes call out (a .catch()ed description, a UI band wider
// than the route's).
//
// Run: npx tsx scripts/imaging-schema.test.ts (auto-discovered by npm test).
import assert from 'node:assert/strict';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-imaging-schema-'));

const {
  BED_GEN_MAX_SEC,
  BED_MIN_SEC,
  IMAGING_DESCRIPTION_MAX,
  IMAGING_NAME_MAX,
  IMAGING_PROMPT_MAX,
  JINGLE_TEXT_MAX,
  SFX_MAX_SEC,
  bedCreateSchema,
  imagingImportSchema,
  jingleCreateSchema,
  jingleImportSchema,
  sfxCreateSchema,
  voiceImportSchema,
} = await import('../src/schemas/imaging.js');

// --- one contract, four hats -------------------------------------------------

test('name and description run the same rule on every import body', () => {
  const longName = 'x'.repeat(IMAGING_NAME_MAX + 1);
  const longDesc = 'y'.repeat(IMAGING_DESCRIPTION_MAX + 1);
  for (const schema of [imagingImportSchema, voiceImportSchema]) {
    assert.equal(schema.safeParse({}).success, false);
    assert.equal(schema.safeParse({ name: '   ' }).success, false);
    assert.equal(schema.safeParse({ name: longName }).success, false);
    assert.equal(schema.safeParse({ name: 'ok' }).success, true);
  }
  assert.equal(imagingImportSchema.safeParse({ name: 'ok', description: longDesc }).success, false);
});

test('a too-long description is REFUSED, never silently blanked', () => {
  // The trap: an .optional() carrying a .max() must not be .catch()ed — a
  // catch cannot tell a wrong type from a too-long value, so 300 written
  // characters silently became ''.
  const r = sfxCreateSchema.safeParse({
    name: 'tape-stop',
    prompt: 'a tape stop',
    description: 'z'.repeat(IMAGING_DESCRIPTION_MAX + 100),
  });
  assert.equal(r.success, false);
});

test('explicit null reads as absent on optional fields', () => {
  const r = sfxCreateSchema.parse({
    name: 'tape-stop', prompt: 'a tape stop', description: null, durationSec: null,
  });
  assert.equal(r.description, '');
  assert.equal(r.durationSec, undefined);
});

// --- generation bodies -------------------------------------------------------

test('sfx create refuses what the route used to hand-check', () => {
  assert.equal(sfxCreateSchema.safeParse({ prompt: 'p' }).success, false);
  assert.equal(sfxCreateSchema.safeParse({ name: 'n' }).success, false);
  assert.equal(
    sfxCreateSchema.safeParse({ name: 'n', prompt: 'p'.repeat(IMAGING_PROMPT_MAX + 1) }).success,
    false,
  );
  const ok = sfxCreateSchema.parse({ name: ' n ', prompt: ' p ', durationSec: '4.5' });
  assert.equal(ok.name, 'n');
  assert.equal(ok.durationSec, 4.5);
});

test('jingle text is required and capped', () => {
  assert.equal(jingleCreateSchema.safeParse({}).success, false);
  assert.equal(jingleCreateSchema.safeParse({ text: '  ' }).success, false);
  assert.equal(
    jingleCreateSchema.safeParse({ text: 'x'.repeat(JINGLE_TEXT_MAX + 1) }).success,
    false,
  );
  assert.equal(jingleCreateSchema.parse({ text: ' hi ' }).text, 'hi');
  // The import label is optional, and '' means "use the filename".
  assert.equal(jingleImportSchema.parse({}).label, undefined);
  assert.equal(jingleImportSchema.parse({ label: '  ' }).label, undefined);
});

// --- the duration bands ------------------------------------------------------

test('the sfx band is the ROUTE cap, not the generator range', async () => {
  // The drift this kills: the admin input carried min 0.5 / max 22 — the
  // ElevenLabs generator's own range — while the route capped at 10, so the UI
  // invited a request it would reject.
  assert.equal(sfxCreateSchema.safeParse({ name: 'n', prompt: 'p', durationSec: 12 }).success, false);
  assert.equal(sfxCreateSchema.safeParse({ name: 'n', prompt: 'p', durationSec: 0.2 }).success, false);
  assert.equal(sfxCreateSchema.safeParse({ name: 'n', prompt: 'p', durationSec: SFX_MAX_SEC }).success, true);
  // And the module that enforces the same cap at import time reads the SAME figure.
  const sfx = await import('../src/broadcast/sfx.js');
  assert.equal(sfx.MAX_DURATION_SEC, SFX_MAX_SEC);
});

test('the bed band spans the floor beds.ts enforces to the ceiling bed-gen.ts does', async () => {
  assert.equal(bedCreateSchema.safeParse({ name: 'n', prompt: 'p', durationSec: BED_MIN_SEC - 1 }).success, false);
  assert.equal(bedCreateSchema.safeParse({ name: 'n', prompt: 'p', durationSec: BED_GEN_MAX_SEC + 1 }).success, false);
  assert.equal(bedCreateSchema.safeParse({ name: 'n', prompt: 'p', durationSec: 60 }).success, true);
  const beds = await import('../src/broadcast/beds.js');
  const bedGen = await import('../src/audio/bed-gen.js');
  assert.equal(beds.MIN_DURATION_SEC, BED_MIN_SEC);
  assert.equal(bedGen.BED_GEN_MAX_SEC, BED_GEN_MAX_SEC);
});

test('an absent duration means "let the generator decide"', () => {
  for (const v of [undefined, '', null]) {
    const r = bedCreateSchema.safeParse({ name: 'n', prompt: 'p', durationSec: v });
    assert.equal(r.success, true, JSON.stringify(v));
    assert.equal(r.data!.durationSec, undefined);
  }
});

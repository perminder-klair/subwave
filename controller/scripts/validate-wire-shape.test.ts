// The route-boundary middleware's WIRE SHAPE — what an admin form actually
// reads off a 400.
//
// scripts/validate-middleware.test.ts covers the two string helpers underneath
// (firstMessage / flattenIssues) and scripts/settings-patch-schema.test.ts
// covers the registry's decisions. This covers the ENVELOPE those arrive in,
// because that envelope is a contract with the browser:
// web/components/admin/SettingsPanel.tsx reads `j.fieldErrors` and hard-codes
// the dotted paths its inline errors key off, and
// web/components/admin/library/BlockRulesCard.tsx does the same for the
// blocklist routes. A change that dropped `fieldErrors`, or rooted its paths
// differently, would leave every one of those inputs silently blank — the
// failure would look like "validation stopped working" and be invisible here
// without this file.
//
// Run: npx tsx scripts/validate-wire-shape.test.ts (auto-discovered by npm test).
import assert from 'node:assert/strict';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-validate-wire-'));

const { validateBody, validateBodyAsync, validateSettingsBody } = await import(
  '../src/middleware/validate.js'
);
const { blockRuleSchema } = await import('../src/schemas/blocklist.js');
const { manualTagSchema } = await import('../src/schemas/library.js');

interface Captured {
  status: number;
  body: { error?: string; fieldErrors?: Record<string, string>; message?: string } | null;
  nexted: boolean;
  reqBody: unknown;
}

async function run(
  mw: (req: never, res: never, next: () => void) => unknown,
  body: unknown,
): Promise<Captured> {
  const captured: Captured = { status: 200, body: null, nexted: false, reqBody: undefined };
  const req = { body } as never;
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(payload: unknown) {
      captured.body = payload as Captured['body'];
      return this;
    },
  } as never;
  await mw(req, res, () => {
    captured.nexted = true;
  });
  captured.reqBody = (req as { body: unknown }).body;
  return captured;
}

// --- the envelope -----------------------------------------------------------

test('a 400 always carries BOTH error and fieldErrors', async () => {
  const r = await run(validateBody(blockRuleSchema), { label: '', field: 'genre', values: ['x'] });
  assert.equal(r.status, 400);
  assert.equal(typeof r.body?.error, 'string');
  assert.ok(r.body!.error!.length > 0);
  assert.equal(typeof r.body?.fieldErrors, 'object');
  assert.equal(r.nexted, false, 'a rejected body must never reach the handler');
});

test('fieldErrors keys are DOTTED paths — react-hook-form setError syntax', async () => {
  const r = await run(validateBody(blockRuleSchema), {
    label: 'ok',
    field: 'genre',
    values: ['ok'],
    season: { from: { month: 99, day: 1 }, to: { month: 1, day: 1 } },
  });
  assert.equal(r.status, 400);
  assert.ok(
    'season.from' in r.body!.fieldErrors!,
    `expected a dotted season path, got ${JSON.stringify(r.body!.fieldErrors)}`,
  );
});

test('a valid body is REPLACED with the parsed value before the handler', async () => {
  const r = await run(validateBody(blockRuleSchema), {
    label: '  Xmas  ',
    field: 'genre',
    values: ['A', 'a', '  '],
  });
  assert.equal(r.nexted, true);
  assert.deepEqual(r.reqBody, {
    label: 'Xmas',
    field: 'genre',
    values: ['A'],
    season: null,
    showIds: [],
  });
});

test("the 'verbatim' posture changes only the flat string, never fieldErrors", async () => {
  const body = { label: '', field: 'genre', values: ['x'] };
  const prefixed = await run(validateBody(blockRuleSchema), body);
  const verbatim = await run(validateBody(blockRuleSchema, { messages: 'verbatim' }), body);
  assert.equal(verbatim.body!.error, 'rule.label is required');
  assert.equal(prefixed.body!.error, 'label: rule.label is required');
  assert.deepEqual(verbatim.body!.fieldErrors, prefixed.body!.fieldErrors);
});

// --- the async variant ------------------------------------------------------

test('validateBodyAsync answers 400 for a bad body and 500 for a bad resolver', async () => {
  const ok = validateBodyAsync(() => manualTagSchema({ moodNames: ['calm'] }), {
    messages: 'verbatim',
  });
  const bad = await run(ok, { id: 't1', moods: ['nope'] });
  assert.equal(bad.status, 400);
  assert.equal(bad.body!.error, 'unknown mood(s): nope');

  // A resolver that throws means the SERVER could not read its own context —
  // that is not the operator's input being wrong, so it is a 500.
  const broken = validateBodyAsync(() => {
    throw new Error('mood cache unavailable');
  });
  const r = await run(broken, { id: 't1', moods: [] });
  assert.equal(r.status, 500);
  assert.equal(r.nexted, false);
});

// --- POST /settings ---------------------------------------------------------

test('validateSettingsBody rejects an unknown top-level key, naming every one', async () => {
  const r = await run(validateSettingsBody(), { nonsense: 1, alsoNonsense: 2, station: 'OK' });
  assert.equal(r.status, 400);
  assert.match(r.body!.error!, /unknown settings keys: /);
  assert.equal(r.body!.fieldErrors!.nonsense, 'not a settings key');
  assert.equal(r.body!.fieldErrors!.alsoNonsense, 'not a settings key');
});

test('a converted key reports at the path SettingsPanel keys its inputs off', async () => {
  // These exact strings are hard-coded in the panel's JSX
  // (<SettingsFieldError path="…" />), so a change here is a change to a
  // contract with the browser — and one nothing else would catch.
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ crossfadeDuration: 999 }, 'crossfadeDuration'],
    [{ maxTrackSeconds: -5 }, 'maxTrackSeconds'],
    [{ stream: { bitrate: 7 } }, 'stream.bitrate'],
    [{ stream: { opusBitrate: 1 } }, 'stream.opusBitrate'],
    [{ stream: { aacBitrate: 1 } }, 'stream.aacBitrate'],
    [{ archive: { retentionDays: -1 } }, 'archive.retentionDays'],
    [{ station: 'x'.repeat(500) }, 'station'],
    [{ stationDescription: 'x'.repeat(5000) }, 'stationDescription'],
    [{ personas: [{ name: '', soul: 'x', frequency: 'moderate' }] }, 'personas.0.name'],
  ];
  for (const [body, path] of cases) {
    const r = await run(validateSettingsBody(), body);
    assert.equal(r.status, 400, `${JSON.stringify(body)} should 400`);
    assert.ok(
      path in r.body!.fieldErrors!,
      `expected fieldErrors["${path}"], got ${JSON.stringify(r.body!.fieldErrors)}`,
    );
  }
});

test('a valid patch passes THROUGH untouched — update() is still the chokepoint', async () => {
  // Unlike validateBody, this middleware does not rewrite req.body: update()
  // re-runs the same schemas as it applies each key, so there is exactly one
  // place that decides what gets stored.
  const body = { station: 'Night Loop' };
  const r = await run(validateSettingsBody(), body);
  assert.equal(r.nexted, true);
  assert.equal(r.reqBody, body);
});

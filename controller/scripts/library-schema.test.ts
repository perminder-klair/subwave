// The never-play blocklist and the manual tagger moved onto shared zod schemas
// (controller/src/schemas/{blocklist,library}.ts), mirrored into
// web/lib/schemas.generated.ts. These tests pin what the conversion promised:
// the STORE's chokepoint (blocklist-rules.validateRulePatch) and the ROUTE
// boundary now run one implementation, and every message stayed byte-identical.
//
// The message half is the sharp end here. Both schemas' messages already name
// their own field ('rule.label is required'), so their routes mount
// validateBody's `messages: 'verbatim'` posture — without it the operator reads
// 'label: rule.label is required'. scripts/blocklist-rules.test.ts keeps the
// MATCHING half; this file covers validation only.
//
// Run: npx tsx scripts/library-schema.test.ts (auto-discovered by npm test).
import assert from 'node:assert/strict';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-library-schema-'));

const {
  BLOCK_TYPES,
  RULE_FIELDS,
  RULE_TEXT_MAX,
  RULE_VALUES_MAX,
  blockEntrySchema,
  blockRuleSchema,
  normText,
} = await import('../src/schemas/blocklist.js');
const {
  MANUAL_TAG_ENERGIES,
  MANUAL_TAG_MOODS_MAX,
  manualTagSchema,
} = await import('../src/schemas/library.js');
const rules = await import('../src/music/blocklist-rules.js');
const { validateBody } = await import('../src/middleware/validate.js');

const rule = (o: Record<string, unknown> = {}) => ({
  label: 'Christmas songs',
  field: 'genre',
  values: ['Christmas'],
  ...o,
});

// --- the rule schema --------------------------------------------------------

test('a minimal rule parses and defaults its optional halves', () => {
  const r = blockRuleSchema.parse(rule());
  assert.equal(r.label, 'Christmas songs');
  assert.equal(r.field, 'genre');
  assert.deepEqual(r.values, ['Christmas']);
  assert.equal(r.season, null, 'no season = always blocking');
  assert.deepEqual(r.showIds, [], 'no scope = station-wide');
});

test('label is required, trimmed and capped', () => {
  assert.equal(blockRuleSchema.parse(rule({ label: '  Xmas  ' })).label, 'Xmas');
  assert.equal(blockRuleSchema.safeParse(rule({ label: '' })).success, false);
  assert.equal(blockRuleSchema.safeParse(rule({ label: '   ' })).success, false);
  assert.equal(
    blockRuleSchema.safeParse(rule({ label: 'x'.repeat(RULE_TEXT_MAX + 1) })).success,
    false,
  );
});

test('field must name a real attribute', () => {
  for (const f of RULE_FIELDS) {
    assert.equal(blockRuleSchema.safeParse(rule({ field: f })).success, true);
  }
  assert.equal(blockRuleSchema.safeParse(rule({ field: 'bpm' })).success, false);
  assert.match(
    blockRuleSchema.safeParse(rule({ field: 'bpm' })).error!.issues[0].message,
    /^rule\.field must be one of: /,
  );
});

test('values: blanks drop, duplicates collapse, non-strings REFUSE', () => {
  // The asymmetry is deliberate. A blank or repeated value describes the same
  // rule; a non-string means the operator typed something that is not a value,
  // and silently discarding it would block LESS than the card shows.
  const r = blockRuleSchema.parse(rule({ values: ['Christmas', '  ', 'christmas', 'Xmas'] }));
  assert.deepEqual(r.values, ['Christmas', 'Xmas'], 'dedupe is case-insensitive, casing kept');
  assert.equal(blockRuleSchema.safeParse(rule({ values: ['ok', 42] })).success, false);
  assert.equal(blockRuleSchema.safeParse(rule({ values: [] })).success, false);
  assert.equal(blockRuleSchema.safeParse(rule({ values: ['   '] })).success, false);
  assert.equal(blockRuleSchema.safeParse(rule({ values: 'Christmas' })).success, false);
  assert.equal(
    blockRuleSchema.safeParse(rule({ values: ['x'.repeat(RULE_TEXT_MAX + 1)] })).success,
    false,
  );
  assert.equal(
    blockRuleSchema.safeParse(
      rule({ values: Array.from({ length: RULE_VALUES_MAX + 1 }, (_, i) => `v${i}`) }),
    ).success,
    false,
  );
});

test('normText is what dedupe compares on', () => {
  assert.equal(normText('  Deep   House '), 'deep house');
  assert.equal(normText(null), '');
});

test('a season window may WRAP the year end', () => {
  // Unlike a show's era window, from > to is the feature (Dec 1 → Jan 6), not a
  // backwards range to refuse.
  const r = blockRuleSchema.parse(
    rule({ season: { from: { month: 12, day: 1 }, to: { month: 1, day: 6 } } }),
  );
  assert.deepEqual(r.season, { from: { month: 12, day: 1 }, to: { month: 1, day: 6 } });
});

test('season months and days are range-checked, and numeric strings pass', () => {
  const withSeason = (from: unknown, to: unknown) => blockRuleSchema.safeParse(rule({ season: { from, to } }));
  // <input type=number> posts strings; Number() has always accepted them.
  assert.equal(withSeason({ month: '12', day: '1' }, { month: '1', day: '6' }).success, true);
  assert.equal(withSeason({ month: 13, day: 1 }, { month: 1, day: 6 }).success, false);
  assert.equal(withSeason({ month: 0, day: 1 }, { month: 1, day: 6 }).success, false);
  assert.equal(withSeason({ month: 1, day: 32 }, { month: 1, day: 6 }).success, false);
  assert.equal(withSeason({ month: 1, day: 1.5 }, { month: 1, day: 6 }).success, false);
  assert.match(
    withSeason({ month: 13, day: 1 }, { month: 1, day: 6 }).error!.issues[0].message,
    /^rule\.season\.from\.month must be 1-12$/,
  );
});

test('showIds drops junk rather than refusing (stale ids are inert by design)', () => {
  const r = blockRuleSchema.parse(rule({ showIds: ['s_a', '', 's_a', 42, null, 's_b'] }));
  assert.deepEqual(r.showIds, ['s_a', 's_b']);
  assert.deepEqual(blockRuleSchema.parse(rule({ showIds: null })).showIds, []);
  assert.equal(blockRuleSchema.safeParse(rule({ showIds: 's_a' })).success, false);
});

test('a client-sent id or addedAt is STRIPPED, not honoured', () => {
  // Both are store-owned. z.object drops them before the store ever sees them.
  const r = blockRuleSchema.parse(rule({ id: 'r_forged', addedAt: '1999-01-01' })) as Record<string, unknown>;
  assert.equal('id' in r, false);
  assert.equal('addedAt' in r, false);
});

// --- the store chokepoint and the route agree -------------------------------

test('validateRulePatch is the schema, and throws a readable single line', () => {
  assert.deepEqual(rules.validateRulePatch(rule()), blockRuleSchema.parse(rule()));
  assert.throws(() => rules.validateRulePatch(rule({ label: '' })), /^Error: rule\.label is required$/);
  assert.throws(() => rules.validateRulePatch(null), /rule must be an object/);
  assert.throws(() => rules.validateRulePatch('nope'), /rule must be an object/);
  try {
    rules.validateRulePatch(rule({ values: [] }));
    assert.fail('expected a throw');
  } catch (err) {
    assert.equal((err as Error).message.includes('\n'), false);
  }
});

test('blocklist-rules re-exports the schema constants rather than restating them', () => {
  assert.equal(rules.RULE_TEXT_MAX, RULE_TEXT_MAX);
  assert.equal(rules.RULE_VALUES_MAX, RULE_VALUES_MAX);
  assert.equal(rules.normText, normText);
  assert.deepEqual([...rules.RULE_FIELDS], [...RULE_FIELDS]);
});

// A minimal express-ish harness: run the middleware and capture what it wrote.
function runMiddleware(mw: ReturnType<typeof validateBody>, body: unknown): {
  status: number;
  payload: { error: string; fieldErrors: Record<string, string> } | null;
  nexted: boolean;
  req: { body: unknown };
} {
  let status = 0;
  let payload: { error: string; fieldErrors: Record<string, string> } | null = null;
  let nexted = false;
  const req = { body } as never;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(p: unknown) {
      payload = p as typeof payload;
      return this;
    },
  } as never;
  mw(req, res, () => {
    nexted = true;
  });
  return { status, payload, nexted, req: req as unknown as { body: unknown } };
}

test('the route reports the message VERBATIM, with no doubled location', () => {
  const mw = validateBody(blockRuleSchema, { messages: 'verbatim' });
  const { status, payload } = runMiddleware(mw, rule({ label: '' }));
  assert.equal(status, 400);
  assert.equal(payload!.error, 'rule.label is required', 'not "label: rule.label is required"');
  // fieldErrors still carries the dotted path — that is where a form needs it.
  assert.equal(payload!.fieldErrors.label, 'rule.label is required');
});

test('the default prefixed posture is unchanged for everyone else', () => {
  const { payload } = runMiddleware(validateBody(blockRuleSchema), rule({ label: '' }));
  assert.equal(payload!.error, 'label: rule.label is required');
});

test('the route and the store name the same failure for the same body', () => {
  const bad = rule({ values: ['x'.repeat(RULE_TEXT_MAX + 1)] });
  const { payload } = runMiddleware(validateBody(blockRuleSchema, { messages: 'verbatim' }), bad);
  let storeError = '';
  try {
    rules.validateRulePatch(bad);
  } catch (err) {
    storeError = (err as Error).message;
  }
  assert.equal(payload!.error, storeError);
});

test('a valid body is normalised in place for the handler', () => {
  const mw = validateBody(blockRuleSchema, { messages: 'verbatim' });
  const { nexted, req } = runMiddleware(mw, rule({ label: '  Xmas  ', values: ['A', 'a'] }));
  assert.equal(nexted, true);
  assert.deepEqual(req.body, {
    label: 'Xmas',
    field: 'genre',
    values: ['A'],
    season: null,
    showIds: [],
  });
});

// --- the id-entry body ------------------------------------------------------

test('the entry body accepts both accepted forms and pins the type vocabulary', () => {
  for (const t of BLOCK_TYPES) {
    assert.equal(blockEntrySchema.safeParse({ type: t, trackId: 't1' }).success, true);
  }
  assert.equal(blockEntrySchema.safeParse({ type: 'playlist', trackId: 't1' }).success, false);
  assert.equal(
    blockEntrySchema.safeParse({ type: 'nope' }).error!.issues[0].message,
    "type must be 'track', 'album' or 'artist'",
  );
  // The pre-resolved form.
  const direct = blockEntrySchema.parse({ type: 'artist', id: 'ar1', name: 'Nick Drake' });
  assert.equal(direct.id, 'ar1');
  assert.equal(direct.name, 'Nick Drake');
  // A null snapshot is MEANINGFUL ("unknown") and survives.
  assert.equal(blockEntrySchema.parse({ type: 'track', id: 't1', name: null }).name, null);
  // Blank ids read as absent, so the handler's "trackId or id is required"
  // check still owns that answer (it knows which form was intended).
  assert.equal(blockEntrySchema.parse({ type: 'track', trackId: '' }).trackId, undefined);
});

// --- manual tagging ---------------------------------------------------------

const MOODS = ['calm', 'upbeat', 'melancholy', 'driving'];
const tagBody = (o: Record<string, unknown> = {}) => ({ id: 't1', moods: ['calm'], ...o });

test('a manual tag needs a real id and at most three known moods', () => {
  const schema = manualTagSchema({ moodNames: MOODS });
  assert.equal(schema.parse(tagBody()).id, 't1');
  assert.equal(schema.safeParse(tagBody({ id: '' })).success, false);
  assert.equal(schema.safeParse(tagBody({ id: 42 })).success, false);
  assert.match(schema.safeParse(tagBody({ id: '' })).error!.issues[0].message, /^id is required$/);
  assert.equal(
    schema.safeParse(tagBody({ moods: MOODS.slice(0, MANUAL_TAG_MOODS_MAX + 1) })).success,
    false,
  );
  assert.equal(schema.safeParse(tagBody({ moods: ['nonsense'] })).success, false);
  assert.match(
    schema.safeParse(tagBody({ moods: ['nonsense'] })).error!.issues[0].message,
    /^unknown mood\(s\): nonsense$/,
  );
  assert.equal(schema.safeParse(tagBody({ moods: 'calm' })).success, false);
  assert.equal(schema.safeParse(tagBody({ moods: [1] })).success, false);
});

test('an EMPTY moods array is a legal request — it clears the track', () => {
  const schema = manualTagSchema({ moodNames: MOODS });
  assert.deepEqual(schema.parse(tagBody({ moods: [] })).moods, []);
  // …but an OMITTED moods key is not the same request, and is refused.
  assert.equal(schema.safeParse({ id: 't1' }).success, false);
});

test('moodNames: null validates SHAPE only — the browser posture', () => {
  const shapeOnly = manualTagSchema({ moodNames: null });
  assert.equal(shapeOnly.safeParse(tagBody({ moods: ['not-a-mood'] })).success, true);
  // The caps and types still apply; only membership is skipped.
  assert.equal(shapeOnly.safeParse(tagBody({ moods: ['a', 'b', 'c', 'd'] })).success, false);
});

test('energy accepts the three bands or null, and defaults to null', () => {
  const schema = manualTagSchema({ moodNames: MOODS });
  for (const e of MANUAL_TAG_ENERGIES) {
    assert.equal(schema.parse(tagBody({ energy: e })).energy, e);
  }
  assert.equal(schema.parse(tagBody()).energy, null, 'omitted reads as null');
  assert.equal(schema.parse(tagBody({ energy: null })).energy, null);
  assert.equal(schema.safeParse(tagBody({ energy: 'blazing' })).success, false);
  assert.match(
    schema.safeParse(tagBody({ energy: 'blazing' })).error!.issues[0].message,
    /^energy must be 'low', 'medium', 'high' or null$/,
  );
});

test('applyToAlbum is === true, so a truthy non-boolean reads as off', () => {
  const schema = manualTagSchema({ moodNames: MOODS });
  assert.equal(schema.parse(tagBody({ applyToAlbum: true })).applyToAlbum, true);
  assert.equal(schema.parse(tagBody({ applyToAlbum: 1 })).applyToAlbum, false);
  assert.equal(schema.parse(tagBody({ applyToAlbum: 'yes' })).applyToAlbum, false);
  assert.equal(schema.parse(tagBody()).applyToAlbum, false);
});

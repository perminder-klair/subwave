// Skill create/edit moved onto a shared zod schema (controller/src/schemas/
// skill.ts), mirrored into web/lib/schemas.generated.ts. These tests pin the
// surfaces that must agree: the schema itself, the constants it now homes for
// the loader / settings / admin editor, and the parsed-body → SKILL.md field
// mapping every write path goes through.
//
// Run: npx tsx scripts/skill-schema.test.ts (auto-discovered by npm test).
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-skill-schema-'));

const {
  CONTEXT_FIELDS,
  SKILL_COOLDOWN_RE,
  SKILL_ENV_KEY_RE,
  SKILL_SLUG_RE,
  SKILL_TAG_RE,
  SKILL_WINDOWS,
  TAGS_PER_SKILL_LIMIT,
  builtinSkillFileSchema,
  customSkillFileSchema,
  normalizeSkillTags,
  skillCreateSchema,
  skillFieldsFrom,
  skillFileSchema,
} = await import('../src/schemas/skill.js');

// --- the brief --------------------------------------------------------------

test('brief is required and trimmed', () => {
  assert.equal(builtinSkillFileSchema.parse({ brief: '  say something  ' }).brief, 'say something');
  assert.equal(builtinSkillFileSchema.safeParse({}).success, false);
  assert.equal(builtinSkillFileSchema.safeParse({ brief: '   ' }).success, false);
  assert.equal(builtinSkillFileSchema.safeParse({ brief: 42 }).success, false);
});

// --- cooldown ---------------------------------------------------------------

test('cooldown accepts the documented shapes and an empty value', () => {
  for (const v of ['45m', '6h', '2d', '30s', '90', '45 m']) {
    assert.equal(customSkillFileSchema.parse({ brief: 'b', cooldown: v }).cooldown, v);
  }
  // Absent / blank both mean "use the default" — no frontmatter line written.
  assert.equal(customSkillFileSchema.parse({ brief: 'b' }).cooldown, undefined);
  assert.equal(customSkillFileSchema.parse({ brief: 'b', cooldown: '  ' }).cooldown, undefined);
});

test('cooldown rejects free text', () => {
  for (const v of ['soon', '45min', '1.5h', 'm45']) {
    assert.equal(customSkillFileSchema.safeParse({ brief: 'b', cooldown: v }).success, false);
  }
});

test('explicit null reads as absent on every optional field', () => {
  // Regression: the hand-rolled builders these schemas replaced read
  // `typeof b.cooldown === 'string' ? … : ''`, so a client PUTting null has
  // always meant "use the default" — a 400 here is an accept→reject change on
  // a public admin endpoint.
  const parsed = customSkillFileSchema.parse({
    brief: 'b', label: null, cooldown: null, cronOnly: null, cohosts: null, context: null, tags: null,
    window: null, requiresKey: null,
  });
  assert.equal(parsed.label, undefined);
  assert.equal(parsed.cooldown, undefined);
  assert.equal(parsed.cronOnly, false);
  assert.equal(parsed.cohosts, false);
  assert.equal(parsed.context, undefined);
  assert.equal(parsed.tags, undefined);
  assert.equal(parsed.window, undefined);
  assert.equal(parsed.requiresKey, undefined);
});

test('SKILL_COOLDOWN_RE is what the editor tests against', () => {
  assert.ok(SKILL_COOLDOWN_RE.test('45m'));
  assert.ok(!SKILL_COOLDOWN_RE.test('45min'));
});

// --- context ----------------------------------------------------------------

test('context accepts an array or a comma string, lowercased and trimmed', () => {
  assert.deepEqual(
    builtinSkillFileSchema.parse({ brief: 'b', context: ['Weather', ' clock '] }).context,
    ['weather', 'clock'],
  );
  assert.deepEqual(
    builtinSkillFileSchema.parse({ brief: 'b', context: 'weather, festival' }).context,
    ['weather', 'festival'],
  );
});

test('an empty context selection resets to the default profile (undefined, not [])', () => {
  // Load-bearing: writeSkillFile omits the `context:` line for undefined, and an
  // omitted line is what makes the skill fall back to its default profile.
  assert.equal(builtinSkillFileSchema.parse({ brief: 'b', context: [] }).context, undefined);
  assert.equal(builtinSkillFileSchema.parse({ brief: 'b', context: '' }).context, undefined);
  assert.equal(builtinSkillFileSchema.parse({ brief: 'b' }).context, undefined);
});

test('an unknown context field is refused, and the message names it and the vocabulary', () => {
  const r = builtinSkillFileSchema.safeParse({ brief: 'b', context: ['weather', 'moon'] });
  assert.equal(r.success, false);
  const msg = r.success ? '' : r.error.issues[0].message;
  assert.match(msg, /moon/);
  for (const f of CONTEXT_FIELDS) assert.match(msg, new RegExp(f));
});

// --- tags -------------------------------------------------------------------

test('tags dedupe, keep order, and drop empties', () => {
  assert.deepEqual(
    builtinSkillFileSchema.parse({ brief: 'b', tags: 'late-night, , factual, late-night' }).tags,
    ['late-night', 'factual'],
  );
  assert.equal(builtinSkillFileSchema.parse({ brief: 'b', tags: [] }).tags, undefined);
});

test('a malformed tag is REFUSED on the form path', () => {
  const r = builtinSkillFileSchema.safeParse({ brief: 'b', tags: ['Late Night'] });
  assert.equal(r.success, false);
  assert.match(r.success ? '' : r.error.issues[0].message, /invalid tag/);
});

test('the tag cap counts unique tags', () => {
  const many = Array.from({ length: TAGS_PER_SKILL_LIMIT }, (_, i) => `t${i}`);
  assert.equal(builtinSkillFileSchema.safeParse({ brief: 'b', tags: many }).success, true);
  assert.equal(
    builtinSkillFileSchema.safeParse({ brief: 'b', tags: [...many, 'one-more'] }).success,
    false,
  );
  // …so a duplicate can't push a legal list over the edge.
  assert.equal(builtinSkillFileSchema.safeParse({ brief: 'b', tags: [...many, 't0'] }).success, true);
});

test('normalizeSkillTags is the lenient twin: it DROPS what the schema refuses', () => {
  // The disk path (a hand-edited SKILL.md) must never fail to load over a tag.
  assert.deepEqual(normalizeSkillTags('Late Night, factual'), ['factual']);
  assert.deepEqual(normalizeSkillTags(['a', 'a', 'b']), ['a', 'b']);
  assert.equal(normalizeSkillTags(Array.from({ length: 20 }, (_, i) => `t${i}`)).length, TAGS_PER_SKILL_LIMIT);
  assert.deepEqual(normalizeSkillTags(undefined), []);
});

test('both tag paths run the same rules', () => {
  assert.ok(SKILL_TAG_RE.test('late-night'));
  assert.ok(!SKILL_TAG_RE.test('-nope'));
  assert.ok(!SKILL_TAG_RE.test('x'.repeat(25)));
});

// --- window + requiresKey (custom skills only) ------------------------------

test('window: only "commute" is written; "any" is the default and writes nothing', () => {
  assert.equal(customSkillFileSchema.parse({ brief: 'b', window: 'commute' }).window, 'commute');
  assert.equal(customSkillFileSchema.parse({ brief: 'b', window: 'any' }).window, undefined);
  assert.equal(customSkillFileSchema.parse({ brief: 'b' }).window, undefined);
  assert.equal(customSkillFileSchema.safeParse({ brief: 'b', window: 'evenings' }).success, false);
  assert.deepEqual([...SKILL_WINDOWS], ['any', 'commute']);
});

test('requiresKey must be an env var name; empty is allowed and means none', () => {
  assert.equal(customSkillFileSchema.parse({ brief: 'b', requiresKey: 'TAVILY_KEY' }).requiresKey, 'TAVILY_KEY');
  assert.equal(customSkillFileSchema.parse({ brief: 'b', requiresKey: '' }).requiresKey, undefined);
  assert.equal(customSkillFileSchema.safeParse({ brief: 'b', requiresKey: 'lower_case' }).success, false);
  assert.ok(SKILL_ENV_KEY_RE.test('SEARCH_API_KEY'));
});

test('a built-in never takes window / requiresKey off the body', () => {
  // Unchanged behaviour: those two are fixed by the shipped template, so the
  // built-in edit route has always ignored them.
  const r = builtinSkillFileSchema.parse({ brief: 'b', window: 'commute', requiresKey: 'X' });
  assert.equal('window' in r, false);
  assert.equal('requiresKey' in r, false);
  assert.equal(skillFileSchema(false), builtinSkillFileSchema);
  assert.equal(skillFileSchema(true), customSkillFileSchema);
});

// --- create -----------------------------------------------------------------

test('create requires a valid slug and lowercases it', () => {
  assert.equal(skillCreateSchema.parse({ name: ' Moon-Phase ', brief: 'b' }).name, 'moon-phase');
  for (const bad of ['', '-nope', 'has space', 'UPPER!', 'x'.repeat(50)]) {
    assert.equal(skillCreateSchema.safeParse({ name: bad, brief: 'b' }).success, false);
  }
  assert.equal(skillCreateSchema.safeParse({ name: 'x'.repeat(49), brief: 'b' }).success, true);
});

test('the slug pattern is the one every surface now shares', async () => {
  const { SLUG_RE } = await import('../src/skills/loader.js');
  const { SKILL_SLUG_RE: SETTINGS_RE } = await import('../src/settings/vocab.js');
  const { validatePersonasStrict } = await import('../src/settings/validate.js');
  // The alias swap must not let old-format entries block a roster save: the
  // pattern this replaced (/^[a-z0-9-]{1,40}$/) accepted a leading hyphen, so a
  // backup or older settings.json can carry one. An entry that can't name a
  // skill can never fire — it is DROPPED (the themeId #917 tolerance), never
  // thrown, and the valid entries around it survive.
  const [p] = validatePersonasStrict([{
    name: 'Kai', soul: 'warm', frequency: 'moderate',
    tts: { engine: 'piper', cloudProvider: 'openai', voice: '' },
    skills: ['-nope', 'weather'],
  }]);
  assert.deepEqual(p.skills, ['weather']);
  // loader.SLUG_RE and settings/vocab's SKILL_SLUG_RE are aliases of this one.
  // vocab's used to be a SEPARATE pattern that accepted `-nope` and rejected a
  // real 41–49-char slug, so a legally-named skill couldn't be assigned to a
  // persona at all.
  assert.equal(SLUG_RE.source, SKILL_SLUG_RE.source);
  assert.equal(SETTINGS_RE.source, SKILL_SLUG_RE.source);
  assert.ok(!SETTINGS_RE.test('-nope'));
  assert.ok(SETTINGS_RE.test('a'.repeat(45)));
});

// --- the field mapping ------------------------------------------------------

test('skillFieldsFrom renames context → contextFields and carries the rest', () => {
  const parsed = customSkillFileSchema.parse({
    brief: 'say something',
    label: '  Moon Phase  ',
    cooldown: '6h',
    cron: '0 * * * *',
    cronOnly: true,
    cohosts: true,
    context: ['weather'],
    tags: ['nightly'],
    window: 'commute',
    requiresKey: 'MOON_KEY',
  });
  assert.deepEqual(skillFieldsFrom('moon-phase', parsed), {
    kind: 'moon-phase',
    label: 'Moon Phase',
    cooldown: '6h',
    cron: '0 * * * *',
    cronOnly: true,
    cohosts: true,
    contextFields: ['weather'],
    window: 'commute',
    requiresKey: 'MOON_KEY',
    tags: ['nightly'],
    brief: 'say something',
  });
});

test('cohosts defaults to false, accepts only booleans, and maps to skill fields', () => {
  assert.equal(builtinSkillFileSchema.parse({ brief: 'b' }).cohosts, false);
  assert.equal(builtinSkillFileSchema.parse({ brief: 'b', cohosts: true }).cohosts, true);
  assert.throws(() => builtinSkillFileSchema.parse({ brief: 'b', cohosts: 'yes' }));
});

test('cronOnly defaults to false and rejects a non-boolean', () => {
  const parsed = builtinSkillFileSchema.parse({ brief: 'b' });
  assert.equal(parsed.cronOnly, false);
  assert.throws(() => builtinSkillFileSchema.parse({ brief: 'b', cronOnly: 'yes' }));
});

test('cron accepts 5 fields and node-cron\'s optional 6th (seconds)', () => {
  // The 6-field arm is load-bearing, not generosity: node-cron 3.x registers
  // and fires `0 0 8 * * *`, so a 5-only shape check would refuse the admin
  // form's save of ANY field on a skill whose SKILL.md carries one — the
  // editor round-trips the cron value it loaded. A working config the UI
  // cannot edit is worse than one it never accepted.
  assert.equal(builtinSkillFileSchema.parse({ brief: 'b', cron: '0 8 * * *' }).cron, '0 8 * * *');
  assert.equal(builtinSkillFileSchema.parse({ brief: 'b', cron: '0 0 8 * * *' }).cron, '0 0 8 * * *');
  assert.throws(() => builtinSkillFileSchema.parse({ brief: 'b', cron: '0 8 * *' }), /cron/);
  assert.throws(() => builtinSkillFileSchema.parse({ brief: 'b', cron: '0 0 0 8 * * *' }), /cron/);
});

test('cron shape-checks only — the range rules belong to node-cron', () => {
  // schemas/ may import nothing but zod, so "99 * * * *" passes here and is
  // refused by routes/dj.ts's rejectInvalidCron() at save time. Pinning it
  // stops someone "fixing" the regex into a half-copy of node-cron's parser.
  assert.equal(builtinSkillFileSchema.parse({ brief: 'b', cron: '99 * * * *' }).cron, '99 * * * *');
});

test('an empty label is undefined, not "" — writeSkillFile omits the line', () => {
  const parsed = builtinSkillFileSchema.parse({ brief: 'b', label: '   ' });
  assert.equal(skillFieldsFrom('weather', parsed).label, undefined);
});

// --- the shared vocabulary --------------------------------------------------

test('CONTEXT_FIELDS is the vocabulary the prompt layer emits', async () => {
  const { CONTEXT_FIELDS: PROMPT_FIELDS } = await import('../src/llm/internal/prompts/context.js');
  // Re-exported, not copied: the admin editor renders one chip per entry and
  // used to carry a hand-maintained second list.
  assert.equal(PROMPT_FIELDS, CONTEXT_FIELDS);
});

test('the mirror carries the skill schema to the browser', async () => {
  const { readFileSync } = await import('node:fs');
  const mirror = readFileSync(
    new URL('../../web/lib/schemas.generated.ts', import.meta.url),
    'utf8',
  );
  for (const name of ['SKILL_SLUG_RE', 'SKILL_TAG_RE', 'SKILL_COOLDOWN_RE', 'CONTEXT_FIELDS', 'skillCreateSchema', 'skillFileSchema']) {
    assert.match(mirror, new RegExp(`export (const|function) ${name}\\b`), `mirror is missing ${name}`);
  }
});

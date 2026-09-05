// Personas + the DJ prompt library moved onto a shared zod schema
// (controller/src/schemas/persona.ts), mirrored into
// web/lib/schemas.generated.ts. These tests pin the three things that have to
// agree afterwards: the schema itself, the strict update() chokepoint
// (validatePersonasStrict / validateDjPromptsStrict / validateTtsBlock), and the
// lenient load path (normalizePersonaArray / normalizeDjPrompts / normalizeTts).
//
// The conversion's stated contract is ZERO behaviour change, so most of what is
// pinned here is accidental leniency the obvious conversion would have removed:
// String() coercion on name/soul/tagline, an absent key reading as a default
// rather than as a refusal, and a malformed skills entry being DROPPED while a
// malformed language is REFUSED.
//
// Run: npx tsx scripts/persona-schema.test.ts (auto-discovered by npm test).
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-persona-schema-'));

const {
  DJ_PROMPT_LIMIT,
  DJ_PROMPT_NAME_MAX,
  DJ_PROMPT_TEXT_MAX,
  DJ_PROMPT_TEXT_MIN,
  PERSONA_AVATAR_FILENAME_RE,
  PERSONA_DIAL_NEUTRAL,
  PERSONA_FREQUENCIES,
  PERSONA_ID_RE,
  PERSONA_LIMIT,
  PERSONA_NAME_MAX,
  PERSONA_SCRIPT_LENGTHS,
  PERSONA_SKILLS_LIMIT,
  PERSONA_SKILL_SLUG_RE,
  PERSONA_SOUL_MAX,
  PERSONA_TAG_MAX,
  PERSONA_TAG_RE,
  TAGS_PER_PERSONA_LIMIT,
  TTS_CLOUD_PROVIDERS,
  TTS_ENGINES,
  clampPersonaDial,
  clampTtsGain,
  clampTtsSpeed,
  djPromptsSchema,
  personaSchema,
  personasSchema,
  repairPersonaForLoad,
  repairTtsVoiceSlot,
  ttsVoiceSlotSchema,
} = await import('../src/schemas/persona.js');

const { resolveDjPromptIds, resolvePersonaIds } = await import('../src/schemas/persona-server.js');
const validate = await import('../src/settings/validate.js');
const normalize = await import('../src/settings/normalize.js');
const vocab = await import('../src/settings/vocab.js');

// A minimal persona every test starts from — the shape the admin editor posts.
const base = () => ({
  name: 'Nova',
  soul: 'warm and dry',
  frequency: 'moderate',
  tts: { engine: 'piper', cloudProvider: 'openai', voice: '' },
});

// ── the shared constants are one definition, not a hand-copied pair ──────────
//
// schemas/persona.ts may import nothing but zod, so two regexes it needs are
// necessarily re-declared rather than imported (the flat mirror also forbids
// reusing the ORIGINAL name). That duplication is structural; this is the guard
// that stops it drifting — the same answer skill-schema.test.ts gives for
// loader.SLUG_RE.

test('PERSONA_ID_RE is the same pattern as the show schema owns', async () => {
  const { SHOW_ID_RE } = await import('../src/schemas/show.js');
  assert.equal(PERSONA_ID_RE.source, SHOW_ID_RE.source);
  assert.equal(PERSONA_ID_RE.flags, SHOW_ID_RE.flags);
});

test('PERSONA_TAG_RE is the same pattern the show and skill schemas own', async () => {
  const { SHOW_TAG_RE } = await import('../src/schemas/show.js');
  const { SKILL_TAG_RE } = await import('../src/schemas/skill.js');
  assert.equal(PERSONA_TAG_RE.source, SHOW_TAG_RE.source);
  assert.equal(PERSONA_TAG_RE.source, SKILL_TAG_RE.source);
});

test('PERSONA_SKILL_SLUG_RE is the same pattern as the skill schema owns', async () => {
  const { SKILL_SLUG_RE } = await import('../src/schemas/skill.js');
  assert.equal(PERSONA_SKILL_SLUG_RE.source, SKILL_SLUG_RE.source);
  assert.equal(PERSONA_SKILL_SLUG_RE.flags, SKILL_SLUG_RE.flags);
});

test('settings/vocab.ts ALIASES the schema constants rather than restating them', () => {
  // Identity, not equality: a re-declared literal would still pass a value
  // comparison on the day it was copied and fail silently a year later.
  assert.equal(vocab.PERSONA_LIMIT, PERSONA_LIMIT);
  assert.equal(vocab.SOUL_MAX, PERSONA_SOUL_MAX);
  assert.equal(vocab.SKILLS_PER_PERSONA_LIMIT, PERSONA_SKILLS_LIMIT);
  assert.equal(vocab.DIAL_NEUTRAL, PERSONA_DIAL_NEUTRAL);
  assert.equal(vocab.DJ_PROMPT_LIMIT, DJ_PROMPT_LIMIT);
  assert.equal(vocab.DJ_PROMPT_NAME_MAX, DJ_PROMPT_NAME_MAX);
  assert.equal(vocab.DJ_PROMPT_TEXT_MIN, DJ_PROMPT_TEXT_MIN);
  assert.equal(vocab.DJ_PROMPT_TEXT_MAX, DJ_PROMPT_TEXT_MAX);
  assert.equal(vocab.AVATAR_FILENAME_RE, PERSONA_AVATAR_FILENAME_RE);
  assert.equal(vocab.normalizeDial, clampPersonaDial);
  assert.equal(vocab.clampTtsGain, clampTtsGain);
  assert.equal(vocab.clampTtsSpeed, clampTtsSpeed);
  assert.deepEqual([...vocab.FREQUENCIES], [...PERSONA_FREQUENCIES]);
  assert.deepEqual([...vocab.SCRIPT_LENGTHS], [...PERSONA_SCRIPT_LENGTHS]);
  assert.deepEqual([...vocab.TTS_ENGINES], [...TTS_ENGINES]);
  assert.deepEqual([...vocab.TTS_CLOUD_PROVIDERS], [...TTS_CLOUD_PROVIDERS]);
});

// ── persona: the fields ──────────────────────────────────────────────────────

test('a minimal persona parses and fills every default', () => {
  const p = personaSchema.parse(base());
  assert.equal(p.name, 'Nova');
  assert.equal(p.tagline, '');
  assert.equal(p.language, '');
  assert.equal(p.scriptLength, 'concise');
  assert.equal(p.djMode, false);
  assert.equal(p.avatar, '');
  assert.equal(p.skills, null);
  assert.equal(p.humour, PERSONA_DIAL_NEUTRAL);
  assert.equal(p.localColour, PERSONA_DIAL_NEUTRAL);
  assert.equal(p.warmth, PERSONA_DIAL_NEUTRAL);
  assert.equal(p.id, undefined, 'id is minted by the server-only sibling, not the schema');
});

test('name/soul/tagline COERCE rather than refuse a non-string (unchanged)', () => {
  // String(x ?? '').trim() is what the hand-rolled validator did, so a persona
  // named 123 has always saved. Refusing it now would be a tightening.
  const p = personaSchema.parse({ ...base(), name: 123, tagline: 7 });
  assert.equal(p.name, '123');
  assert.equal(p.tagline, '7');
});

test('name/soul are trimmed and length-bounded', () => {
  assert.equal(personaSchema.parse({ ...base(), name: '  Nova  ' }).name, 'Nova');
  assert.equal(personaSchema.safeParse({ ...base(), name: '' }).success, false);
  assert.equal(personaSchema.safeParse({ ...base(), name: '   ' }).success, false);
  assert.equal(
    personaSchema.safeParse({ ...base(), name: 'x'.repeat(PERSONA_NAME_MAX + 1) }).success,
    false,
  );
  assert.equal(personaSchema.safeParse({ ...base(), soul: '' }).success, false);
  assert.equal(
    personaSchema.safeParse({ ...base(), soul: 'x'.repeat(PERSONA_SOUL_MAX + 1) }).success,
    false,
  );
});

test('an ABSENT optional key reads as its default, not as a refusal', () => {
  // zod 4 treats a bare z.unknown() inside z.object as a REQUIRED key, so every
  // coerced field carries .optional(). Without it a persona that merely omits
  // `tagline` fails — which no persona ever written by this codebase has to do.
  const { tagline: _t, ...noTagline } = { ...base(), tagline: 'x' };
  assert.equal(personaSchema.parse(noTagline).tagline, '');
  assert.equal(personaSchema.parse(base()).humour, PERSONA_DIAL_NEUTRAL);
});

test('explicit null reads as absent on every optional field', () => {
  const p = personaSchema.parse({
    ...base(),
    tagline: null,
    language: null,
    scriptLength: null,
    djMode: null,
    avatar: null,
    skills: null,
  });
  assert.equal(p.tagline, '');
  assert.equal(p.language, '');
  assert.equal(p.scriptLength, 'concise');
  assert.equal(p.djMode, false);
  assert.equal(p.avatar, '');
  assert.equal(p.skills, null);
});

test('language REFUSES a non-string where name COERCES one', () => {
  // Not an inconsistency to tidy up: the hand-rolled validator drew the line
  // exactly here, and both directions are load-bearing behaviour.
  assert.equal(personaSchema.safeParse({ ...base(), language: 42 }).success, false);
  assert.equal(personaSchema.parse({ ...base(), language: '  Turkish  ' }).language, 'Turkish');
});

test('frequency must name a real frequency; scriptLength defaults but is checked', () => {
  assert.equal(personaSchema.safeParse({ ...base(), frequency: 'loud' }).success, false);
  assert.equal(personaSchema.safeParse({ ...base(), frequency: undefined }).success, false);
  for (const f of PERSONA_FREQUENCIES) {
    assert.equal(personaSchema.safeParse({ ...base(), frequency: f }).success, true);
  }
  assert.equal(personaSchema.safeParse({ ...base(), scriptLength: 'epic' }).success, false);
});

test('djMode REFUSES a truthy non-boolean (unchanged)', () => {
  // Unlike a show's booleans — which both paths read as `=== true` — the strict
  // persona validator has always refused a non-boolean here.
  assert.equal(personaSchema.safeParse({ ...base(), djMode: 1 }).success, false);
  assert.equal(personaSchema.safeParse({ ...base(), djMode: 'yes' }).success, false);
  assert.equal(personaSchema.parse({ ...base(), djMode: true }).djMode, true);
});

test('dials clamp anything to 0-10 and never fail a save', () => {
  const p = personaSchema.parse({ ...base(), humour: 99, localColour: -4, warmth: 'nonsense' });
  assert.equal(p.humour, 10);
  assert.equal(p.localColour, 0);
  assert.equal(p.warmth, PERSONA_DIAL_NEUTRAL);
  assert.equal(personaSchema.parse({ ...base(), humour: 6.6 }).humour, 7, 'rounds');
});

test('avatar must be a bare basename, and an empty one is not a refusal', () => {
  assert.equal(personaSchema.parse({ ...base(), avatar: '' }).avatar, '');
  assert.equal(personaSchema.parse({ ...base(), avatar: 'p_abc123.png' }).avatar, 'p_abc123.png');
  for (const bad of ['../etc/passwd.png', '/abs/p_a.png', 'p_a.exe', 'p_a.png.exe', 'AB.png']) {
    assert.equal(
      personaSchema.safeParse({ ...base(), avatar: bad }).success,
      false,
      `avatar should refuse ${bad}`,
    );
  }
});

test('a malformed skills entry is DROPPED, but an over-cap list is REFUSED', () => {
  // The asymmetry is deliberate (#917): an entry that cannot name a skill can
  // never fire, so failing the whole roster over inert junk costs the operator
  // everything and saves nothing. A list longer than the cap is a different
  // claim about the data and stays a refusal.
  const p = personaSchema.parse({
    ...base(),
    skills: ['news', '-bad', 'news', 'weather', 'A_B', null, { x: 1 }],
  });
  assert.deepEqual(p.skills, ['news', 'weather'], 'junk dropped, order kept, deduped');
  // A numeric entry survives, because String(42) is '42' and a slug may be all
  // digits — the hand-rolled validator coerced identically. Pinned so nobody
  // "fixes" it into a z.string() and starts dropping a legal slug.
  assert.deepEqual(personaSchema.parse({ ...base(), skills: [42] }).skills, ['42']);
  assert.equal(personaSchema.safeParse({ ...base(), skills: 'news' }).success, false);
  assert.equal(
    personaSchema.safeParse({ ...base(), skills: new Array(PERSONA_SKILLS_LIMIT + 1).fill('news') })
      .success,
    false,
  );
  assert.deepEqual(personaSchema.parse({ ...base(), skills: [] }).skills, []);
});

test('a malformed id is re-minted, not refused', () => {
  // Same call the shows conversion made, for a stronger reason: a persona id is
  // what every show, guest list and activePersonaId points at.
  assert.equal(personaSchema.parse({ ...base(), id: 'NOT VALID' }).id, undefined);
  assert.equal(personaSchema.parse({ ...base(), id: 'p_abc123' }).id, 'p_abc123');
});

// ── the TTS voice slot ───────────────────────────────────────────────────────

test('the voice slot bakes its own path into the message', () => {
  // Both call sites read this as a flat toast string, so 'tts.fallback' has to
  // survive in the text rather than being derived from a zod path.
  const r = ttsVoiceSlotSchema('tts.fallback').safeParse({ engine: 'nope' });
  assert.equal(r.success, false);
  assert.match(r.error!.issues[0].message, /^tts\.fallback\.engine must be one of: /);
});

test('the voice slot reports engine BEFORE voice', () => {
  // Engine decides which voice rule applies, so a voice complaint about a rule
  // the operator never opted into is worse than useless.
  const r = ttsVoiceSlotSchema('tts').safeParse({ engine: 'bogus', voice: 'also-bogus' });
  assert.match(r.error!.issues[0].message, /\.engine must be one of/);
});

test('per-engine voice rules are unchanged', () => {
  const ok = (raw: unknown) => ttsVoiceSlotSchema('tts').safeParse(raw).success;
  const slot = (o: Record<string, unknown>) => ({ cloudProvider: 'openai', ...o });

  // kokoro demands a <lang><gender>_<name> id — empty is NOT allowed.
  assert.equal(ok(slot({ engine: 'kokoro', voice: 'bf_isabella' })), true);
  assert.equal(ok(slot({ engine: 'kokoro', voice: '' })), false);
  // chatterbox: empty = built-in default, else a bare .wav.
  assert.equal(ok(slot({ engine: 'chatterbox', voice: '' })), true);
  assert.equal(ok(slot({ engine: 'chatterbox', voice: 'ref.wav' })), true);
  assert.equal(ok(slot({ engine: 'chatterbox', voice: 'a/b.wav' })), false);
  // pocket-tts: empty becomes 'alba'; a built-in id or a .wav both pass.
  assert.equal(
    ttsVoiceSlotSchema('tts').parse(slot({ engine: 'pocket-tts', voice: '' })).voice,
    'alba',
  );
  assert.equal(ok(slot({ engine: 'pocket-tts', voice: 'clone.wav' })), true);
  // cloud: openai-compatible may be empty, the others may not.
  assert.equal(ok({ engine: 'cloud', cloudProvider: 'openai-compatible', voice: '' }), true);
  assert.equal(ok({ engine: 'cloud', cloudProvider: 'openai', voice: '' }), false);
  assert.equal(ok({ engine: 'cloud', cloudProvider: 'openai', voice: 'alloy' }), true);
  // remote: server-specific, empty is fine.
  assert.equal(ok(slot({ engine: 'remote', voice: '' })), true);
  // piper: empty, an .onnx, OR a kokoro-shaped id (#454 — the seed roster).
  assert.equal(ok(slot({ engine: 'piper', voice: '' })), true);
  assert.equal(ok(slot({ engine: 'piper', voice: 'en_GB-alba.onnx' })), true);
  assert.equal(ok(slot({ engine: 'piper', voice: 'bf_isabella' })), true);
  assert.equal(ok(slot({ engine: 'piper', voice: 'whatever' })), false);
});

test('gain and speed clamp rather than refuse, and treat unset differently', () => {
  const p = ttsVoiceSlotSchema('tts').parse({
    engine: 'piper',
    cloudProvider: 'openai',
    voice: '',
    gainDb: 99,
    speed: 99,
  });
  assert.equal(p.gainDb, 12);
  assert.equal(p.speed, 2);
  // Unset gain is 0 (unity); unset speed is 1.0 (unity) — NOT 0, which would
  // clamp to the 0.5 floor and slow every voice down.
  const q = ttsVoiceSlotSchema('tts').parse({ engine: 'piper', cloudProvider: 'openai' });
  assert.equal(q.gainDb, 0);
  assert.equal(q.speed, 1);
  assert.equal(clampTtsSpeed(''), 1);
  assert.equal(clampTtsGain('nonsense'), 0);
});

test('repairTtsVoiceSlot always produces something the strict slot accepts', () => {
  const hostile: unknown[] = [
    undefined,
    null,
    'not an object',
    { engine: 'bogus' },
    { engine: 'kokoro', voice: 'nope' },
    { engine: 'cloud', cloudProvider: 'openai', voice: '' },
    { engine: 'cloud', cloudProvider: 'openai-compatible', voice: '' },
    { engine: 'pocket-tts', voice: '???' },
    { engine: 'piper', voice: 'a/b.onnx' },
    { engine: 'chatterbox', voice: 'x'.repeat(500) },
    { engine: 'remote', voice: 'x'.repeat(500) },
  ];
  for (const raw of hostile) {
    const repaired = repairTtsVoiceSlot(raw);
    const r = ttsVoiceSlotSchema('tts').safeParse(repaired);
    assert.equal(r.success, true, `repair of ${JSON.stringify(raw)} should be schema-valid`);
  }
});

test('a kokoro-shaped voice under piper SURVIVES the repair (#454)', () => {
  // The seed roster carries one per persona so switching to Kokoro yields
  // distinct voices with no re-editing. Wiping it here broke that on the first
  // reload after a save.
  assert.equal(repairTtsVoiceSlot({ engine: 'piper', voice: 'bf_isabella' }).voice, 'bf_isabella');
});

// ── strict vs lenient ────────────────────────────────────────────────────────

test('validatePersonasStrict throws a readable line, never a ZodError blob', () => {
  try {
    validate.validatePersonasStrict([{ ...base(), name: '' }]);
    assert.fail('expected a throw');
  } catch (err) {
    const msg = (err as Error).message;
    assert.equal(msg.includes('\n'), false, 'must be one line, not a JSON dump');
    assert.match(msg, /^personas\.0\.name: /, 'names the row and the field');
  }
});

test('validatePersonasStrict enforces the roster bounds', () => {
  assert.throws(() => validate.validatePersonasStrict([]), /1-48/);
  assert.throws(() => validate.validatePersonasStrict('nope'), /1-48/);
  assert.throws(
    () => validate.validatePersonasStrict(new Array(PERSONA_LIMIT + 1).fill(base())),
    /1-48/,
  );
});

test('validatePersonasStrict mints ids and de-duplicates them', () => {
  const out = validate.validatePersonasStrict([
    { ...base(), id: 'p_same' },
    { ...base(), id: 'p_same' },
    { ...base() },
  ]);
  assert.equal(out[0].id, 'p_same');
  assert.notEqual(out[1].id, 'p_same', 'a collision is re-minted');
  assert.match(out[2].id, /^p_/);
  assert.equal(new Set(out.map((p) => p.id)).size, 3);
});

test('the LENIENT path drops a row where the strict one throws', () => {
  const raw = [
    { ...base(), name: '' }, // unsalvageable — no name
    { ...base(), name: 'Kept', frequency: 'loud', tts: { engine: 'bogus' } }, // repairable
  ];
  assert.throws(() => validate.validatePersonasStrict(raw));
  const out = normalize.normalizePersonaArray(raw)!;
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Kept');
  assert.equal(out[0].frequency, 'moderate', 'an unknown frequency is repaired, not fatal');
  assert.equal(out[0].tts.engine, 'piper', 'an unknown engine is repaired, not fatal');
});

test('the lenient path truncates where the strict one refuses', () => {
  const long = { ...base(), name: 'x'.repeat(PERSONA_NAME_MAX + 20) };
  assert.throws(() => validate.validatePersonasStrict([long]));
  assert.equal(normalize.normalizePersonaArray([long])![0].name.length, PERSONA_NAME_MAX);
});

test('the lenient path caps the roster instead of refusing it', () => {
  const many = new Array(PERSONA_LIMIT + 5).fill(null).map((_, i) => ({ ...base(), name: `P${i}` }));
  assert.throws(() => validate.validatePersonasStrict(many));
  assert.equal(normalize.normalizePersonaArray(many)!.length, PERSONA_LIMIT);
});

test('an empty or non-array roster loads as null so the seed roster applies', () => {
  assert.equal(normalize.normalizePersonaArray([]), null);
  assert.equal(normalize.normalizePersonaArray('nope'), null);
  assert.equal(normalize.normalizePersonaArray([{ name: '' }]), null);
});

test('the lenient path applies the skill RENAMES the strict path never did', () => {
  // A rename is a migration of stored data, not a rule a submitted value has to
  // satisfy — which is why it lives in the repair and not in the schema.
  const out = normalize.normalizePersonaArray([{ ...base(), skills: ['random-facts'] }])!;
  assert.deepEqual(out[0].skills, ['curiosity']);
  assert.deepEqual(
    validate.validatePersonasStrict([{ ...base(), skills: ['random-facts'] }])[0].skills,
    ['random-facts'],
  );
});

test('repairPersonaForLoad output always parses when name and soul survive', () => {
  const hostile: Record<string, unknown>[] = [
    { name: 'A', soul: 'B' },
    { name: 'A', soul: 'B', frequency: 'nope', scriptLength: 'nope', djMode: 'yes' },
    { name: 'A', soul: 'B', avatar: '../escape.png', language: 42, tagline: 99 },
    { name: 'A', soul: 'B', skills: 'not-an-array', id: 'NOT VALID', humour: 'x' },
    { name: '  A  ', soul: 'B', tts: { engine: 'bogus', voice: 'bogus' } },
  ];
  for (const raw of hostile) {
    const r = personaSchema.safeParse(repairPersonaForLoad(raw, {}));
    assert.equal(r.success, true, `repair of ${JSON.stringify(raw)} should be schema-valid`);
  }
});

test('normalizeTts is the schema-backed repair, not a second implementation', () => {
  assert.equal(normalize.normalizeTts, repairTtsVoiceSlot);
});

test('normalizeTtsFallback keeps enabled and drops the level trims', () => {
  const f = normalize.normalizeTtsFallback({ engine: 'kokoro', voice: 'bf_isabella', gainDb: 6 });
  assert.deepEqual(f, {
    enabled: false,
    engine: 'kokoro',
    voice: 'bf_isabella',
    cloudProvider: 'openai',
  });
  assert.equal(normalize.normalizeTtsFallback({ enabled: true }).enabled, true);
  assert.equal(normalize.normalizeTtsFallback(undefined).enabled, false);
});

test('validateTtsBlock takes the message VERBATIM (no doubled path)', () => {
  assert.throws(
    () => validate.validateTtsBlock({ engine: 'nope' }, 'tts.fallback'),
    (err: Error) => {
      assert.match(err.message, /^tts\.fallback\.engine must be one of: /);
      return true;
    },
  );
});

// ── the DJ prompt library ────────────────────────────────────────────────────

const promptText = (extra = '') => `You are {name}, on air. ${'x'.repeat(DJ_PROMPT_TEXT_MIN)}${extra}`;

test('a prompt needs a name, a bounded text, and the {name} placeholder', () => {
  const ok = djPromptsSchema.parse([{ name: 'House', text: promptText() }]);
  assert.equal(ok[0].name, 'House');
  assert.equal(djPromptsSchema.safeParse([{ name: '', text: promptText() }]).success, false);
  assert.equal(
    djPromptsSchema.safeParse([{ name: 'x'.repeat(DJ_PROMPT_NAME_MAX + 1), text: promptText() }])
      .success,
    false,
  );
  assert.equal(djPromptsSchema.safeParse([{ name: 'H', text: 'too short' }]).success, false);
  assert.equal(
    djPromptsSchema.safeParse([{ name: 'H', text: 'x'.repeat(DJ_PROMPT_TEXT_MAX + 1) }]).success,
    false,
  );
  assert.equal(
    djPromptsSchema.safeParse([{ name: 'H', text: promptText().replace('{name}', 'Nova') }]).success,
    false,
    'a template without {name} would make dialogue anonymous',
  );
});

test('the prompt library is bounded and an empty one is legal', () => {
  assert.equal(djPromptsSchema.parse([]).length, 0);
  assert.equal(
    djPromptsSchema.safeParse(
      new Array(DJ_PROMPT_LIMIT + 1).fill({ name: 'H', text: promptText() }),
    ).success,
    false,
  );
  assert.throws(() => validate.validateDjPromptsStrict('nope'), /0-20/);
});

test('validateDjPromptsStrict names the row and mints dp_ ids', () => {
  try {
    validate.validateDjPromptsStrict([{ name: 'H', text: 'short' }]);
    assert.fail('expected a throw');
  } catch (err) {
    assert.match((err as Error).message, /^djPrompts\.0\.text: /);
  }
  const out = validate.validateDjPromptsStrict([
    { name: 'A', text: promptText() },
    { id: 'dp_dupe', name: 'B', text: promptText() },
    { id: 'dp_dupe', name: 'C', text: promptText() },
  ]);
  assert.match(out[0].id, /^dp_/);
  assert.equal(out[1].id, 'dp_dupe');
  assert.notEqual(out[2].id, 'dp_dupe');
});

test('the lenient prompt path drops a bad text but INVENTS a missing name', () => {
  // The text IS the entry; a name is recoverable, so losing the row over a
  // missing one would throw away the only part the operator can't retype.
  const out = normalize.normalizeDjPrompts([
    { text: promptText() }, // no name
    { name: 'Bad', text: 'too short' }, // unsalvageable
    { name: '', text: promptText() }, // blank name
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'Prompt 1');
  assert.equal(out[1].name, 'Prompt 2', 'the fallback numbers by SURVIVING row, not by input index');
  assert.deepEqual(normalize.normalizeDjPrompts('nope'), []);
});

test('the lenient prompt path caps the library instead of refusing it', () => {
  const many = new Array(DJ_PROMPT_LIMIT + 5).fill({ name: 'H', text: promptText() });
  assert.throws(() => validate.validateDjPromptsStrict(many));
  assert.equal(normalize.normalizeDjPrompts(many).length, DJ_PROMPT_LIMIT);
});

// ── the server-only sibling ──────────────────────────────────────────────────

test('id resolution is shared by both paths and uses the right prefix', () => {
  assert.match(resolvePersonaIds([{}])[0].id, /^p_/);
  assert.match(resolveDjPromptIds([{}])[0].id, /^dp_/);
  const kept = resolvePersonaIds([{ id: 'p_keep' }]);
  assert.equal(kept[0].id, 'p_keep');
});

test('a roster that round-trips through the LOAD path keeps its ids', () => {
  // The load path used to mint through a second hand-rolled copy of this rule.
  // A persona whose id changes across a boot silently orphans its shows.
  const stored = [
    { ...base(), id: 'p_alpha', name: 'Alpha' },
    { ...base(), id: 'p_beta', name: 'Beta' },
  ];
  assert.deepEqual(
    normalize.normalizePersonaArray(stored)!.map((p) => p.id),
    ['p_alpha', 'p_beta'],
  );
});

// ── the strict and lenient paths agree about what is VALID ───────────────────

test('anything the strict path accepts, the lenient path returns unchanged', () => {
  const rich = {
    id: 'p_rich',
    name: 'Rich',
    tagline: 'late nights',
    frequency: 'chatty',
    scriptLength: 'extended',
    djMode: true,
    linkStyle: 'natural',
    humour: 8,
    localColour: 2,
    warmth: 7,
    soul: 'dry and specific',
    language: 'Turkish',
    avatar: 'p_rich.webp',
    tts: { engine: 'kokoro', cloudProvider: 'openai', voice: 'bf_isabella', gainDb: 1.5, speed: 1.1 },
    skills: ['news', 'weather'],
    tags: ['late-night', 'flagship'],
  };
  const strict = validate.validatePersonasStrict([rich]);
  const lenient = normalize.normalizePersonaArray([rich])!;
  assert.deepEqual(strict, lenient);
  assert.deepEqual(strict[0], rich, 'a fully-specified persona round-trips byte-for-byte');
});

// ── tags: organisation only, and the one list that REFUSES a bad entry ───────

test('tags lowercase, trim, de-duplicate and keep first-seen order', () => {
  const [p] = validate.validatePersonasStrict([
    { ...base(), tags: ['  Late-Night ', 'FLAGSHIP', 'late-night'] },
  ]);
  assert.deepEqual(p.tags, ['late-night', 'flagship']);
});

test('a malformed tag is REFUSED on save, unlike the sibling skills list', () => {
  // skills DROPS a malformed entry because it is a subscription resolved
  // against a live catalogue, where a dead entry is inert. A tag is typed by
  // hand and losing one silently is the operator watching their own input
  // disappear — so it throws.
  assert.throws(() => validate.validatePersonasStrict([{ ...base(), tags: ['-nope'] }]), /tag/);
  assert.throws(() => validate.validatePersonasStrict([{ ...base(), tags: ['Has Space'] }]), /tag/);
  assert.throws(
    () => validate.validatePersonasStrict([{ ...base(), tags: ['x'.repeat(PERSONA_TAG_MAX + 1)] }]),
    /tag/,
  );
  assert.throws(
    () => validate.validatePersonasStrict([{
      ...base(),
      tags: Array.from({ length: TAGS_PER_PERSONA_LIMIT + 1 }, (_, i) => `t${i}`),
    }]),
    /tags/,
  );
});

test('load DROPS a bad tag where save refuses it, and the cap survives junk', () => {
  const [p] = normalize.normalizePersonaArray([
    { ...base(), tags: ['late-night', '-nope', 42, 'LATE-NIGHT', 'flagship'] },
  ])!;
  assert.deepEqual(p.tags, ['late-night', 'flagship'], 'the persona keeps its real tags');

  // The cap applies AFTER the validity filter, so junk cannot spend the budget
  // the operator's own tags need.
  const junk = Array.from({ length: TAGS_PER_PERSONA_LIMIT }, () => 'NOT A TAG');
  const [q] = normalize.normalizePersonaArray([{ ...base(), tags: [...junk, 'kept'] }])!;
  assert.deepEqual(q.tags, ['kept']);
});

test('an untagged persona loads and saves identically — the upgrade is a no-op', () => {
  const [saved] = validate.validatePersonasStrict([base()]);
  const [loaded] = normalize.normalizePersonaArray([base()])!;
  assert.deepEqual(saved.tags, []);
  assert.deepEqual(saved.tags, loaded.tags);
  // Absent is NOT a stand-in for "all tags" the way an absent `skills` is for
  // "all skills" — a persona that carries no tags carries no tags.
  assert.notEqual(saved.tags, null);
});

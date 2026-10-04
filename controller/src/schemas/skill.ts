// Shared skill schema — the operator-editable half of a skill (its SKILL.md
// frontmatter + brief), executed on BOTH sides. The controller runs it in
// routes/dj.ts for create, custom-edit, built-in-edit and community-install;
// the browser runs the mirrored copy (web/lib/schemas.generated.ts) in the
// skill editor.
//
// HARD RULE: this file may import ONLY from 'zod'. It is copied verbatim into
// the web bundle, so a project import or a node builtin here breaks the mirror.
// Enforced by controller/eslint.config.mjs and by gen-schemas.ts.
//
// What is deliberately NOT here: the knobs a skill declares for itself in its
// tool.mjs (`configFields`). Those are RUNTIME data — the declaration arrives
// from an imported module, not from the request — and skills/config-fields.ts
// already owns their parse/coerce rules. That also means a skill-file body is
// NOT a closed shape: the fixed fields below are validated here, and the raw
// body still travels on to the declared-knob pass. A `z.object` would strip
// those keys, which is the same silent-drop the shows conversion hit.
import { z } from 'zod';

// Custom-skill slug: lowercase, starts alphanumeric, then alphanumeric/hyphen,
// ≤49 chars. Anchored, so it can't contain '/', '.', or whitespace — the admin
// routes rely on that to keep a slug from escaping state/skills/.
//
// Homed here rather than in skills/loader.ts (which re-exports it as SLUG_RE,
// so no call site moved) because it was already hand-copied into the web
// editor. settings/vocab.ts's SKILL_SLUG_RE — the shape check on a persona's
// `skills[]` entries — is now an alias of this one too; it used to be a
// SEPARATE pattern (`/^[a-z0-9-]{1,40}$/`) that disagreed in both directions:
// it accepted `-nope`, which no skill can be called, and rejected a real
// 41–49-char slug, so a legitimately-named skill could not be assigned to a
// persona.
export const SKILL_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,48}$/;

// Freeform organisation tags (`tags: late-night, factual`) — operator
// vocabulary for filtering the admin skill list.
export const SKILL_TAG_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const TAGS_PER_SKILL_LIMIT = 8;

// "90m" | "6h" | "2d" | "45s" | "45" (bare = minutes). The loader parses the
// same shapes; an empty value means "use the default".
export const SKILL_COOLDOWN_RE = /^\d+\s*[smhd]?$/;

// A skill may declare an env var it needs before it can fire (`requiresKey`).
export const SKILL_ENV_KEY_RE = /^[A-Z][A-Z0-9_]*$/;

// Optional dedicated cron schedule ("0 * * * *") that fires the skill
// immediately, bypassing the cooldown/frequency gate.
//
// SHAPE ONLY — 5 fields, or 6 with node-cron's optional leading SECONDS field.
// This file may import only zod, so the per-field range check (`59 * * * *` is
// shape-valid and `99 * * * *` is not) belongs to node-cron's own validate(),
// which routes/dj.ts runs at save time and scheduler.ts runs again at
// registration. Both halves are needed and neither is redundant: the route
// catches what an operator types, the scheduler catches what a hand-edited
// SKILL.md carries.
//
// The 6-field arm is not decoration. node-cron 3.x accepts `0 0 8 * * *`, so a
// disk-authored one registers and fires — and a 5-only pattern here would then
// refuse the admin form's save of ANY field on that skill, because the editor
// round-trips the cron value it loaded. A working config the UI cannot edit is
// worse than one it never accepted.
export const SKILL_CRON_RE = /^\S+(?:\s+\S+){4,5}$/;

// When a custom skill may air. 'commute' restricts it to the commute hours;
// 'any' is the default and is NOT written to frontmatter.
export const SKILL_WINDOWS = ['any', 'commute'] as const;
export type SkillWindow = (typeof SKILL_WINDOWS)[number];

// The "right now" context vocabulary a segment may weave in (#471). Homed here
// because it is validated on both sides: the controller checks a submitted
// `context:` list against it, and the editor renders one chip per entry. The
// web copy was a hand-maintained CONTEXT_FIELDS_FALLBACK array; llm's
// prompts/context.ts re-exports this one, so there is a single vocabulary.
export const CONTEXT_FIELDS = ['date', 'clock', 'time', 'weather', 'festival', 'show', 'listeners'] as const;
export type ContextField = (typeof CONTEXT_FIELDS)[number];

// Lenient counterpart to skillTagsSchema, for tags read off a hand-edited
// SKILL.md (skills/loader.ts re-exports it as parseTags). Same rules, opposite
// posture: an invalid tag is DROPPED rather than refused, because a frontmatter
// typo should cost the skill a filter chip, not stop it loading. Living beside
// the strict schema is what keeps the two from drifting.
export function normalizeSkillTags(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  const out: string[] = [];
  for (const item of list) {
    const tag = String(item ?? '').trim().toLowerCase();
    if (!SKILL_TAG_RE.test(tag) || out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= TAGS_PER_SKILL_LIMIT) break;
  }
  return out;
}

// Comma-string OR array — both wire shapes the admin form and the community
// catalog have always sent. Tokens are trimmed + lowercased; empties dropped.
function skillTokenList(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  return list.map((s) => String(s ?? '').trim().toLowerCase()).filter(Boolean);
}

// Messages carry no field name: firstMessage() prefixes the dotted path
// (`cooldown: must look like …`), so restating it here reads twice.

// Explicit null reads as "absent" on every optional field — the hand-rolled
// builders these schemas replaced read `typeof b.cooldown === 'string' ? … :
// ''`, so a client PUTting `cooldown: null` has always meant "use the
// default". zod's .optional() accepts only undefined, so without this a null
// would 400 an edit that used to save cleanly. (Named per-module: the mirror
// is one flat file, so this can't share show.ts's nullToUndefined.)
const skillNullToUndefined = (v: unknown) => (v == null ? undefined : v);

export const skillSlugSchema = z
  .string({ error: 'name must be a lowercase slug (a–z, 0–9, hyphens), 1–49 chars' })
  .trim()
  .toLowerCase()
  .regex(SKILL_SLUG_RE, 'must be a lowercase slug (a–z, 0–9, hyphens), 1–49 chars');

// Optional display name. NOTE this now REJECTS a non-string where the
// hand-rolled builder silently ignored it (`typeof b.label === 'string' && …`),
// the same call the webhook conversion made: a value dropped on the floor is a
// value the operator watches disappear on the next reload.
const skillLabelSchema = z.preprocess(
  skillNullToUndefined,
  z
    .string({ error: 'must be text' })
    .trim()
    .optional()
    .transform((v) => v || undefined),
);

const skillCooldownSchema = z.preprocess(
  skillNullToUndefined,
  z
    .string({ error: 'must be text' })
    .trim()
    .optional()
    .refine(
      (v) => !v || SKILL_COOLDOWN_RE.test(v),
      'must look like "45m", "6h", "2d", or a bare number (minutes)',
    )
    .transform((v) => v || undefined),
);

// An EMPTY selection is meaningful: it resets the skill to the default context
// profile, so [] and '' both land on undefined (no `context:` line written).
const skillContextSchema = z
  .union([z.null(), z.array(z.unknown()), z.string()])
  .optional()
  .transform((v) => (v == null ? undefined : skillTokenList(v)))
  .check((c) => {
    const toks = c.value;
    if (!toks) return;
    const bad = toks.filter((t) => !(CONTEXT_FIELDS as readonly string[]).includes(t));
    if (bad.length) {
      c.issues.push({
        code: 'custom',
        input: c.value,
        message: `unknown context field(s): ${bad.join(', ')} — valid: ${CONTEXT_FIELDS.join(', ')}`,
      });
    }
  })
  .transform((toks) => (toks && toks.length ? toks : undefined));

// Strict tags — a bad tag 400s instead of vanishing. The lenient
// normalizeSkillTags above is the disk-side twin.
export const skillTagsSchema = z
  .union([z.null(), z.array(z.unknown()), z.string()])
  .optional()
  .transform((v) => (v == null ? undefined : skillTokenList(v)))
  .check((c) => {
    const toks = c.value;
    if (!toks) return;
    for (const tag of toks) {
      if (!SKILL_TAG_RE.test(tag)) {
        c.issues.push({
          code: 'custom',
          input: c.value,
          message: `invalid tag "${tag}" — lowercase slugs (a-z, 0-9, hyphens), max 24 chars`,
        });
      }
    }
    if (new Set(toks).size > TAGS_PER_SKILL_LIMIT) {
      c.issues.push({
        code: 'custom',
        input: c.value,
        message: `at most ${TAGS_PER_SKILL_LIMIT} tags per skill`,
      });
    }
  })
  .transform((toks) => {
    if (!toks) return undefined;
    const out: string[] = [];
    for (const t of toks) if (!out.includes(t)) out.push(t);
    return out.length ? out : undefined;
  });

const skillBriefSchema = z
  .string({ error: 'a brief is required — what the DJ says, and when to stay quiet' })
  .trim()
  .min(1, 'a brief is required — what the DJ says, and when to stay quiet');

// 'any' is the default and writes no frontmatter line, so it lands on
// undefined exactly like an absent value.
const skillWindowSchema = z.preprocess(
  skillNullToUndefined,
  z
    .string({ error: 'must be "any" or "commute"' })
    .trim()
    .toLowerCase()
    .optional()
    .refine(
      (v) => v === undefined || (SKILL_WINDOWS as readonly string[]).includes(v),
      'must be "any" or "commute"',
    )
    .transform((v) => (v === 'commute' ? ('commute' as const) : undefined)),
);

const skillRequiresKeySchema = z.preprocess(
  skillNullToUndefined,
  z
    .string({ error: 'must be an env var name (UPPER_SNAKE_CASE)' })
    .trim()
    .optional()
    .refine(
      (v) => !v || SKILL_ENV_KEY_RE.test(v),
      'must be an env var name (UPPER_SNAKE_CASE)',
    )
    .transform((v) => v || undefined),
);

const skillCronSchema = z.preprocess(
  skillNullToUndefined,
  z
    .string({ error: 'must be text' })
    .trim()
    .optional()
    .refine(
      (v) => !v || SKILL_CRON_RE.test(v),
      'must be a cron expression of 5 fields, or 6 with seconds (e.g. "0 * * * *")',
    )
    .transform((v) => v || undefined),
);

// Optional companion to `cron:` — when true, the skill is withheld from the
// autonomous segment director's random selection (availableCapabilities() in
// skills/_agent.ts) and fires ONLY when its cron timer ticks. Without this a
// skill with a `cron:` expression is still off-cooldown eligible for random
// picks between timer fires, which is surprising for a skill authored to
// speak at a specific, meaningful moment (e.g. "7:10, dabbers").
//
// Absent → false, same posture as persona djMode: present must be a real
// boolean rather than silently coerced, since a truthy typo here would
// silently withhold a skill from ever airing outside its cron window.
const skillCronOnlySchema = z.preprocess(
  skillNullToUndefined,
  z.boolean({ error: 'cronOnly must be a boolean' }).default(false),
);

// Opt-in multi-persona discussion. Absent/null stays false for compatibility;
// a present form value must be a literal boolean so a typo cannot silently turn
// a normal skill into a multi-voice exchange.
const skillCohostsSchema = z.preprocess(
  skillNullToUndefined,
  z.boolean({ error: 'cohosts must be a boolean' }).default(false),
);

// A skill's own TTS voice override — the same slot shape a persona carries
// (`{engine, voice, cloudProvider}`), minus inherit/gain/speed: absent means
// "the on-air DJ's voice", set means this skill always speaks in its own.
// Engine + provider vocabularies are restated here (not imported from
// persona.ts) because this module may import only zod — the mirror is one
// flat file. scripts/skill-voice.test.ts pins them equal to the persona
// originals, the same posture as the three tag-regex declarations.
//
// Why the two lists must match at all: a skill pins the SAME engine vocabulary
// a persona does, so a skill must never become the one surface where a valid,
// working engine is unreachable. That is why the pin is a deepEqual rather
// than a subset check. ADDING AN ENGINE means adding it HERE in the same change —
// the pin in scripts/skill-voice.test.ts is what makes the omission fail loudly
// rather than quietly leaving one surface behind.
// ─────────────────────────────────────────────────────────────────────────
// `gemini` joins because `TTS_ENGINES` already contains it: a skill pins the
// same engine vocabulary a persona does, so leaving it off here would make the
// skill surface the one place a working engine cannot be selected. The comment
// above says to add an engine HERE in the same change, and the deepEqual in
// scripts/skill-voice.test.ts is what makes the omission fail loudly — it did,
// on the rebase that brought this branch level with develop.
export const SKILL_VOICE_ENGINES = [
  'piper',
  'kokoro',
  'chatterbox',
  'pocket-tts',
  'cloud',
  'remote',
  'gemini',
] as const;

export const SKILL_VOICE_PROVIDERS = [
  'openai',
  'elevenlabs',
  'fish-audio',
  'openai-compatible',
] as const;

export const SKILL_VOICE_MAX = 100;

// Flat frontmatter keys, so hand edits stay one line each and the loader's
// flat Record<string, string> needs no new shape.
export const SKILL_VOICE_ENGINE_KEY = 'voiceEngine';
export const SKILL_VOICE_ID_KEY = 'voiceId';
export const SKILL_VOICE_PROVIDER_KEY = 'voiceProvider';

// A voice id that could escape the voice folder: path separators, parent
// refs, or absolute paths. chatterbox/pocket-tts resolve such values as
// reference files, so a hand-edited or imported SKILL.md must never smuggle
// one in through these keys.
function isUnsafeVoiceId(value: string): boolean {
  const v = value.trim();
  return (
    v.includes('/') ||
    v.includes('\\') ||
    v === '..' ||
    v.startsWith('../') ||
    v.startsWith('..\\') ||
    /^[A-Za-z]:/.test(v) ||
    v.startsWith('/')
  );
}

// Lenient read of the three flat keys into a slot, or null when no override.
// Disk-side twin of skillVoiceSlotSchema below: a hand-edited SKILL.md with a
// bad engine — or an unsafe voice id — reads as "no override" rather than
// failing the skill, while the strict schema refuses the same value from the
// admin form.
export function normalizeSkillVoice(data: Record<string, unknown> | null | undefined): {
  engine: string;
  voice: string;
  cloudProvider: string;
} | null {
  if (!data) return null;
  const engine = String((data as Record<string, unknown>)[SKILL_VOICE_ENGINE_KEY] ?? '').trim();
  if (!engine) return null;
  if (!(SKILL_VOICE_ENGINES as readonly string[]).includes(engine)) return null;
  const voice = String((data as Record<string, unknown>)[SKILL_VOICE_ID_KEY] ?? '').trim().slice(0, SKILL_VOICE_MAX);
  if (voice && isUnsafeVoiceId(voice)) return null;
  const provider = String((data as Record<string, unknown>)[SKILL_VOICE_PROVIDER_KEY] ?? '').trim();
  return {
    engine,
    voice,
    cloudProvider: (SKILL_VOICE_PROVIDERS as readonly string[]).includes(provider) ? provider : 'openai',
  };
}

// Strict form-side twin: null/undefined reads as "no override" (same as the
// other optional skill fields); a present block must name a real engine, and
// per-engine voice rules mirror ttsVoiceSlotSchema in persona.ts. Path-like
// voice ids are refused outright — see isUnsafeVoiceId.
const skillVoiceSlotSchema = z
  .union([z.null(), z.undefined(), z.unknown()])
  .optional()
  .transform((raw, ctx) => {
    if (raw == null) return undefined;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      ctx.issues.push({ code: 'custom', input: raw, message: 'voice must be an object or null' });
      return z.NEVER;
    }
    const t = raw as Record<string, unknown>;
    const engine = String(t.engine ?? '').trim();
    if (!(SKILL_VOICE_ENGINES as readonly string[]).includes(engine)) {
      ctx.issues.push({
        code: 'custom',
        input: raw,
        message: `voice.engine must be one of: ${SKILL_VOICE_ENGINES.join(', ')}`,
      });
      return z.NEVER;
    }
    const providerRaw = String(t.cloudProvider ?? 'openai').trim() || 'openai';
    if (!(SKILL_VOICE_PROVIDERS as readonly string[]).includes(providerRaw)) {
      ctx.issues.push({
        code: 'custom',
        input: raw,
        message: `voice.cloudProvider must be one of: ${SKILL_VOICE_PROVIDERS.join(', ')}`,
      });
      return z.NEVER;
    }
    let voice = String(t.voice ?? '').trim();
    const fail = (message: string) => {
      ctx.issues.push({ code: 'custom', input: raw, message });
      return z.NEVER;
    };
    if (voice.length > SKILL_VOICE_MAX) return fail(`voice.voice must be 0-${SKILL_VOICE_MAX} chars`);
    if (voice && isUnsafeVoiceId(voice)) {
      return fail('voice.voice must not be a path — a voice id or filename, never a directory traversal');
    }
    if (engine === 'kokoro' && !/^[a-z]{2}_[a-z0-9]+$/.test(voice)) {
      return fail('voice.voice must match <lang><gender>_<name> for kokoro, e.g. bf_isabella');
    }
    if (engine === 'chatterbox' && voice && !/^[A-Za-z0-9_.-]{1,80}\.wav$/.test(voice)) {
      return fail('voice.voice for chatterbox must be a .wav filename (no path), or empty for the default voice');
    }
    if (engine === 'pocket-tts') {
      if (!voice) voice = 'alba';
      if (!/^[a-z][a-z0-9_-]{0,39}$/.test(voice) && !/^[A-Za-z0-9_.-]{1,80}\.wav$/.test(voice)) {
        return fail('voice.voice for pocket-tts must be a built-in voice id (e.g. alba) or a .wav filename');
      }
    }
    if (engine === 'cloud' && providerRaw !== 'openai-compatible' && !voice) voice = 'alloy';
    if (engine === 'piper' && voice && !/^[A-Za-z0-9_.-]{1,100}\.onnx$/.test(voice) && !/^[a-z]{2}_[a-z0-9]+$/.test(voice)) {
      return fail('voice.voice for piper must be an .onnx filename (no path), or empty for the default voice');
    }
    return { engine, voice, cloudProvider: providerRaw };
  });

// The fields every skill's SKILL.md carries, built-in or custom.
export const builtinSkillFileSchema = z.object({
  voice: skillVoiceSlotSchema,
  label: skillLabelSchema,
  cooldown: skillCooldownSchema,
  cron: skillCronSchema,
  cronOnly: skillCronOnlySchema,
  cohosts: skillCohostsSchema,
  context: skillContextSchema,
  tags: skillTagsSchema,
  brief: skillBriefSchema,
});

// A custom skill owns two more: it declares its own airing window and its own
// env-var gate. A built-in's are fixed by its shipped template, which is why
// the built-in edit route has never read them off the body.
export const customSkillFileSchema = builtinSkillFileSchema.extend({
  window: skillWindowSchema,
  requiresKey: skillRequiresKeySchema,
});

/** The right schema for this skill: custom skills carry window + requiresKey. */
export function skillFileSchema(custom: boolean) {
  return custom ? customSkillFileSchema : builtinSkillFileSchema;
}

// Create adds the slug, which is the skill's immutable identity (edit takes it
// from the URL instead).
export const skillCreateSchema = customSkillFileSchema.extend({
  name: skillSlugSchema,
});

export type SkillFileInput = z.input<typeof customSkillFileSchema>;
export type SkillFileParsed = z.output<typeof builtinSkillFileSchema> &
  Partial<z.output<typeof customSkillFileSchema>>;

/**
 * Parsed body → the field object writeSkillFile consumes. The only real work
 * is the `context` → `contextFields` rename; it lives here so the create,
 * custom-edit, built-in-edit and community-install paths can't each pick a
 * slightly different mapping (they used to, and the built-in branch was a
 * 35-line copy of the custom one).
 */
export function skillFieldsFrom(kind: string, parsed: SkillFileParsed) {
  return {
    kind,
    label: parsed.label,
    cooldown: parsed.cooldown,
    cron: parsed.cron,
    cronOnly: parsed.cronOnly,
    cohosts: parsed.cohosts,
    contextFields: parsed.context,
    window: parsed.window,
    requiresKey: parsed.requiresKey,
    tags: parsed.tags,
    brief: parsed.brief,
    voice: parsed.voice ?? null,
  };
}

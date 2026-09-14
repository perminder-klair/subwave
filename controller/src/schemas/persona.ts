// Shared persona + prompt-library schema — a DJ persona's shape and the
// `{engine, voice, cloudProvider}` voice slot. Run by validatePersonasStrict
// (the update() chokepoint), normalizePersona (the lenient load path) and the
// mirrored browser copy.
//
// PERSONA_ID_RE and PERSONA_SKILL_SLUG_RE are re-declarations of show.ts's
// SHOW_ID_RE and skill.ts's SKILL_SLUG_RE: a mirrored module may import only
// zod, and the flat mirror forbids reusing the names. Pinned in step by
// scripts/persona-schema.test.ts. Impure rules (id minting, cross-row dedupe)
// live in persona-server.ts, which is not mirrored. settings/vocab.ts
// re-exports every constant below.
import { z } from 'zod';

/** Entity id. Same pattern as SHOW_ID_RE — see the header. */
export const PERSONA_ID_RE = /^[a-z0-9_]{3,32}$/;

/** Same pattern as schemas/skill.ts's SKILL_SLUG_RE — see the header. */
export const PERSONA_SKILL_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,48}$/;

// A BARE BASENAME, never a path: the id half reuses PERSONA_ID_RE's character
// class so the field cannot reference a file outside the avatar dir.
export const PERSONA_AVATAR_FILENAME_RE = /^[a-z0-9_]{3,32}\.(png|jpe?g|webp)$/;

export const PERSONA_LIMIT = 48;
export const PERSONA_NAME_MAX = 40;
export const PERSONA_TAGLINE_MAX = 80;
export const PERSONA_LANGUAGE_MAX = 60;
// A soul rides in the system prompt on every call: a per-call token cost.
export const PERSONA_SOUL_MAX = 2000;
export const PERSONA_SKILLS_LIMIT = 64;

// Freeform organisation tags. Third copy of one pattern (skill.ts, show.ts) —
// see the header.
export const PERSONA_TAG_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const PERSONA_TAG_MAX = 24;
export const TAGS_PER_PERSONA_LIMIT = 8;

export const PERSONA_FREQUENCIES = [
  'silent',
  'quiet',
  'moderate',
  'chatty',
  'aggressive',
] as const;

export const PERSONA_SCRIPT_LENGTHS = [
  'one-liner',
  'concise',
  'extended',
  'storyteller',
] as const;

// 'natural' (default) is the ordinary between-track link; 'announce' is exactly
// "This is <artist>." Absent/invalid → 'natural', so an upgrade is unchanged.
export const PERSONA_LINK_STYLES = [
  'natural',
  'announce',
] as const;

// Per-persona tone dials — 0-10 with 5 the neutral default.
export const PERSONA_DIAL_MIN = 0;
export const PERSONA_DIAL_MAX = 10;
export const PERSONA_DIAL_NEUTRAL = 5;

/** Clamp to an integer dial, neutral when unparseable. Never throws, on either
 *  path: a garbage dial cannot fail a persona save. */
export function clampPersonaDial(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n)
    ? Math.min(PERSONA_DIAL_MAX, Math.max(PERSONA_DIAL_MIN, n))
    : PERSONA_DIAL_NEUTRAL;
}

// The `{engine, voice, cloudProvider, gainDb, speed}` block, shared by every
// persona's `tts` and by the station rescue slot (`settings.tts.fallback`) — a
// fallback slot is handed to speakWith() as a synthetic persona.

export const TTS_ENGINES = [
  'piper',
  'kokoro',
  'chatterbox',
  'pocket-tts',
  'cloud',
  'remote',
] as const;

/**
 * "Use whatever the station is set to" — a PERSONA-only engine value, and
 * deliberately NOT a member of TTS_ENGINES: that list is also the vocabulary for
 * `tts.defaultEngine`, the per-engine gainDb/speed maps and the rescue slot,
 * none of which can inherit. Admitted only behind `allowInherit`.
 */
export const PERSONA_TTS_INHERIT = 'inherit';

/** The engine vocabulary a PERSONA slot accepts: inherit, then the real ones. */
export const PERSONA_TTS_ENGINES = [PERSONA_TTS_INHERIT, ...TTS_ENGINES] as const;

/**
 * The engines sharing ONE voice id-space, so the only ones a voice on an INHERIT
 * slot may carry to (#454). Every other engine reads the field as something else
 * — a reference .wav, a built-in id, a provider-specific name — so a voice
 * chosen without knowing the engine fails the synth or 400s there.
 */
export const TTS_INHERITABLE_VOICE_ENGINES = ['piper', 'kokoro'] as const;

export const TTS_CLOUD_PROVIDERS = [
  'openai',
  'elevenlabs',
  'fish-audio',
  'openai-compatible',
] as const;

// Kokoro voice ids are `<lang><gender>_<name>`, e.g. bf_isabella.
export const TTS_KOKORO_VOICE_RE = /^[a-z]{2}_[a-z0-9]+$/;
// Chatterbox (and pocket-tts zero-shot cloning) voices are reference-WAV
// filenames in the shared voice folder — no path separators.
export const TTS_CHATTERBOX_VOICE_RE = /^[A-Za-z0-9_.-]{1,80}\.wav$/;
// PocketTTS built-in voice ids (alba, anna, charles, …).
export const TTS_POCKET_VOICE_RE = /^[a-z][a-z0-9_-]{0,39}$/;
// Piper voices are `.onnx` filenames in the shared voice folder.
export const TTS_PIPER_VOICE_RE = /^[A-Za-z0-9_.-]{1,100}\.onnx$/;

export const TTS_VOICE_MAX = 100;

export const TTS_GAIN_CLAMP_DB = 12;
export const TTS_SPEED_MIN = 0.5;
export const TTS_SPEED_MAX = 2.0;
export const TTS_SPEED_DEFAULT = 1.0;

/** Finite, clamped to ±TTS_GAIN_CLAMP_DB, rounded to 0.1 dB; non-finite → 0. */
export function clampTtsGain(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const c = Math.max(-TTS_GAIN_CLAMP_DB, Math.min(TTS_GAIN_CLAMP_DB, n));
  return Math.round(c * 10) / 10;
}

/** Speech-rate multiplier. Unset is unity, NOT 0 — 0 would clamp to the 0.5
 *  floor instead of meaning no change. */
export function clampTtsSpeed(v: unknown): number {
  if (v === null || v === undefined || v === '') return TTS_SPEED_DEFAULT;
  const n = Number(v);
  if (!Number.isFinite(n)) return TTS_SPEED_DEFAULT;
  const c = Math.max(TTS_SPEED_MIN, Math.min(TTS_SPEED_MAX, n));
  return Math.round(c * 20) / 20;
}

export interface TtsVoiceSlot {
  engine: string;
  cloudProvider: string;
  voice: string;
  gainDb: number;
  speed: number;
}

/**
 * The strict voice slot, as a factory over the settings path prefix. `where` is
 * a parameter because the messages embed the location in their text and both
 * call sites read them as a flat toast string.
 *
 * One transform rather than a z.object because the rules are SEQUENTIAL: engine
 * decides which voice rule applies, so a voice issue must not be reported before
 * an engine issue.
 */
export function ttsVoiceSlotSchema(where: string, opts?: { allowInherit?: boolean }) {
  const allowInherit = opts?.allowInherit === true;
  const engines: readonly string[] = allowInherit ? PERSONA_TTS_ENGINES : TTS_ENGINES;
  // `.optional()` so an ABSENT block reaches the transform and is refused by the
  // engine rule below rather than by zod's generic 'expected nonoptional'.
  return z.unknown().optional().transform((raw, ctx): TtsVoiceSlot => {
    // An absent or non-object block reads as "all defaults", so a persona
    // written before this block existed still validates.
    const t = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

    const engine = t.engine as string;
    if (!engines.includes(engine)) {
      ctx.addIssue({
        code: 'custom',
        message: `${where}.engine must be one of: ${engines.join(', ')}`,
      });
      return z.NEVER;
    }
    const cloudProvider = t.cloudProvider as string;
    if (!(TTS_CLOUD_PROVIDERS as readonly string[]).includes(cloudProvider)) {
      ctx.addIssue({
        code: 'custom',
        message: `${where}.cloudProvider must be one of: ${TTS_CLOUD_PROVIDERS.join(', ')}`,
      });
      return z.NEVER;
    }

    // String(x ?? '') and not z.string(): a numeric voice id from an older admin
    // build has always coerced.
    let voice = String(t.voice ?? '').trim();
    const fail = (message: string) => {
      ctx.addIssue({ code: 'custom', message });
      return z.NEVER;
    };

    if (engine === 'kokoro') {
      if (!TTS_KOKORO_VOICE_RE.test(voice)) {
        return fail(
          `${where}.voice must match <lang><gender>_<name> for kokoro, e.g. bf_isabella`,
        );
      }
    } else if (engine === 'chatterbox') {
      // Empty = built-in default voice.
      if (voice && !TTS_CHATTERBOX_VOICE_RE.test(voice)) {
        return fail(
          `${where}.voice for chatterbox must be a .wav filename (no path), or empty for the default voice`,
        );
      }
    } else if (engine === 'pocket-tts') {
      // A built-in voice id OR a .wav filename for zero-shot cloning (#213).
      if (!voice) voice = 'alba';
      if (!TTS_POCKET_VOICE_RE.test(voice) && !TTS_CHATTERBOX_VOICE_RE.test(voice)) {
        return fail(
          `${where}.voice for pocket-tts must be a built-in voice id (e.g. alba) or a .wav filename`,
        );
      }
    } else if (engine === 'cloud') {
      // openai-compatible voices are server-specific; empty lets the server use
      // its own default. openai/elevenlabs both require a voice id.
      if (cloudProvider === 'openai-compatible') {
        if (voice.length > TTS_VOICE_MAX) {
          return fail(`${where}.voice must be 0-${TTS_VOICE_MAX} chars`);
        }
      } else if (voice.length < 1 || voice.length > TTS_VOICE_MAX) {
        return fail(`${where}.voice must be 1-${TTS_VOICE_MAX} chars`);
      }
    } else if (engine === 'remote' || engine === PERSONA_TTS_INHERIT) {
      // remote: sidecar-interpreted ids. inherit: no engine is known yet, so no
      // per-engine rule can apply (resolvePersonaVoiceSlot decides at speak
      // time). Both leave only the length cap, and empty is valid.
      if (voice.length > TTS_VOICE_MAX) {
        return fail(`${where}.voice must be 0-${TTS_VOICE_MAX} chars`);
      }
    } else {
      // piper: empty = the baked-in default; a Kokoro-shaped id is also accepted
      // (the seed roster carries one per persona, #454).
      if (
        voice &&
        !TTS_PIPER_VOICE_RE.test(voice) &&
        !TTS_KOKORO_VOICE_RE.test(voice)
      ) {
        return fail(
          `${where}.voice for piper must be an .onnx filename (no path), or empty for the default voice`,
        );
      }
    }

    return {
      engine,
      cloudProvider,
      voice,
      gainDb: clampTtsGain(t.gainDb),
      speed: clampTtsSpeed(t.speed),
    };
  });
}

/** The lenient LOAD-path twin of ttsVoiceSlotSchema: where the schema refuses,
 *  this resets to a value it accepts, so the output is always schema-valid. */
export function repairTtsVoiceSlot(raw: unknown, opts?: { allowInherit?: boolean }): TtsVoiceSlot {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const engines: readonly string[] = opts?.allowInherit === true ? PERSONA_TTS_ENGINES : TTS_ENGINES;
  // 'piper' and not PERSONA_TTS_INHERIT: an unreadable engine must land on the
  // piper floor, never on a value that re-points the persona at the station.
  const engine = engines.includes(r.engine as string)
    ? (r.engine as string)
    : 'piper';
  const cloudProvider = (TTS_CLOUD_PROVIDERS as readonly string[]).includes(
    r.cloudProvider as string,
  )
    ? (r.cloudProvider as string)
    : 'openai';
  let voice =
    typeof r.voice === 'string' && r.voice.trim()
      ? r.voice.trim().slice(0, TTS_VOICE_MAX)
      : '';

  if (engine === 'kokoro' && !TTS_KOKORO_VOICE_RE.test(voice)) voice = 'bf_isabella';
  // Invalid chatterbox filenames reset to empty, not to a Kokoro id.
  if (engine === 'chatterbox' && voice && !TTS_CHATTERBOX_VOICE_RE.test(voice)) voice = '';
  if (
    engine === 'pocket-tts' &&
    (!voice ||
      (!TTS_POCKET_VOICE_RE.test(voice) && !TTS_CHATTERBOX_VOICE_RE.test(voice)))
  ) {
    voice = 'alba';
  }
  // A Kokoro-shaped id under piper is PRESERVED, not wiped — see the schema.
  if (
    engine === 'piper' &&
    voice &&
    !TTS_PIPER_VOICE_RE.test(voice) &&
    !TTS_KOKORO_VOICE_RE.test(voice)
  ) {
    voice = '';
  }
  if (!voice && engine === 'cloud' && cloudProvider !== 'openai-compatible') voice = 'alloy';
  // The kokoro floor. PERSONA_TTS_INHERIT is excluded alongside the engines that
  // read empty as "your own default": an inherit slot has no engine yet, so
  // there is no id-space to pick a floor from.
  if (
    !voice &&
    engine !== 'cloud' &&
    engine !== 'chatterbox' &&
    engine !== 'piper' &&
    engine !== 'remote' &&
    engine !== PERSONA_TTS_INHERIT
  ) {
    voice = 'bf_isabella';
  }
  return {
    engine,
    cloudProvider,
    voice,
    gainDb: clampTtsGain(r.gainDb),
    speed: clampTtsSpeed(r.speed),
  };
}

// Explicit null reads as "absent" on every OPTIONAL field; zod's `.default()`
// fires only on undefined.
const personaNullToUndefined = (v: unknown) => (v == null ? undefined : v);

// `String(x ?? '').trim()` + a length check, NOT z.string(): a numeric or
// boolean value stringifies (a persona named `123` saves). The message names its
// own field because it is also the flat `error` a 400 carries.
//
// The `.optional()` is load-bearing on every z.unknown() field here: zod 4 reads
// a bare z.unknown() inside z.object as a REQUIRED key and refuses an absent one
// before the transform runs, so an omitted tagline or dial would fail.
function personaCoercedText(field: string, min: number, max: number) {
  return z.unknown().optional().transform((raw, ctx) => {
    const v = String(raw ?? '').trim();
    if (v.length < min || v.length > max) {
      ctx.addIssue({ code: 'custom', message: `${field} must be ${min}-${max} chars` });
      return z.NEVER;
    }
    return v;
  });
}

export interface PersonaParsed {
  id?: string;
  name: string;
  tagline: string;
  frequency: string;
  scriptLength: string;
  djMode: boolean;
  linkStyle: string;
  humour: number;
  localColour: number;
  warmth: number;
  soul: string;
  language: string;
  avatar: string;
  tts: TtsVoiceSlot;
  skills: string[] | null;
  tags: string[];
}

// Array or comma string, trimmed + lowercased, empties dropped — the same two
// wire shapes the skill and show tag fields accept.
function personaTagList(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  return list.map((s) => String(s ?? '').trim().toLowerCase()).filter(Boolean);
}

/**
 * Organisation only — tags steer nothing on air and are not published publicly.
 * A bad tag is REFUSED, unlike the sibling `skills` list: a tag is typed by hand
 * in the editor, so losing one silently is the operator's input vanishing.
 * repairPersonaTags below is the lenient load-path twin.
 */
const personaTags = z
  .union([z.null(), z.array(z.unknown()), z.string()])
  .optional()
  .transform((v) => (v == null ? [] : personaTagList(v)))
  .check((c) => {
    for (const tag of c.value) {
      if (!PERSONA_TAG_RE.test(tag)) {
        c.issues.push({
          code: 'custom',
          input: c.value,
          message: `invalid tag "${tag}" — lowercase slugs (a-z, 0-9, hyphens), max ${PERSONA_TAG_MAX} chars`,
        });
      }
    }
    if (new Set(c.value).size > TAGS_PER_PERSONA_LIMIT) {
      c.issues.push({
        code: 'custom',
        input: c.value,
        message: `tags must be at most ${TAGS_PER_PERSONA_LIMIT} entries`,
      });
    }
  })
  .transform((toks) => [...new Set(toks)]);

// `id` is optional and a malformed one is DROPPED, not refused: it is what every
// show's personaId, guest list and activePersonaId point at, so refusing one bad
// id in a backup would refuse the whole roster. resolvePersonaIds mints a
// replacement. Field ORDER matters — zod reports issues in declaration order.
export const personaSchema = z
  .object({
    name: personaCoercedText('name', 1, PERSONA_NAME_MAX),
    soul: personaCoercedText('soul', 1, PERSONA_SOUL_MAX),
    tagline: personaCoercedText('tagline', 0, PERSONA_TAGLINE_MAX),
    // Optional free text. Absent/empty → '' (English, no directive injected).
    // Unlike name/soul this REFUSES a non-string instead of coercing.
    language: z.preprocess(
      personaNullToUndefined,
      z
        .string({ error: 'language must be a string' })
        .trim()
        .max(PERSONA_LANGUAGE_MAX, `language must be 0-${PERSONA_LANGUAGE_MAX} chars`)
        .default(''),
    ),
    frequency: z.enum(PERSONA_FREQUENCIES, {
      error: `frequency must be one of: ${PERSONA_FREQUENCIES.join(', ')}`,
    }),
    scriptLength: z.preprocess(
      personaNullToUndefined,
      z
        .enum(PERSONA_SCRIPT_LENGTHS, {
          error: `scriptLength must be one of: ${PERSONA_SCRIPT_LENGTHS.join(', ')}`,
        })
        .default('concise'),
    ),
    // Absent → false. Present must be a real boolean (unlike a show's `=== true`
    // booleans): the strict path has always refused a non-boolean here.
    djMode: z.preprocess(
      personaNullToUndefined,
      z.boolean({ error: 'djMode must be a boolean' }).default(false),
    ),
    linkStyle: z.preprocess(
      personaNullToUndefined,
      z
        .enum(PERSONA_LINK_STYLES, {
          error: `linkStyle must be one of: ${PERSONA_LINK_STYLES.join(', ')}`,
        })
        .default('natural'),
    ),
    // An absent dial reads as neutral (clampPersonaDial of undefined).
    humour: z.unknown().optional().transform(clampPersonaDial),
    localColour: z.unknown().optional().transform(clampPersonaDial),
    warmth: z.unknown().optional().transform(clampPersonaDial),
    // A bare basename, never a path; the upload route is the only file writer.
    avatar: z.preprocess(
      (v) => (v == null || v === '' ? undefined : v),
      z
        .unknown()
        .transform((raw, ctx) => {
          const a = String(raw).trim();
          if (!PERSONA_AVATAR_FILENAME_RE.test(a)) {
            ctx.addIssue({
              code: 'custom',
              message: 'avatar must be a basename like <id>.png|jpg|jpeg|webp',
            });
            return z.NEVER;
          }
          return a;
        })
        .optional()
        .transform((v) => v ?? ''),
    ),
    tts: ttsVoiceSlotSchema('tts', { allowInherit: true }),
    // Absent → null ("all skills", the legacy default).
    skills: z.preprocess(
      personaNullToUndefined,
      z
        .array(z.unknown(), { error: 'skills must be an array of skill names' })
        .max(PERSONA_SKILLS_LIMIT, `skills must be at most ${PERSONA_SKILLS_LIMIT} entries`)
        .transform((items) => {
          // A malformed entry is DROPPED, not refused: skills is a subscription
          // resolved against the live catalogue, so a bad entry is inert, and a
          // backup can legitimately carry one (#917).
          const seen = new Set<string>();
          const out: string[] = [];
          for (const s of items) {
            const v = String(s ?? '').trim();
            if (!PERSONA_SKILL_SLUG_RE.test(v)) continue;
            if (seen.has(v)) continue;
            seen.add(v);
            out.push(v);
          }
          return out;
        })
        .nullable()
        .default(null),
    ),
    // Declared after skills and emitted last below, so issue order and persisted
    // key order are unchanged.
    tags: personaTags,
    id: z.preprocess(
      // A malformed id reads as absent so resolvePersonaIds mints one.
      (v) => (typeof v === 'string' && PERSONA_ID_RE.test(v) ? v : undefined),
      z.string().optional(),
    ),
  })
  // The persisted key order, which fixtures and the backup diff rely on.
  .transform(
    (p): PersonaParsed => ({
      id: p.id,
      name: p.name,
      tagline: p.tagline,
      frequency: p.frequency,
      scriptLength: p.scriptLength,
      djMode: p.djMode,
      linkStyle: p.linkStyle,
      humour: p.humour,
      localColour: p.localColour,
      warmth: p.warmth,
      soul: p.soul,
      language: p.language,
      avatar: p.avatar,
      tts: p.tts,
      skills: p.skills,
      tags: p.tags,
    }),
  );

/** The whole roster. The floor is 1, not 0 — a station with no persona has no
 *  one to speak, and settings.load() falls back to the seeded roster. */
export const personasSchema = z
  .array(personaSchema, { error: `personas must be an array of 1-${PERSONA_LIMIT} entries` })
  .min(1, `personas must be an array of 1-${PERSONA_LIMIT} entries`)
  .max(PERSONA_LIMIT, `personas must be an array of 1-${PERSONA_LIMIT} entries`);

/**
 * Every per-field repair the LOAD path applies before parsing. `undefined` lets
 * the schema's own default apply; each repair lands on a value the strict path
 * accepts, and the schema is still run on the result. A row that cannot be
 * repaired (no name, no soul) fails the parse and the caller drops it.
 *
 * `skillRenames` travels as plain data (zod-only module); the browser passes {}.
 */
export function repairPersonaForLoad(
  raw: Record<string, unknown>,
  skillRenames: Record<string, string> = {},
): Record<string, unknown> {
  return {
    ...raw,
    id: typeof raw.id === 'string' && PERSONA_ID_RE.test(raw.id) ? raw.id : undefined,
    name: typeof raw.name === 'string' ? raw.name.trim().slice(0, PERSONA_NAME_MAX) : undefined,
    soul: typeof raw.soul === 'string' ? raw.soul.trim().slice(0, PERSONA_SOUL_MAX) : undefined,
    tagline:
      typeof raw.tagline === 'string' ? raw.tagline.trim().slice(0, PERSONA_TAGLINE_MAX) : '',
    language:
      typeof raw.language === 'string'
        ? raw.language.trim().slice(0, PERSONA_LANGUAGE_MAX)
        : undefined,
    frequency: (PERSONA_FREQUENCIES as readonly string[]).includes(raw.frequency as string)
      ? raw.frequency
      : 'moderate',
    scriptLength: (PERSONA_SCRIPT_LENGTHS as readonly string[]).includes(
      raw.scriptLength as string,
    )
      ? raw.scriptLength
      : undefined,
    djMode: raw.djMode === true ? true : undefined,
    linkStyle: (PERSONA_LINK_STYLES as readonly string[]).includes(raw.linkStyle as string)
      ? raw.linkStyle
      : undefined,
    avatar:
      typeof raw.avatar === 'string' && PERSONA_AVATAR_FILENAME_RE.test(raw.avatar.trim())
        ? raw.avatar.trim()
        : undefined,
    tts: repairTtsVoiceSlot(raw.tts, { allowInherit: true }),
    // Non-array → undefined → the schema's null default ("all skills"). Renames
    // are applied here, not in the schema: a rename migrates stored data rather
    // than stating a rule a submitted value must satisfy.
    skills: Array.isArray(raw.skills)
      ? raw.skills
          .filter((s): s is string => typeof s === 'string')
          .map((s) => skillRenames[s.trim()] || s.trim())
          .filter((s) => PERSONA_SKILL_SLUG_RE.test(s))
          .slice(0, PERSONA_SKILLS_LIMIT)
      : undefined,
    tags: repairPersonaTags(raw.tags),
  };
}

/** Tags, repaired: lowercased, invalid dropped, deduped, capped. The cap applies
 *  AFTER the validity filter so junk does not spend the real tags' budget. */
export function repairPersonaTags(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const tag = item.trim().toLowerCase();
    if (!PERSONA_TAG_RE.test(tag) || out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= TAGS_PER_PERSONA_LIMIT) break;
  }
  return out;
}

export const DJ_PROMPT_LIMIT = 20;
export const DJ_PROMPT_NAME_MAX = 60;
export const DJ_PROMPT_TEXT_MIN = 50;
export const DJ_PROMPT_TEXT_MAX = 4000;
/** Every prompt template must address the persona by name. */
export const DJ_PROMPT_PLACEHOLDER = '{name}';

export interface DjPromptParsed {
  id?: string;
  name: string;
  text: string;
}

export const djPromptSchema = z
  .object({
    name: personaCoercedText('name', 1, DJ_PROMPT_NAME_MAX),
    text: z.unknown().optional().transform((raw, ctx) => {
      const v = String(raw ?? '').trim();
      if (v.length < DJ_PROMPT_TEXT_MIN || v.length > DJ_PROMPT_TEXT_MAX) {
        ctx.addIssue({
          code: 'custom',
          message: `text must be ${DJ_PROMPT_TEXT_MIN}-${DJ_PROMPT_TEXT_MAX} chars`,
        });
        return z.NEVER;
      }
      if (!v.includes(DJ_PROMPT_PLACEHOLDER)) {
        ctx.addIssue({
          code: 'custom',
          message: `text must contain the ${DJ_PROMPT_PLACEHOLDER} placeholder`,
        });
        return z.NEVER;
      }
      return v;
    }),
    id: z.preprocess(
      (v) => (typeof v === 'string' && PERSONA_ID_RE.test(v) ? v : undefined),
      z.string().optional(),
    ),
  })
  .transform((p): DjPromptParsed => ({ id: p.id, name: p.name, text: p.text }));

export const djPromptsSchema = z
  .array(djPromptSchema, {
    error: `djPrompts must be an array of 0-${DJ_PROMPT_LIMIT} entries`,
  })
  .max(DJ_PROMPT_LIMIT, `djPrompts must be an array of 0-${DJ_PROMPT_LIMIT} entries`);

/**
 * The LOAD path's repair for one prompt entry. Only `name` is repairable — the
 * text IS the entry, so an unrenderable one drops the row. `fallbackName` comes
 * from the caller: it numbers by SURVIVING row, which this module cannot know.
 */
export function repairDjPromptForLoad(
  raw: Record<string, unknown>,
  fallbackName: string,
): Record<string, unknown> {
  const name =
    (typeof raw.name === 'string' ? raw.name.trim().slice(0, DJ_PROMPT_NAME_MAX) : '') ||
    fallbackName;
  return {
    ...raw,
    id: typeof raw.id === 'string' && PERSONA_ID_RE.test(raw.id) ? raw.id : undefined,
    name,
  };
}

/**
 * Personas that will NOT speak through the station voice `{engine, provider}` —
 * what the admin DJ Brain section warns about and its one-click fix patches to
 * 'inherit'. A persona already on `inherit` is never listed.
 *
 * `provider` matters: the four cloud providers share one dispatcher but are
 * independent targets, so cloud/openai does not follow an openai-compatible
 * station voice. Omit it to compare on engine alone.
 */
export function personasPinningOtherEngine(
  personas:
    | Array<{
        id?: unknown;
        name?: unknown;
        tts?: { engine?: unknown; cloudProvider?: unknown } | null;
      }>
    | null
    | undefined,
  engine: string,
  provider?: string,
): Array<{ id: string; name: string; engine: string }> {
  if (!Array.isArray(personas)) return [];
  return personas
    .filter((p) => {
      const e = p?.tts?.engine;
      if (typeof e !== 'string' || e === PERSONA_TTS_INHERIT) return false;
      if (e !== engine) return true;
      // Same engine: only a cloud slot can still miss, and only when the caller
      // named the provider it means.
      if (e !== 'cloud' || !provider) return false;
      return p?.tts?.cloudProvider !== provider;
    })
    .map((p) => {
      const e = String(p.tts?.engine ?? '');
      const cp = p.tts?.cloudProvider;
      return {
        id: String(p.id ?? ''),
        name: String(p.name ?? p.id ?? ''),
        // A cloud pin is only meaningful with its provider.
        engine: e === 'cloud' && typeof cp === 'string' && cp ? `${e} / ${cp}` : e,
      };
    });
}

/** The slice of `settings.tts` the resolution depends on. */
export interface StationVoiceDefaults {
  /** settings.tts.defaultEngine — the engine an inherit slot resolves to. */
  defaultEngine?: unknown;
  /** settings.tts.cloud — provider + voice used when that engine is 'cloud'. */
  cloud?: { provider?: unknown; voice?: unknown } | null;
}

const CARRIES_VOICE: readonly string[] = TTS_INHERITABLE_VOICE_ENGINES;

/** Resolve a persona voice slot against the station defaults. Unchanged unless
 *  the engine is the inherit sentinel; null in is null out, so callers can pass
 *  whatever djPersonaTts() gave them. */
export function resolvePersonaVoiceSlot(
  slot: Partial<TtsVoiceSlot> | null | undefined,
  station: StationVoiceDefaults | null | undefined,
): TtsVoiceSlot | null | undefined {
  if (!slot) return slot as null | undefined;
  if (slot.engine !== PERSONA_TTS_INHERIT) return slot as TtsVoiceSlot;

  // 'piper' is the same floor settings.load() coerces an unreadable
  // defaultEngine to, so a broken settings file still resolves to an engine.
  const engine =
    typeof station?.defaultEngine === 'string' && station.defaultEngine
      ? station.defaultEngine
      : 'piper';

  // Per-persona dials, not per-engine: they survive resolution untouched.
  const gainDb = typeof slot.gainDb === 'number' ? slot.gainDb : 0;
  const speed = typeof slot.speed === 'number' ? slot.speed : 1;

  if (engine === 'cloud') {
    const cloud = station?.cloud || {};
    return {
      engine,
      // The station's provider AND voice: an inherit slot never named a cloud
      // provider, and its own voice belongs to another id-space.
      cloudProvider: typeof cloud.provider === 'string' && cloud.provider ? cloud.provider : 'openai',
      voice: typeof cloud.voice === 'string' ? cloud.voice : '',
      gainDb,
      speed,
    };
  }

  return {
    engine,
    // Carried through so a later reroute onto `cloud` still has a provider to
    // check keys against; only read while the engine IS cloud.
    cloudProvider:
      typeof slot.cloudProvider === 'string' && slot.cloudProvider ? slot.cloudProvider : 'openai',
    // Only piper/kokoro share the seed roster's id-space; elsewhere '' is the
    // engine's own default.
    voice: CARRIES_VOICE.includes(engine) && typeof slot.voice === 'string' ? slot.voice : '',
    gainDb,
    speed,
  };
}

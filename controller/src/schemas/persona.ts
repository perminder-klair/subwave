// Shared persona + prompt-library schema — the single source of truth for a
// DJ persona's shape and for the `{engine, voice, cloudProvider}` voice slot,
// executed on BOTH sides. The controller runs it in
// settings.validate.validatePersonasStrict (the update() chokepoint) and in
// settings.normalize.normalizePersona (the lenient load path); the browser runs
// the mirrored copy (web/lib/schemas.generated.ts) so the Personas editor can
// pre-flight a save against the exact rules the controller enforces.
//
// HARD RULE: this file may import ONLY from 'zod'. It is copied verbatim into
// the web bundle, so a project import or a node builtin here breaks the mirror.
// That includes OTHER schema modules — the mirror is one flat concatenation, so
// gen-schemas.ts rejects every specifier but 'zod', enforces unique top-level
// names across every module, and each module has to stand alone.
//
// WHICH IS WHY TWO REGEXES ARE DECLARED HERE RATHER THAN IMPORTED
// ---------------------------------------------------------------
// `PERSONA_ID_RE` is the same pattern as schemas/show.ts's SHOW_ID_RE, and
// `PERSONA_SKILL_SLUG_RE` the same as schemas/skill.ts's SKILL_SLUG_RE. Neither
// can be imported (see above), and neither can reuse the other's NAME because
// the flat mirror would then carry two declarations of it. Re-declaring is
// structural, not sloppiness; the drift it invites is pinned by
// scripts/persona-schema.test.ts, which asserts `.source` equality against both.
//
// WHY THERE IS NO FACTORY
// -----------------------
// Unlike a show, a persona CAN be validated against itself: every rule is a pure
// function of the submitted value. `skills` names skill slugs, but an unresolved
// slug is dropped rather than refused, so the live catalogue is not an input.
// Impure rules — id minting, cross-row de-duplication — live in
// persona-server.ts, which is NOT mirrored.
//
// SETTINGS/VOCAB.TS RE-EXPORTS EVERY CONSTANT BELOW
// -------------------------------------------------
// "First feature converted owns the constant", so no call site moved: vocab.ts
// aliases these under the names the controller already used. The web side must
// read them from the mirror rather than hand-copying.
import { z } from 'zod';

// ── Persona vocabulary ───────────────────────────────────────────────────────

/** Entity id. Same pattern as SHOW_ID_RE — see the header. */
export const PERSONA_ID_RE = /^[a-z0-9_]{3,32}$/;

/** Same pattern as schemas/skill.ts's SKILL_SLUG_RE — see the header. */
export const PERSONA_SKILL_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,48}$/;

// An avatar is stored as a BARE BASENAME, never a path: the id half reuses
// PERSONA_ID_RE's character class so the field can never reference a file
// outside the avatar dir.
export const PERSONA_AVATAR_FILENAME_RE = /^[a-z0-9_]{3,32}\.(png|jpe?g|webp)$/;

export const PERSONA_LIMIT = 48;
export const PERSONA_NAME_MAX = 40;
export const PERSONA_TAGLINE_MAX = 80;
export const PERSONA_LANGUAGE_MAX = 60;
// Every persona's soul rides in the system prompt on every call, so this is a
// recurring per-call token cost rather than a structural limit.
export const PERSONA_SOUL_MAX = 2000;
export const PERSONA_SKILLS_LIMIT = 64;

// Freeform organisation tags — operator vocabulary for filtering and grouping
// the admin roster. Third copy of one pattern (skill.ts, show.ts) on purpose:
// a mirrored schema module may import only zod, so the alternative to three
// declarations is no mirror. See the header.
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

// 'natural' (default) writes the ordinary between-track link — set the track
// up, name the artist or capture its feel, vary the opener. 'announce' is a
// matter-of-fact station: the link is exactly "This is <artist>." or "Next
// up, <artist>." — nothing else. Absent/invalid → 'natural', same posture as
// djMode's absent → false, so an upgraded station keeps its old links.
export const PERSONA_LINK_STYLES = [
  'natural',
  'announce',
] as const;

// Per-persona tone dials — 0-10 with 5 the neutral default.
export const PERSONA_DIAL_MIN = 0;
export const PERSONA_DIAL_MAX = 10;
export const PERSONA_DIAL_NEUTRAL = 5;

/**
 * Clamp any input to an integer dial, defaulting to neutral when unparseable.
 *
 * Never throws, on EITHER path — the strict validator has always run the same
 * coercion the lenient one does, so a garbage dial has never been able to fail
 * a persona save. Reproduced verbatim rather than tightened.
 */
export function clampPersonaDial(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n)
    ? Math.min(PERSONA_DIAL_MAX, Math.max(PERSONA_DIAL_MIN, n))
    : PERSONA_DIAL_NEUTRAL;
}

// ── TTS voice slot ───────────────────────────────────────────────────────────
//
// The `{engine, voice, cloudProvider, gainDb, speed}` block. Shared by every
// persona's `tts` AND by the station-wide rescue slot (`settings.tts.fallback`)
// — the two carry the same shape by design, because a fallback slot is handed
// to speakWith() as a synthetic persona. One implementation is what stops the
// per-engine voice rules drifting between them.

export const TTS_ENGINES = [
  'piper',
  'kokoro',
  'chatterbox',
  'pocket-tts',
  'cloud',
  'remote',
] as const;

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

/**
 * Coerce any value to a clean gain: finite, clamped to ±TTS_GAIN_CLAMP_DB,
 * rounded to 0.1 dB. Garbage / non-finite → 0 (unity).
 */
export function clampTtsGain(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const c = Math.max(-TTS_GAIN_CLAMP_DB, Math.min(TTS_GAIN_CLAMP_DB, n));
  return Math.round(c * 10) / 10;
}

/**
 * Coerce any value to a clean speech-rate multiplier.
 *
 * Unset (null/undefined/'') is unity, NOT 0 — unlike gain, 0 is not this dial's
 * default and would clamp to the 0.5 floor instead of no-change.
 */
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
 * The strict voice slot, as a factory over the settings path prefix.
 *
 * `where` is a FACTORY PARAMETER rather than a path zod derives, because these
 * messages have always embedded the location in the text ("tts.fallback.voice
 * must …") and both call sites read them as a flat toast string. The persona
 * array passes `personas[].tts` and the station slot passes `tts.fallback`, so
 * an operator reading a 400 still learns which of the two failed.
 *
 * Implemented as one transform rather than a z.object because the rules are
 * SEQUENTIAL and cross-field: engine decides which voice rule applies, so
 * reporting a voice issue before an engine issue would name a rule the operator
 * never opted into. A transform reports exactly the first failure the
 * hand-rolled validator reported, in the same order.
 */
export function ttsVoiceSlotSchema(where: string) {
  // `.optional()` so an ABSENT block reaches the transform and is refused by the
  // engine rule below ("tts.engine must be one of: …") rather than by zod's
  // generic 'expected nonoptional' — the hand-rolled validator's `raw || {}`
  // gave the operator the useful message, and that is the one worth keeping.
  return z.unknown().optional().transform((raw, ctx): TtsVoiceSlot => {
    // `raw || {}` — an absent or non-object block reads as "all defaults", which
    // is how a persona written before this block existed still validates.
    const t = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

    const engine = t.engine as string;
    if (!(TTS_ENGINES as readonly string[]).includes(engine)) {
      ctx.addIssue({
        code: 'custom',
        message: `${where}.engine must be one of: ${TTS_ENGINES.join(', ')}`,
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

    // String(x ?? '') and not z.string(): a numeric voice id posted by an older
    // admin build has always coerced, and refusing it now would be a tightening.
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
    } else if (engine === 'remote') {
      // Server-specific — the sidecar interprets them. Empty is valid.
      if (voice.length > TTS_VOICE_MAX) {
        return fail(`${where}.voice must be 0-${TTS_VOICE_MAX} chars`);
      }
    } else {
      // piper: empty = the baked-in default. A Kokoro-shaped id is also
      // accepted — the seed roster carries one per persona under piper so
      // switching to Kokoro yields distinct voices with no extra editing, and
      // resolvePiperVoice() falls back gracefully for it (#454).
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

/**
 * The lenient twin of ttsVoiceSlotSchema — the LOAD path.
 *
 * Where the schema refuses, this resets to a value the schema accepts. The
 * output is therefore always schema-valid, which is what lets the load path run
 * the real schema after repairing rather than maintaining a second set of rules.
 */
export function repairTtsVoiceSlot(raw: unknown): TtsVoiceSlot {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const engine = (TTS_ENGINES as readonly string[]).includes(r.engine as string)
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
  // Invalid chatterbox filenames reset to empty rather than being rewritten to
  // a Kokoro id.
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
  if (
    !voice &&
    engine !== 'cloud' &&
    engine !== 'chatterbox' &&
    engine !== 'piper' &&
    engine !== 'remote'
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

// ── Persona ──────────────────────────────────────────────────────────────────

// Explicit null reads as "absent" on every OPTIONAL field. The pre-schema
// validator accepted null everywhere it accepted an omission (`String(x ?? '')`,
// `!== undefined && !== null` guards), and clients that write null for an empty
// field relied on it. zod's `.default()` fires only on undefined.
const personaNullToUndefined = (v: unknown) => (v == null ? undefined : v);

/**
 * `String(x ?? '').trim()` then a length check — the exact coercion the
 * hand-rolled validator applied to name/soul/tagline.
 *
 * Deliberately NOT `z.string()`: a numeric or boolean value stringifies today
 * (a persona named `123` saves), and refusing it would be a tightening. The
 * message names its own field because it is also the flat `error` a 400 carries.
 */
// The `.optional()` is load-bearing on every z.unknown() field in this module,
// and is NOT the same statement as "this field may be omitted". zod 4 treats a
// bare z.unknown() inside z.object as a REQUIRED key and refuses an absent one
// with 'expected nonoptional' before the transform ever runs — so without it a
// persona that simply omits `tagline` (or a dial) fails, where the hand-rolled
// validator read the omission as '' and 5 respectively. Optionality here restores
// that: the transform still runs, and `String(undefined ?? '')` is what decides
// the outcome — '' passes a min of 0 and fails a min of 1, exactly as before.
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

/**
 * One persona.
 *
 * `id` is OPTIONAL and a malformed one is DROPPED rather than refused — the
 * same call the shows conversion made, and for a stronger reason: a persona id
 * is what every show's `personaId`, every guest list and `activePersonaId` point
 * at, so refusing one bad id in a backup would refuse the whole roster.
 * persona-server.ts's resolvePersonaIds mints the replacement.
 *
 * Field ORDER matters — zod reports issues in declaration order, and the
 * hand-rolled validator checked name → soul → tagline → language → frequency →
 * scriptLength → djMode → tts → skills → avatar. An operator with two bad
 * fields must still be told about the same one first.
 */
// Array or comma string, trimmed + lowercased, empties dropped — the same two
// wire shapes the skill and show tag fields accept.
function personaTagList(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  return list.map((s) => String(s ?? '').trim().toLowerCase()).filter(Boolean);
}

/**
 * Organisation only — tags steer nothing on air and are not published by the
 * public roster route.
 *
 * A bad tag is REFUSED, unlike the sibling `skills` list, and the difference is
 * deliberate: `skills` is a subscription resolved against a live catalogue
 * where a dead entry is inert, while a tag is typed by hand in the editor and
 * silently losing one is the operator watching their own input disappear on
 * reload. repairPersonaTags below is the lenient load-path twin.
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

export const personaSchema = z
  .object({
    name: personaCoercedText('name', 1, PERSONA_NAME_MAX),
    soul: personaCoercedText('soul', 1, PERSONA_SOUL_MAX),
    tagline: personaCoercedText('tagline', 0, PERSONA_TAGLINE_MAX),
    // language — optional free text ("Turkish", "Türkçe", …). Absent/empty → ''
    // (English, no directive injected). Unlike name/soul this one REFUSES a
    // non-string instead of coercing, which is what the validator did.
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
    // Absent → 'concise' (the default and the historical behaviour).
    scriptLength: z.preprocess(
      personaNullToUndefined,
      z
        .enum(PERSONA_SCRIPT_LENGTHS, {
          error: `scriptLength must be one of: ${PERSONA_SCRIPT_LENGTHS.join(', ')}`,
        })
        .default('concise'),
    ),
    // Absent → false (a plain narrator persona). Present must be a real boolean:
    // unlike the `=== true` booleans on a show, BOTH paths never agreed here —
    // the strict validator refused a non-boolean — so the refusal is preserved.
    djMode: z.preprocess(
      personaNullToUndefined,
      z.boolean({ error: 'djMode must be a boolean' }).default(false),
    ),
    // Absent → 'natural' (the historical link behaviour). See PERSONA_LINK_STYLES.
    linkStyle: z.preprocess(
      personaNullToUndefined,
      z
        .enum(PERSONA_LINK_STYLES, {
          error: `linkStyle must be one of: ${PERSONA_LINK_STYLES.join(', ')}`,
        })
        .default('natural'),
    ),
    // An absent dial reads as neutral, which is what clampPersonaDial returns
    // for undefined — see the note on personaCoercedText for the .optional().
    humour: z.unknown().optional().transform(clampPersonaDial),
    localColour: z.unknown().optional().transform(clampPersonaDial),
    warmth: z.unknown().optional().transform(clampPersonaDial),
    // A bare basename, never a path. The dedicated upload route is the only
    // writer that creates the file; this just checks the persisted string.
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
    tts: ttsVoiceSlotSchema('tts'),
    // skills — absent → null ("all skills", the legacy default). Present → an
    // explicit slug array.
    skills: z.preprocess(
      personaNullToUndefined,
      z
        .array(z.unknown(), { error: 'skills must be an array of skill names' })
        .max(PERSONA_SKILLS_LIMIT, `skills must be at most ${PERSONA_SKILLS_LIMIT} entries`)
        .transform((items) => {
          // A malformed entry is DROPPED, not refused. persona.skills is a
          // subscription list resolved against the live skill catalogue at fire
          // time, so an entry that can't name a skill can never fire — and the
          // OLD shape check accepted forms the slug rule refuses (a leading
          // hyphen), so a backup can legitimately carry one. Failing the whole
          // roster over inert junk is the themeId lesson (#917) again.
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
    // Declared AFTER skills and emitted last in the transform below, so both
    // the issue order an operator is told about and the persisted key order of
    // every pre-existing field are unchanged.
    tags: personaTags,
    id: z.preprocess(
      // A malformed id reads as absent so resolvePersonaIds mints one.
      (v) => (typeof v === 'string' && PERSONA_ID_RE.test(v) ? v : undefined),
      z.string().optional(),
    ),
  })
  // The persisted key order, which several fixtures and the backup diff rely on.
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

/**
 * The whole roster.
 *
 * A station with NO persona has no one to speak, which is why the floor is 1
 * rather than 0 — settings.load() falls back to the seeded roster instead.
 */
export const personasSchema = z
  .array(personaSchema, { error: `personas must be an array of 1-${PERSONA_LIMIT} entries` })
  .min(1, `personas must be an array of 1-${PERSONA_LIMIT} entries`)
  .max(PERSONA_LIMIT, `personas must be an array of 1-${PERSONA_LIMIT} entries`);

/**
 * Every per-field repair the LOAD path applies before parsing.
 *
 * `undefined` lets the schema's own default apply. Each repair lands on a value
 * the strict path accepts, so load and save still agree about what a valid
 * persona is — the schema itself is still run on the result. A row that cannot
 * be repaired into validity (no name, no soul) fails the parse and the caller
 * drops it, exactly as normalizePersona returned null.
 *
 * `skillRenames` travels as plain DATA rather than being imported, because this
 * module may import nothing but zod. The browser passes `{}`.
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
    tts: repairTtsVoiceSlot(raw.tts),
    // Non-array → undefined → the schema's null default ("all skills"), which is
    // what normalizeSkills returned. Renames are applied HERE and not in the
    // schema: a rename is a migration of stored data, not a rule a submitted
    // value has to satisfy, and the strict path has never applied them.
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

/**
 * Tags, repaired: lowercased, invalid entries dropped, de-duplicated, capped.
 * The cap applies AFTER the validity filter so junk in a hand-edited file does
 * not spend the budget the operator's real tags need. Non-array reads as absent
 * so the schema's [] default applies.
 */
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

// ── DJ prompt library ────────────────────────────────────────────────────────

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
 * The LOAD path's per-field repair for one prompt entry.
 *
 * Only `name` is repairable — the text IS the entry, so a text that can't render
 * drops the row rather than being invented. `fallbackName` is supplied by the
 * caller because the historical fallback ("Prompt 3") numbers by SURVIVING row,
 * which this module cannot know.
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

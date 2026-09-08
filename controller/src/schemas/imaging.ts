// Shared imaging schemas — sfx, beds, jingles and clone voices, one contract in
// four hats (name, description, prompt or jingle text, duration). Run at the
// route boundary and by the mirrored browser copy. Only the duration BANDS
// differ per kind; broadcast/sfx.ts, broadcast/beds.ts and audio/bed-gen.ts
// re-export them rather than declaring their own.
import { z } from 'zod';

export const IMAGING_NAME_MAX = 60;
export const IMAGING_DESCRIPTION_MAX = 200;
export const IMAGING_PROMPT_MAX = 500;
export const JINGLE_TEXT_MAX = 500;

// Sfx sit under a spoken line, so they cap below the generator's 22s ceiling;
// 0.5 is the ElevenLabs sound-gen minimum. sfx.ts re-exports the max as
// MAX_DURATION_SEC.
export const SFX_MIN_SEC = 0.5;
export const SFX_MAX_SEC = 10;
// A bed must outlast the script read over it; the ElevenLabs Music API caps at
// 2 minutes. beds.ts re-exports the min as MIN_DURATION_SEC, bed-gen.ts the max
// as BED_GEN_MAX_SEC.
export const BED_MIN_SEC = 30;
export const BED_GEN_MAX_SEC = 120;

// Explicit null reads as absent. (Named per-module: the mirror is one flat file.)
const imagingNullToUndefined = (v: unknown) => (v == null ? undefined : v);

const imagingName = z.preprocess(
  imagingNullToUndefined,
  z
    .string({ error: 'name is required' })
    .trim()
    .min(1, 'name is required')
    .max(IMAGING_NAME_MAX, `name must be 1-${IMAGING_NAME_MAX} chars`),
);

// No `.catch()`: it cannot tell a wrong type from a too-long value, so it would
// silently blank an over-long description. Refusing is the point.
const imagingDescription = z.preprocess(
  imagingNullToUndefined,
  z
    .string({ error: 'must be text' })
    .trim()
    .max(IMAGING_DESCRIPTION_MAX, `must be 0-${IMAGING_DESCRIPTION_MAX} chars`)
    .default(''),
);

// A duration knob: absent / '' means "let the generator decide"; a numeric
// string is what an <input type="number"> posts. The band is per kind.
function imagingDuration(band: { min: number; max: number }) {
  return z.preprocess(
    imagingNullToUndefined,
    z
      .union([z.literal(''), z.number(), z.string()])
      .optional()
      .transform((v) => (v === undefined || v === '' ? undefined : Number(v)))
      .refine((d) => d === undefined || (Number.isFinite(d) && d > 0), 'must be a positive number')
      .refine(
        (d) => d === undefined || d >= band.min,
        `must be at least ${band.min}s`,
      )
      .refine(
        (d) => d === undefined || d <= band.max,
        `is capped at ${band.max}s`,
      ),
  );
}

// POST /sfx — generate a stinger from a prompt.
export const sfxCreateSchema = z.object({
  name: imagingName,
  description: imagingDescription,
  prompt: z
    .string({ error: 'prompt is required' })
    .trim()
    .min(1, 'prompt is required')
    .max(IMAGING_PROMPT_MAX, `prompt too long (max ${IMAGING_PROMPT_MAX})`),
  durationSec: imagingDuration({ min: SFX_MIN_SEC, max: SFX_MAX_SEC }),
});

// POST /beds — generate an instrumental bed from a prompt.
export const bedCreateSchema = z.object({
  name: imagingName,
  description: imagingDescription,
  prompt: z
    .string({ error: 'prompt is required' })
    .trim()
    .min(1, 'prompt is required')
    .max(IMAGING_PROMPT_MAX, `prompt too long (max ${IMAGING_PROMPT_MAX})`),
  durationSec: imagingDuration({ min: BED_MIN_SEC, max: BED_GEN_MAX_SEC }),
});

// POST /jingles — render a TTS stinger from text.
export const jingleCreateSchema = z.object({
  text: z
    .string({ error: 'text is required' })
    .trim()
    .min(1, 'text is required')
    .max(JINGLE_TEXT_MAX, `text too long (max ${JINGLE_TEXT_MAX})`),
});

// The multipart import bodies. Must sit AFTER audioUpload in the route chain:
// multer parses the multipart body into req.body, and validateBody replaces
// req.body only — req.file rides through untouched.
export const imagingImportSchema = z.object({
  name: imagingName,
  description: imagingDescription,
});

// A jingle import's label is optional — an absent label falls back to the
// filename server-side.
export const jingleImportSchema = z.object({
  label: z.preprocess(
    imagingNullToUndefined,
    z
      .string({ error: 'must be text' })
      .trim()
      .max(IMAGING_DESCRIPTION_MAX, `must be 0-${IMAGING_DESCRIPTION_MAX} chars`)
      .optional()
      .transform((v) => v || undefined),
  ),
});

// A clone-voice import has no description: the folder keeps no JSON sidecar (it
// stays operator-writable by hand), so there is nowhere for one to live.
export const voiceImportSchema = z.object({
  name: imagingName,
});

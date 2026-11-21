// Optional evidence attached to a measured window. Neither this metadata nor
// agreement with librosa qualifies a track for any kind of stem transition.
import { z } from 'zod';

export const beatGridProvenanceSchema = z.object({
  version: z.literal(1),
  backend: z.literal('beat-this-onnx'),
  model: z.enum(['small0', 'custom']),
  modelSha256: z.string().regex(/^[a-f0-9]{64}$/),
  preprocessingVersion: z.literal(1),
  windowStartMs: z.number().int().nonnegative(),
  windowEndMs: z.number().int().positive(),
  evidence: z.object({
    medianBpm: z.number().positive().nullable(),
    intervalSupport: z.number().min(0).max(1).nullable(),
    librosaBeatSupport: z.number().min(0).max(1).nullable(),
  }),
  source: z.object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative(),
    complete: z.boolean().nullable(),
  }).optional(),
}).refine(v => v.windowEndMs > v.windowStartMs);

export type BeatGridProvenance = z.infer<typeof beatGridProvenanceSchema>;

export function parseBeatGridProvenance(value: unknown): BeatGridProvenance | null {
  const result = beatGridProvenanceSchema.safeParse(value);
  return result.success ? result.data : null;
}

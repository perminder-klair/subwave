import { z } from 'zod';

export const preparationResultSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(false), reason: z.string().max(500).optional() }),
  z.object({
    available: z.literal(true),
    subject: z.string().trim().min(1).max(160),
    data: z.json().default(null).refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 32768, 'preparation data must be at most 32 KB'),
    music: z.object({ type: z.literal('artist'), artistId: z.string().trim().min(1).max(256) }).optional(),
  }),
]);

export const preparationOccurrenceSchema = z.object({
  id: z.string().min(1), showId: z.string().min(1),
  source: z.enum(['scheduled', 'takeover']),
  startsAt: z.number().finite(), endsAt: z.number().finite(),
});

const preparationRecordBase = z.object({
  occurrence: preparationOccurrenceSchema,
  skill: z.string(), configuration: z.string(),
});
export const preparationRecordSchema = z.discriminatedUnion('kind', [
  preparationRecordBase.extend({
    kind: z.literal('failed'), reason: z.string(), attempts: z.number().int(), retryAt: z.number().nullable(),
  }),
  preparationRecordBase.extend({
    kind: z.literal('selected'),
    result: preparationResultSchema.options[1],
    attempts: z.number().int(), retryAt: z.number(), reason: z.string().nullable(),
  }),
  preparationRecordBase.extend({
    kind: z.literal('ready'), result: preparationResultSchema.options[1], preparedAt: z.number(),
  }),
]);
export const preparationStoreSchema = z.object({ version: z.literal(1), records: z.array(preparationRecordSchema).max(256) });
export type PreparationResult = z.output<typeof preparationResultSchema>;
export type AcceptedPreparation = Extract<PreparationResult, { available: true }>;
export type PreparationOccurrence = z.output<typeof preparationOccurrenceSchema>;
export type PreparationRecord = z.output<typeof preparationRecordSchema>;

export const preparationStatusSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unconfigured') }),
  z.object({ kind: z.enum(['selected', 'ready', 'failed', 'degraded']), occurrence: preparationOccurrenceSchema,
    skill: z.string(), subject: z.string().nullable(), reason: z.string().nullable() }),
]);
export type PreparationStatus = z.output<typeof preparationStatusSchema>;

export const preparationArtistSchema = z.object({ id: z.string().min(1), name: z.string().min(1), album: z.array(z.object({ id: z.string(), songCount: z.number().optional() })).default([]) });
export const preparationArtistCreditSchema = z.object({ id: z.string().min(1), name: z.string().optional() });
export const preparationTrackSchema = z.object({
  id: z.string().min(1), artistId: z.string().nullable().optional(),
  artists: z.array(preparationArtistCreditSchema).optional(),
  albumArtists: z.array(preparationArtistCreditSchema).optional(),
  title: z.string().default(''), artist: z.string().default(''),
  album: z.string().nullish().transform(value => value ?? undefined), albumId: z.string().nullish().transform(value => value ?? undefined),
  duration: z.number().nullable().optional(), durationSec: z.number().nullable().optional(),
  year: z.number().nullable().optional(),
}).passthrough();
export type PreparationTrack = z.output<typeof preparationTrackSchema>;

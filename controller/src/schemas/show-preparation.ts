import { z } from 'zod';

// 30 days of a densely programmed 168-slot week plus a small takeover buffer.
export const GENERATED_SHOW_RECORDS_MAX = 1024;

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

// Keep these limits aligned with schemas/show.ts (name/topic, filter-list,
// genre and year bounds). This store schema remains zod-only so the browser
// mirror can recover the persisted episode shape too.
export const generatedShowPlanSchema = z.object({
  name: z.string().trim().min(1).max(60),
  topic: z.string().trim().min(1).max(2000),
  moods: z.array(z.string().trim().min(1).max(64)).max(15),
  genres: z.array(z.string().trim().min(1).max(64)).max(15),
  eras: z.array(z.object({
    fromYear: z.number().int().min(1900).max(2100).nullable(),
    toYear: z.number().int().min(1900).max(2100).nullable(),
  }).refine(era => era.fromYear != null || era.toYear != null)
    .refine(era => era.fromYear == null || era.toYear == null || era.fromYear <= era.toYear)).max(15),
  energies: z.array(z.enum(['low', 'medium', 'high'])).max(15),
  filtersStrict: z.boolean(),
  rationale: z.string().trim().max(500),
});

export const generatedShowRecordSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ready'), occurrence: preparationOccurrenceSchema, configuration: z.string(),
    castSeed: z.string().max(100).optional(),
    castOrigin: z.string().max(200).optional(),
    sourceSettings: z.object({
      playlistIds: z.array(z.string()), playlistStrict: z.boolean(),
      excludedPlaylistIds: z.array(z.string()), maxTrackSeconds: z.number().nullable(),
      minTrackLengthSeconds: z.number().nullable(), vocals: z.enum(['', 'instrumental', 'vocal']),
    }).optional(),
    template: z.string(), hostPersonaId: z.string().min(1), guestPersonaIds: z.array(z.string()).max(3),
    plan: generatedShowPlanSchema, generatedAt: z.number().finite(),
  }),
  z.object({
    kind: z.literal('failed'), occurrence: preparationOccurrenceSchema, configuration: z.string(),
    castSeed: z.string().max(100).optional(),
    castOrigin: z.string().max(200).optional(),
    template: z.string(), hostPersonaId: z.string().min(1), guestPersonaIds: z.array(z.string()).max(3),
    reason: z.string().max(500), attempts: z.number().int().min(1), retryAt: z.number().nullable(),
  }),
]);

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
const preparationStoreV2Schema = z.object({
  version: z.literal(2),
  records: z.array(preparationRecordSchema).max(256),
  generated: z.array(generatedShowRecordSchema).max(GENERATED_SHOW_RECORDS_MAX).default([]),
});

export const preparationStoreSchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== 'object') return raw;
  const value = raw as Record<string, unknown>;
  return value.version === 1 ? { ...value, version: 2, generated: [] } : value;
}, preparationStoreV2Schema);
export type PreparationResult = z.output<typeof preparationResultSchema>;
export type AcceptedPreparation = Extract<PreparationResult, { available: true }>;
export type PreparationOccurrence = z.output<typeof preparationOccurrenceSchema>;
export type PreparationRecord = z.output<typeof preparationRecordSchema>;
export type GeneratedShowPlan = z.output<typeof generatedShowPlanSchema>;
export type GeneratedShowRecord = z.output<typeof generatedShowRecordSchema>;

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

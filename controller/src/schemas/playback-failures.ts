import { z } from 'zod';

// Preserve the historical reader's repair rules for missing or unsafe metadata.
// Never retain URLs, annotated URIs, absolute paths or unrecognised fields.
const playbackFailureScalarSchema = z.unknown().optional().transform((value): string | null => {
  if (typeof value !== 'string' || /(?:\w+:\/\/|^\/|^[A-Za-z]:\\|^annotate:)/.test(value)) return null;
  return value.slice(0, 500);
});

export const playbackFailureIdentitySchema = z.object({
  attemptId: playbackFailureScalarSchema.pipe(z.string().min(1)),
  sourceTrackId: playbackFailureScalarSchema,
  title: playbackFailureScalarSchema,
  artist: playbackFailureScalarSchema,
  album: playbackFailureScalarSchema,
  source: z.enum(['ai', 'request', 'operator']),
});

export const playbackFailureSchema = playbackFailureIdentitySchema.extend({
  t: z.string().refine(value => Number.isFinite(Date.parse(value)))
    .transform(value => new Date(value).toISOString()),
  stage: z.literal('fetch'),
  reason: z.literal('source-resolution-failed'),
});

export const playbackFailureEventSchema = playbackFailureSchema.extend({
  type: z.literal('track.failed'),
});

export const playbackFailureHistorySchema = z.object({
  failures: z.array(playbackFailureSchema),
  retentionDays: z.number(),
  truncated: z.boolean(),
  warnings: z.array(z.string()),
});

export type PlaybackFailure = z.output<typeof playbackFailureSchema>;
export type PlaybackFailureInput = Pick<PlaybackFailure, 'attemptId' | 'source'>
  & Partial<Pick<PlaybackFailure, 'sourceTrackId' | 'title' | 'artist' | 'album'>>;
export type PlaybackFailureHistory = z.output<typeof playbackFailureHistorySchema>;

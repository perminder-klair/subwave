import { z } from 'zod';

export const NOTEBOOK_HISTORY_LIMIT = 24;
export const NOTEBOOK_AIRING_LIMIT = 16;
export function notebookMemoryUpdateForTurns(maxTurns: number) {
  const turn = z.number().int().min(1).max(maxTurns)
    .describe('1-based index of the generated turn that actually voices this item; never an index into notebook history');
  return z.object({
    topic: z.object({ value: z.string().trim().min(1).max(500), turn }).nullable()
      .describe('first topic introduced in this segment, or null when the topic is already established'),
    contributions: z.array(z.object({
      turn,
      contributor: z.string().trim().min(1).max(100).describe('person whose new opinion is voiced in the referenced turn'),
      summary: z.string().trim().min(1).max(240)
        .describe('only a new opinion or substantive point actually voiced in this turn; never an invitation, question repetition, or copied history'),
    })).max(16).describe('new contributions from this segment only; empty when it only introduces or repeats the topic'),
  });
}
export const notebookMemoryUpdateSchema = notebookMemoryUpdateForTurns(16);
export type NotebookMemoryUpdate = z.infer<typeof notebookMemoryUpdateSchema>;
export const notebookRefSchema = z.object({
  skill: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(100),
  occurrenceId: z.string().regex(/^(?:scheduled|takeover):/).max(200), runId: z.string().uuid(),
  turn: z.number().int().min(1).max(16), voiceId: z.string().regex(/^[a-f0-9]{16}$/),
});
export type NotebookRef = z.infer<typeof notebookRefSchema>;
export const notebookClipSchema = z.object({
  voiceId: z.string().regex(/^[a-f0-9]{16}$/), text: z.string().max(3000), personaId: z.string().max(100),
  wavPath: z.string().max(4096).nullable(), meta: z.record(z.string(), z.unknown()).default({}),
  status: z.enum(['staged', 'ready', 'publishing', 'aired', 'cancelled']),
  airedAt: z.number().finite().nullable(),
});
const pendingSchema = z.object({
  id: z.string().uuid(), createdAt: z.number().finite(), expiresAt: z.number().finite(),
  revision: z.number().int().nonnegative(),
  update: notebookMemoryUpdateSchema.nullable(), clips: z.array(notebookClipSchema).max(16),
});
export const notebookEntrySchema = z.object({
  occurrence: z.object({ id: z.string().regex(/^(?:scheduled|takeover):/).max(200), showId: z.string().max(100), startsAt: z.number().finite(), endsAt: z.number().finite() }),
  revision: z.number().int().nonnegative(), topic: z.string().max(500).nullable(),
  contributionCount: z.number().int().nonnegative(),
  history: z.array(z.object({ id: z.string().max(100), contributor: z.string().max(100), summary: z.string().max(240), airedAt: z.number().finite() })).max(NOTEBOOK_HISTORY_LIMIT),
  pending: pendingSchema.nullable(),
}).superRefine((entry, ctx) => {
  if (entry.occurrence.endsAt <= entry.occurrence.startsAt) ctx.addIssue({ code: 'custom', message: 'invalid airing bounds' });
  if (new Set(entry.history.map(item => item.id)).size !== entry.history.length) ctx.addIssue({ code: 'custom', message: 'duplicate history receipts' });
  const pending = entry.pending;
  if (!pending) return;
  if (pending.revision > entry.revision || pending.expiresAt <= pending.createdAt) ctx.addIssue({ code: 'custom', message: 'invalid notebook lease' });
  if (pending.clips.length && !pending.update) ctx.addIssue({ code: 'custom', message: 'rendered notebook speech has no memory update' });
  if (new Set(pending.clips.map(clip => clip.voiceId)).size !== pending.clips.length) ctx.addIssue({ code: 'custom', message: 'duplicate voice receipts' });
  if (pending.update?.topic && (pending.update.topic.turn > pending.clips.length || (entry.topic !== null && pending.update.topic.value !== entry.topic))) ctx.addIssue({ code: 'custom', message: 'invalid pending topic' });
  if (pending.update?.contributions.some(item => item.turn > pending.clips.length)) ctx.addIssue({ code: 'custom', message: 'contribution references a missing turn' });
  for (const clip of pending.clips) {
    if (clip.status === 'aired' && clip.airedAt === null) ctx.addIssue({ code: 'custom', message: 'air receipt has no timestamp' });
    if (['ready', 'publishing', 'aired'].includes(clip.status) && !clip.wavPath) ctx.addIssue({ code: 'custom', message: 'rendered receipt has no WAV' });
  }
});
export type NotebookEntry = z.infer<typeof notebookEntrySchema>;
export const notebookFileSchema = z.object({
  version: z.literal(1), skill: z.string().max(100),
  airings: z.record(z.string().max(200), notebookEntrySchema).refine(entries => Object.keys(entries).length <= NOTEBOOK_AIRING_LIMIT && Object.entries(entries).every(([id, entry]) => id === entry.occurrence.id)),
});
export type NotebookFile = z.infer<typeof notebookFileSchema>;
export const notebookResetSchema = z.object({ expectedRevision: z.number().int().nonnegative(), expectedOccurrenceId: z.string().max(200).optional(), discardCorrupt: z.boolean().optional() });

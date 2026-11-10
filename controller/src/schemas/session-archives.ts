import { z } from 'zod';

// Read only the fields needed by the archive list; old sessions may omit them.
export const sessionArchiveSummaryInput = z.object({
  id: z.string().optional(),
  kind: z.string().optional(),
  key: z.string().optional(),
  startedAt: z.string().optional(),
  endedAt: z.string().nullable().optional(),
  show: z.object({ name: z.string().optional() }).nullable().optional(),
  persona: z.object({ name: z.string().optional() }).nullable().optional(),
  messages: z.unknown().optional(),
});

export const sessionArchivePageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
});

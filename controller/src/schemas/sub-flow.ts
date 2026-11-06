import { z } from 'zod';

export const subFlowNameSchema = z.object({
  name: z.string().trim().min(1).max(200),
});

export const subFlowInputSchema = subFlowNameSchema.extend({
  enabled: z.boolean(),
  trackIds: z.array(z.string().min(1).max(128)).min(2).max(3),
  revision: z.number().int().positive().optional(),
}).strict().refine(value => new Set(value.trackIds).size === value.trackIds.length, 'Tracks must be different');

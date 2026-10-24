import { z } from 'zod';

export const seriesCheckSchema = z.object({
  input: z.string().trim().min(1, 'Paste a MusicBrainz Series URL or MBID').max(500),
});

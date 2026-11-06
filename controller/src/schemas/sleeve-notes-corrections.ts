import { z } from 'zod';

export const researchMusicBrainzIdSchema = z.string().trim().max(200).transform(value => value.replace(/^https:\/\/musicbrainz\.org\/artist\//i,'').replace(/\/$/,'').toLowerCase())
  .refine(value => value === '' || /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value), 'Use a MusicBrainz artist link or artist ID.');
export const researchWikipediaUrlSchema = z.string().trim().max(1000).refine(value => {
  if (!value) return true;
  try {
    const url = new URL(value);
    const title = decodeURIComponent(url.pathname.slice(6));
    return url.protocol==='https:' && url.hostname==='en.wikipedia.org' && !url.port && !url.username && !url.password
      && !url.search && !url.hash && url.pathname.startsWith('/wiki/') && !!title.trim() && !/[:|#\u0000-\u001f\u007f]/u.test(title);
  } catch { return false; }
}, 'Use an English Wikipedia article link, without a section or query.');
export const researchOverrideSchema = z.object({musicBrainzId:researchMusicBrainzIdSchema,wikipediaUrl:researchWikipediaUrlSchema}).strict();
export type ResearchOverride = z.infer<typeof researchOverrideSchema>;
export const researchVerificationSchema = z.object({
  state:z.enum(['idle','running','complete','cancelled']), total:z.number(), checked:z.number(), found:z.number(), missing:z.number(), failed:z.number(), skipped:z.number(), startedAt:z.string().nullable(),
});
export type ResearchVerification = z.infer<typeof researchVerificationSchema>;

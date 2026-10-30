// Model preparation describes search intent; only controller code maps it to
// executable discovery tools. This data contains no tool names or call schema.
import { z } from 'zod';

export const shortlistSearchSchema = z.object({
  searches: z.array(z.object({
    kind: z.enum(['library', 'artist', 'recentArtist', 'theme', 'sound']),
    query: z.string().trim().min(1).max(120),
  }).strict().refine(search => !['theme', 'sound'].includes(search.kind) || search.query.length >= 3)).max(3),
}).strict();

export type ShortlistSearch = z.infer<typeof shortlistSearchSchema>['searches'][number];

// Semantic classification belongs to the model, in the brief's language.
// Controller grounding checks complete quoted sentences and literal subjects;
// it does not try to classify music with an English phrase list.
export const preparedShortlistSearchSchema = z.object({
  searches: z.array(shortlistSearchSchema.shape.searches.element.safeExtend({
    intent: z.enum(['artist', 'title', 'genre', 'recentArtist', 'theme', 'sound', 'general', 'presenter', 'exclude']),
    evidence: z.string().trim().max(320).nullable(),
  })).max(3),
}).strict();

const fold = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const words = new Intl.Segmenter(undefined, { granularity: 'word' });
const subjectWords = (text: string) => [...words.segment(fold(text))].filter(part => part.isWordLike).map(part => part.segment).join(' ');
const compact = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();
const sentences = new Intl.Segmenter(undefined, { granularity: 'sentence' });
const SEARCH_INTENTS: Record<ShortlistSearch['kind'], readonly string[]> = {
  library: ['artist', 'title', 'genre'], artist: ['artist'], recentArtist: ['recentArtist'],
  theme: ['theme'], sound: ['sound'],
};

export function groundShortlistSearches(
  searches: z.infer<typeof preparedShortlistSearchSchema>['searches'],
  fields: readonly string[],
  presenters: readonly string[] = [],
): ShortlistSearch[] {
  // Require the whole sentence, so a quote cannot hide its surrounding
  // prohibition. Intl's sentence boundaries also work for non-English briefs.
  const quotes = new Set(fields.flatMap(field => [...sentences.segment(field)].map(part => compact(part.segment))));
  const supported: ShortlistSearch[] = [];
  for (const { kind, query, evidence, intent } of searches) {
    if (!evidence || !SEARCH_INTENTS[kind].includes(intent) || !quotes.has(compact(evidence))) continue;
    const target = fold(query);
    if (!target || !(` ${subjectWords(evidence)} `).includes(` ${subjectWords(query)} `)) continue;
    if (['library', 'artist', 'recentArtist'].includes(kind) && presenters.some(name => {
      const presenter = fold(name);
      return presenter && (target === presenter || (presenter.includes(' ')
        && ((` ${target} `).includes(` ${presenter} `) || (` ${presenter} `).includes(` ${target} `))));
    })) continue;
    if (!supported.some(search => search.kind === kind && fold(search.query) === target)) supported.push({ kind, query });
  }
  return supported;
}

const SEARCH_SOURCES: Record<ShortlistSearch['kind'], string> = {
  library: 'searchLibrary', artist: 'topSongsByArtist', recentArtist: 'recentByArtist',
  theme: 'searchByLyrics', sound: 'searchBySound',
};

export function shortlistSearchCalls(searches: readonly ShortlistSearch[], available: ReadonlySet<string>) {
  const calls: Array<{ source: string; args: Record<string, string>; family: 'context' }> = [];
  const seen = new Set<string>();
  // Validate here too: the planner also accepts callers other than preparation.
  for (const search of searches.slice(0, 3)) {
    const parsed = shortlistSearchSchema.shape.searches.element.safeParse(search);
    if (!parsed.success) continue;
    const { kind, query } = parsed.data;
    const source = SEARCH_SOURCES[kind];
    const identity = `${kind}:${query.toLowerCase()}`;
    if (!available.has(source) || seen.has(identity)) continue;
    seen.add(identity);
    calls.push({ source, args: { [kind === 'artist' || kind === 'recentArtist' ? 'artist' : 'query']: query }, family: 'context' });
  }
  return calls;
}

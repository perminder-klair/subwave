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

// A model's claimed relevance is not grounding. Retain only queries whose
// supporting excerpt occurs in the input and describes that kind of music
// search. Presentation style and the presenter's biography are not repertoire.
export const preparedShortlistSearchSchema = z.object({
  searches: z.array(shortlistSearchSchema.shape.searches.element.safeExtend({
    evidence: z.string().trim().min(3).max(160).optional(),
  })).max(3),
}).strict();

const fold = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const compact = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();
const QUERY_FILLER = new Set('a an the and or of to for with in on by about featuring songs song tracks track music lyrics lyrical sounds sound'.split(' '));
const GENERIC_LIBRARY = /\b(?:album tracks?|deep cuts?|forgotten|overlooked|familiar favourites?|rediscoveries|everyday life|good conversation)\b/i;
const MUSIC_CUE = /\b(?:songs?|tracks?|music|albums?|records?|releases?|artists?|bands?|composer|singer|genres?|discography|catalogue)\b/i;
const THEME_CUE = /\b(?:songs?|tracks?|music|lyrics)\s+(?:(?:are|is)\s+)?(?:about|concerning|exploring|on the subject of)\b|\b(?:lyrical|lyric)\s+(?:themes?|subjects?)\b|\b(?:theme|subject)\s*:/i;
const SOUND_CUE = /\b(?:instrumentation|timbre|sound|sounding|guitars?|drums?|piano|pianos|brass|strings|synths?|synthesizers?|synthesisers?|bass(?:lines?)?|percussion|orchestral|acoustic|electronic|instrumental)\b/i;
const PRESENTER_CUE = /\b(?:presenter|hosts?|DJ|keep(?:s|ing)? you company|here to|joining you|conversation|witty|over.rehearsed)\b/i;
const EXCLUSION_CUE = /\b(?:avoid|exclude|excluding|never play|do not play|don't play|do not include|don't include)\b/i;

function positiveExcerpt(evidence: string, fields: readonly string[]): boolean {
  const quote = compact(evidence);
  return fields.some(field => {
    const source = compact(field);
    const at = source.indexOf(quote);
    if (at < 0) return false;
    // Include the surrounding sentence: quoting only "Radiohead tracks" must
    // not turn "Avoid Radiohead tracks" into a positive discovery request.
    const before = [...source.slice(0, at).matchAll(/[.!?]\s+/g)].at(-1);
    const afterStart = at + quote.length - (/[.!?]$/.test(quote) ? 1 : 0);
    const after = source.slice(afterStart).search(/[.!?]\s+/);
    const sentence = source.slice(before ? before.index + before[0].length : 0,
      after < 0 ? source.length : afterStart + after + 1);
    return !EXCLUSION_CUE.test(sentence);
  });
}

export function groundShortlistSearches(
  searches: z.infer<typeof preparedShortlistSearchSchema>['searches'],
  fields: readonly string[],
  presenters: readonly string[] = [],
): ShortlistSearch[] {
  const supported: ShortlistSearch[] = [];
  for (const { kind, query, evidence } of searches) {
    if (!evidence || !positiveExcerpt(evidence, fields)) continue;
    const excerpt = fold(evidence);
    const target = fold(query);
    if (!target) continue;
    // Bare artist/title names are not semantic descriptions. They must be
    // literally present; theme/sound wording may rearrange the quoted words.
    if (kind === 'theme' || kind === 'sound') {
      const terms = target.split(' ').filter(term => !QUERY_FILLER.has(term));
      const words = new Set(excerpt.split(' '));
      if (!terms.length || !terms.every(term => words.has(term))) continue;
      if (!(kind === 'theme' ? THEME_CUE : SOUND_CUE).test(evidence)) continue;
    } else {
      if (!(` ${excerpt} `).includes(` ${target} `) || !MUSIC_CUE.test(evidence) || PRESENTER_CUE.test(evidence)) continue;
      if (presenters.some(name => {
        const presenter = fold(name);
        return presenter && (target === presenter || (presenter.includes(' ')
          && ((` ${target} `).includes(` ${presenter} `) || (` ${presenter} `).includes(` ${target} `))));
      })) continue;
      // A quoted literal title such as "Everyday Life" can be real repertoire;
      // an unquoted instruction to find forgotten album tracks is not a title.
      const quotedTitle = [`"${query}"`, `“${query}”`, `'${query}'`, `‘${query}’`]
        .some(title => compact(evidence).includes(compact(title)));
      if (kind === 'library' && GENERIC_LIBRARY.test(query) && !quotedTitle) continue;
      if (kind === 'recentArtist' && !/\b(?:latest|newest|recent|new)\b/i.test(evidence)) continue;
    }
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

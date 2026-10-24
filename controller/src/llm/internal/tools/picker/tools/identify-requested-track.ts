import { tool } from 'ai';
import { z } from 'zod';
import * as subsonic from '../../../../../music/subsonic.js';
import { isWebSearchProviderError, searchWeb, searchReady } from '../../../../../skills/web-search.js';
import * as settings from '../../../../../settings.js';
import { identifyTrackFromText } from '../../../prompts/request.js';
import { definePickerTool } from '../defs.js';
import { REQUEST_TEXT_MAX } from '../../../../../schemas/request.js';
import { requestName } from '../../../../../music/request-normalize.js';
import { rankRequestCandidates, requestCandidateArtistMatches } from '../../../../../music/request-match.js';

// Search snippets sometimes make the performer obvious but an identification
// model may leave `artist` null when several pages use different credits. Keep
// this recovery conservative: only inspect lines that mention the identified
// title or keyword, and only use a name after Navidrome verifies it as an
// actual artist. Web text never becomes an on-air value by itself.
function webArtistHints(blob: string, title: string, keyword: string | null): string[] {
  const needles = [title, keyword].map(requestName).filter(Boolean);
  const titleWords = [...new Set(needles.flatMap(value => value.split(' ')).filter(word => word.length >= 3))];
  const similarWord = (a: string, b: string) => a === b
    || (a.length >= 4 && b.length >= 4 && (a.startsWith(b.slice(0, 4)) || b.startsWith(a.slice(0, 4))));
  if (!needles.length) return [];
  const hints: string[] = [];
  const seen = new Set<string>();
  for (const line of blob.split(/\r?\n/)) {
    const lineKey = requestName(line);
    const lineWords = lineKey.split(' ');
    const titleMatch = needles.some(needle => lineKey.includes(needle))
      || titleWords.filter(word => lineWords.some(other => similarWord(word, other))).length >= Math.min(2, titleWords.length);
    if (!titleMatch) continue;
    for (const match of line.matchAll(/(?:\bby\s*[:\-]?\s*|\bartist\s*[:\-]\s*|\|\s*)([^|:;,.\n]{2,80})/giu)) {
      const hint = String(match[1] || '')
        .replace(/\s+\b(?:album|song|lyrics|official|remixer|music|video)\b.*$/iu, '')
        .replace(/\s+/g, ' ').trim();
      const key = requestName(hint);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      hints.push(hint);
    }
  }
  return hints;
}

type WebTrackResult = { title?: string; content?: string; url?: string };

function webBlob(web: { answer?: string; results?: WebTrackResult[] }, limit: number): string {
  return [web.answer, ...(web.results || []).map((r) => `${r.title || ''}: ${r.content || ''}${r.url ? ` (${r.url})` : ''}`)]
    .filter(Boolean).join('\n').slice(0, limit);
}

export interface LyricTrackHint {
  title: string;
  artist: string;
}

type RankedLyricHint = LyricTrackHint & { confidence: number; order: number };

type IdentifiedTrack = { title: string; artist: string | null; keyword: string | null };

function llmConfigured(): boolean {
  // An empty model means the operator has not configured an identification
  // model. Ollama/cloud defaults are deliberately not inferred here: the
  // deterministic web-result path must remain usable on a fresh install.
  return !!String(settings.get().llm?.model || '').trim();
}

function evidenceSupportsGuess(guess: IdentifiedTrack, blob: string): boolean {
  const evidence = requestName(blob);
  const title = requestName(guess.title);
  const artist = requestName(guess.artist);
  return !!title && evidence.includes(title) && (!artist || evidence.includes(artist));
}

const TRUSTED_LYRIC_HOSTS = /(?:^|\.)\b(?:azlyrics|genius|musixmatch|lyrics|songlyrics|lyricsfreak|metrolyrics|lyricfind)\.(?:com|org)$/i;

function cleanHint(value: string): string {
  return value
    .replace(/^['"“”‘’\s]+|['"“”‘’\s]+$/g, '')
    .replace(/\s+(?:lyrics|lyric|song lyrics|official lyrics|song details|official video)\b.*$/iu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Pull only title/artist pairs that a lyric result states explicitly. This is
// deliberately conservative: web text never becomes a track id, and the pair
// is still verified against Navidrome by resolveGuess(). It gives long lyric
// requests a deterministic path when SearXNG ranks unrelated snippets above
// the canonical page, without asking the identification model to choose from
// all of that noise first.
export function extractLyricTrackHints(web: { results?: WebTrackResult[] }): LyricTrackHint[] {
  const hints: RankedLyricHint[] = [];
  const seen = new Set<string>();
  let order = 0;
  const add = (title: string, artist: string, confidence: number) => {
    const cleanedTitle = cleanHint(title);
    const cleanedArtist = cleanHint(artist);
    if (!cleanedTitle || !cleanedArtist || cleanedTitle.length > 100 || cleanedArtist.length > 80) return;
    if (/^(?:find|search|discover)\b/iu.test(cleanedTitle)
      || /\b(?:any\s+word|any\s+phrase|song\s+lyrics?)\b/iu.test(cleanedArtist)) return;
    const key = `${requestName(cleanedTitle)}|${requestName(cleanedArtist)}`;
    if (!key || seen.has(key)) return;
    seen.add(key);
    hints.push({ title: cleanedTitle, artist: cleanedArtist, confidence, order: order++ });
  };

  for (const result of web.results || []) {
    const title = String(result.title || '').trim();
    const content = String(result.content || '').trim();
    const trusted = !result.url || (() => {
      try { return TRUSTED_LYRIC_HOSTS.test(new URL(result.url).hostname); } catch { return false; }
    })();
    // A pair is useful only in a lyric context. Domain recognition improves
    // ranking, but is not a hard allow-list: smaller lyric sites and future
    // providers must work too. Navidrome verification remains mandatory.
    const lyricContext = /\blyrics?\b|\bsong\s+credits?\b|\b(?:sung|performed)\s+by\b|\b(?:artist|singer)\s*:/i.test(`${title} ${content}`);
    if (!lyricContext) continue;

    // Canonical pages commonly use `Artist - Title Lyrics`, including the
    // AZLyrics shape that fixes the Patient Zero request.
    let match = title.match(/^(.+?)\s+[-–—]\s+(.+?)\s+lyrics\b/iu);
    if (match) add(match[2], match[1], trusted ? 4 : result.url ? 3 : 2);
    match = title.match(/^(.+?)\s+lyrics\s*[-–—]\s+(.+?)$/iu);
    if (match) add(match[1], match[2], trusted ? 4 : result.url ? 3 : 2);

    // Music pages also use `Title - song and lyrics by Artist` and
    // `Title Lyrics - Artist`. Keep these separate from the generic `by`
    // parser below so a lyric sentence cannot become an invented title.
    match = title.match(/^(.+?)\s*[-–—]\s*(?:song\s+and\s+)?lyrics?\s+by\s+(.+?)$/iu);
    if (match) add(match[1], match[2], trusted ? 4 : result.url ? 3 : 2);

    // YouTube and music metadata snippets commonly carry a credit block such
    // as `Song: Chite Suit Te (Kannian) Artist: Geeta Zaildar Album: Nain`.
    // This is strong evidence, but the resulting pair still has to resolve to
    // a real local track before it can be returned.
    const source = `${title}\n${content}`;
    match = source.match(/\b(?:song(?:\s+credits)?|track)\s*:\s*(.{2,100}?)\s+(?:artist|singer)\s*[:\-]?\s*(.{2,80}?)(?=\s+(?:album|label|lyrics|released|music)\b|[.;|]|$)/iu);
    if (match) add(match[1], match[2], trusted ? 4 : result.url ? 3 : 2);

    // Some lyric pages put the title in their heading and only state the
    // performer in the body (`Lyrics by Geeta Zaildar`, `sung by ...`). Use
    // the heading as the title, while keeping the same local verification.
    const headingTitle = cleanHint(title);
    const bodyArtist = source.match(/\b(?:lyrics|sung|performed|artist)\s*(?:by|:)\s*([^.,;|\n]{2,80})/iu);
    if (headingTitle && bodyArtist) add(headingTitle, bodyArtist[1], trusted ? 2 : 1);

    // Search snippets often state the pair as `Title by Artist lyrics`.
    // Split on sentence boundaries first so a quoted lyric verse before the
    // title cannot become part of the title.
    for (const fragment of `${title}\n${content}`.split(/[.!?\n|]+/u)) {
      const by = fragment.match(/^\s*(.{2,100}?)\s+by\s+(.{2,80}?)(?:\s+(?:lyrics|song|official)\b|\s*)$/iu);
      if (by) add(by[1], by[2], trusted ? 3 : result.url ? 2 : 1);
    }
  }
  return hints
    .sort((a, b) => b.confidence - a.confidence || a.order - b.order)
    .map(({ title, artist }) => ({ title, artist }));
}

function lyricSearchQuery(
  reference: string,
  artist: string | null = null,
  edge: 'head' | 'tail' = 'tail',
  suffix = 'lyrics song artist',
): string {
  const words = String(reference || '').replace(/[“”"]/gu, '').split(/\s+/u)
    .map(word => word.replace(/^[^\p{L}\p{N}'’]+|[^\p{L}\p{N}'’]+$/gu, ''))
    .filter(Boolean);
  // Keep a contiguous lyric fragment, including its stop-words. Dropping
  // "my", "they're", and similar words turns a distinctive quoted line into
  // an unnatural bag of keywords that SearXNG often answers with generic
  // lyric-finder pages instead of the song itself.
  const fragment = (edge === 'head' ? words.slice(0, 8) : words.slice(-8)).join(' ');
  return `${artist ? `${artist} ` : ''}"${fragment || String(reference).slice(0, 120)}" ${suffix}`;
}

// Short transliterated lyric fragments are especially vulnerable to SearXNG
// ranking unrelated pages. A quoted, lyric-scoped companion query gives
// YouTube, Spotify and lyric engines enough context to return a credit block.
// Longer pasted verses already use the existing focused retry after an initial
// model guess, so keep this extra request bounded to short fragments.
function shortLyricSearchQuery(reference: string): string {
  const phrase = String(reference || '').replace(/["“”]/gu, '').replace(/\s+/g, ' ').trim();
  return `"${phrase}" lyrics song artist`;
}

type WebSearchResponse = { answer?: string; results?: WebTrackResult[] };

type EvidenceSearchBudget = {
  readonly used: number;
  search(query: string): Promise<WebSearchResponse>;
};

function evidenceSearchBudget(state: { limit: number; used: number; seen: Set<string> }, signal?: AbortSignal): EvidenceSearchBudget {
  const seen = state.seen;
  return {
    get used() { return state.used; },
    async search(query: string) {
      const key = requestName(query);
      if (!key || seen.has(key) || state.used >= state.limit) return { answer: '', results: [] };
      seen.add(key);
      state.used++;
      return searchWeb(query, { signal });
    },
  };
}

function hasWebEvidence(web: WebSearchResponse): boolean {
  return !!String(web.answer || '').trim() || !!web.results?.length;
}

function hasUsableLyricEvidence(web: WebSearchResponse): boolean {
  if (!hasWebEvidence(web)) return false;
  // A lyric mirror can echo enough of the submitted verse to pass a raw word
  // overlap check while still omitting every title/artist credit (Scribd and
  // generic lyric-finder pages do this frequently). Treat that as incomplete
  // evidence so the bounded second fragment and, later, the title/artist
  // follow-up get a chance to establish identity. A model can still use the
  // returned lyric text; this gate only controls whether we spend the next
  // search on a more identifying query.
  return extractLyricTrackHints(web).length > 0;
}

async function lyricWebEvidence(reference: string, budget: EvidenceSearchBudget): Promise<WebSearchResponse> {
  const normalizedWords = requestName(reference).split(' ').filter(Boolean);
  const wordCount = normalizedWords.length;
  const hasRepeatedPhraseCue = new Set(normalizedWords.filter(word => word.length >= 4)).size
    < normalizedWords.filter(word => word.length >= 4).length;
  const raw = String(reference || '').replace(/["“”]/gu, '').replace(/\s+/g, ' ').trim();
  const boundedRaw = raw.length > 240 ? `${raw.slice(0, 120)} ${raw.slice(-120)}` : raw;
  const firstQuery = wordCount >= 8
    ? lyricSearchQuery(reference, null, 'tail', hasRepeatedPhraseCue ? 'lyrics song artist' : 'lyrics')
    : shortLyricSearchQuery(reference);
  const first = await budget.search(firstQuery);
  if (hasUsableLyricEvidence(first)) return first;

  // Only an unusable first fragment earns a second, distinct fragment.
  // Provider failures throw and stop here; they are not identification misses.
  const secondQuery = wordCount >= 8
    ? lyricSearchQuery(reference, null, 'head', 'song lyrics')
    : `"${boundedRaw}" song lyrics`;
  const second = await budget.search(secondQuery);
  return hasWebEvidence(second) ? second : first;
}

// Request path only, and only when a web-search provider is ready. Resolves a
// listener's DESCRIPTION of a track (not a name) to songs in the LOCAL library:
// it looks the description up on the web, identifies the most likely single
// song, then searches Navidrome for it. Every returned candidate goes through
// collect() like any other tool, so the chosen id is always real — web text only
// steers which library tracks surface, never the id space. Nor the WORDS: the
// web snippets and the identifying model's guess are unvetted text, so none of
// it is returned. The agent sees library metadata or a fixed note, never a
// free-text "identified" field it might read out on air.
export default definePickerTool({
  name: 'identifyRequestedTrack',
  available: ({ scope }) => scope.resolveReferences && searchReady(),
  build: (ctx) => {
    const { collect } = ctx;
    // Unit callers may exercise the tool builder with only the collector. The
    // request picker supplies these shared accumulators in production, while a
    // local fallback keeps the tool's standalone contract intact.
    const evidenceState = ctx.evidenceSearch || { limit: 3, used: 0, seen: new Set<string>() };
    const failures = ctx.failures || [];
    return tool({
      description: 'Use when a listener DESCRIBES a track instead of naming it, OR pastes SONG LYRICS — e.g. "the song from the new Dune movie", "the one all over TikTok", or a block of lyrics in any language. Looks the text up on the web, identifies the song, and returns matching tracks FROM THIS LIBRARY. Use this (not searchLibrary) when the request looks like lyrics — repeated phrases, verse structure, non-English text that is not an artist/title; when they name an artist or title outright, use searchLibrary. (searchByLyrics finds songs ABOUT a theme — this identifies the one specific song.) Returns { candidates } from this library; when nothing matched, a note says so and you choose a fitting stand-in from your other results.',
      inputSchema: z.object({
        reference: z.string().min(3).max(REQUEST_TEXT_MAX).describe("the listener's description of the track, verbatim"),
      }),
      execute: async ({ reference }, options: { abortSignal?: AbortSignal } = {}) => {
      try {
        const signal = options.abortSignal;
        signal?.throwIfAborted();
        const searchBudget = evidenceSearchBudget(evidenceState, signal);
        const web = await lyricWebEvidence(reference, searchBudget); // cached 30 min per provider configuration
        let blob = webBlob(web, 5000);
        if (!blob) return { error: 'no web result for that reference' };

        const resolveGuess = async (candidate: IdentifiedTrack, candidateBlob: string) => {
          // Resolve LOCALLY via the same path searchLibrary uses, so every id
          // lands in `seen`. Try "artist title", then a resolved-artist retry
          // (spelling/transliteration), then title-only.
          // If the model omitted the performer, recover only verified artist
          // hints from title-bearing snippets. This handles multilingual titles
          // whose local catalogue stores an English alias.
          const artistHints = [candidate.artist, ...webArtistHints(candidateBlob, candidate.title, candidate.keyword)]
            .filter((value, index, all): value is string => !!value && all.indexOf(value) === index);
          const q = [artistHints[0], candidate.title].filter(Boolean).join(' ');
          let resolvedArtistName: string | null = null;
          let songs = await subsonic.search(q, { songCount: 25, signal });
          if (songs.length === 0) {
            for (const hint of artistHints) {
              const a = await subsonic.resolveArtist(hint, { signal });
              if (!a) continue;
              resolvedArtistName = a.name;
              songs = await subsonic.search(`${a.name} ${candidate.title}`, { songCount: 25, signal });
              if (songs.length) break;
            }
          }
          if (songs.length === 0) songs = await subsonic.search(candidate.title, { songCount: 25, signal });
          if (songs.length === 0 && candidate.keyword && candidate.keyword !== candidate.title) {
            songs = await subsonic.search(candidate.keyword, { songCount: 25, signal });
          }
          // Web results and library tags often use translated aliases for the
          // same song, such as "Chitte Suit Te" versus "White Suit". When every
          // title lookup misses, an identified artist with exactly one library
          // track is unambiguous. Do not broaden when that artist has multiple
          // tracks because the web title would no longer identify which one.
          if (songs.length === 0 && (resolvedArtistName || artistHints.length)) {
            const artistName = resolvedArtistName || artistHints[0];
            const artistSongs = await subsonic.search(artistName, { songCount: 25, signal });
            const exactArtistSongs = artistSongs.filter(song => requestCandidateArtistMatches(artistName, song));
            if (exactArtistSongs.length === 1) songs = exactArtistSongs;
          }
          return songs;
        };

        const hints = extractLyricTrackHints(web);
        const verifyCandidate = async (candidate: IdentifiedTrack, songs: any[], evidenceText = blob) => {
          const ranked = rankRequestCandidates(candidate.title, candidate.artist, songs, {
            webText: evidenceText,
            lyricText: reference,
          });
          if (ranked.length) return [ranked[0]!.song];
          const sameArtist = candidate.artist
            ? songs.filter(song => requestCandidateArtistMatches(candidate.artist, song))
            : songs;
          const lyricsById = new Map<string, string>();
          await Promise.all(sameArtist.slice(0, 8).map(async song => {
            signal?.throwIfAborted();
            const lyrics = await subsonic.getLyrics(song.id, { signal });
            if (lyrics) lyricsById.set(song.id, lyrics);
          }));
          const lyricRanked = rankRequestCandidates(candidate.title, candidate.artist, songs, {
            webText: evidenceText,
            lyricText: reference,
            lyricsById,
          });
          if (lyricRanked.length) return [lyricRanked[0]!.song];
          // A translated or transliterated title is still safe when the
          // verified artist has exactly one local track. This preserves the
          // existing controlled alias fallback without allowing a multi-track
          // artist catalogue to become a lottery.
          return sameArtist.length === 1 ? sameArtist : [];
        };
        const resolveHint = async (hint: LyricTrackHint) => {
          const hintedSongs = await resolveGuess({ title: hint.title, artist: hint.artist, keyword: hint.title }, blob);
          return verifyCandidate({ title: hint.title, artist: hint.artist, keyword: hint.title }, hintedSongs);
        };

        // When the operator configured an LLM, let it parse the web evidence
        // first. Its answer is accepted only when the title and artist are
        // present in the returned evidence and the local catalogue verifies the
        // exact track. This prevents a model hallucination from winning over a
        // canonical result. Without an LLM, the structured-result parser below
        // is the complete fallback path.
        let guess: IdentifiedTrack | null = null;
        if (llmConfigured()) {
          try { guess = await identifyTrackFromText(reference, blob, signal); } catch (err) {
            if (signal?.aborted) throw err;
            guess = null;
          }
          if (guess && evidenceSupportsGuess(guess, blob)) {
            const modelSongs = await resolveGuess(guess, blob);
            const modelCandidates = collect(await verifyCandidate(guess, modelSongs));
            if (modelCandidates.length) return { candidates: modelCandidates };
          }
        }

        // Prefer an explicit pair from a lyric result when the LLM is absent,
        // unavailable, or could not prove its guess. The local lookup remains
        // the authority, so web text can never inject an arbitrary id.
        for (const hint of hints) {
          const hintedCandidates = collect(await resolveHint(hint));
          if (hintedCandidates.length) return { candidates: hintedCandidates };
        }

        if (!llmConfigured()) return { error: 'could not identify a specific song from the available search results' };
        if (!guess) {
          try { guess = await identifyTrackFromText(reference, blob, signal); } catch (err) {
            if (signal?.aborted) throw err;
            guess = null;
          }
        }
        if (!guess) return { error: 'could not identify a specific song from that description' };

        // A noisy meta-search response can contain the lyric but omit the
        // credit. A bounded title-and-artist follow-up gives the same provider
        // a better query before we decide the local library has no match.
        if (!evidenceSupportsGuess(guess, blob)) {
          const identityQuery = [guess.title, guess.artist]
            .filter((value): value is string => !!value && value.trim().length > 0)
            .join(' ');
          const followUp = await searchBudget.search(`${identityQuery} song artist`);
          const extra = webBlob(followUp, 3000);
          if (extra) blob = (blob + '\n' + extra).slice(0, 8000);
        }

        // A plausible model guess is not enough by itself. Require the title
        // and, when supplied, the artist to appear in the accumulated search
        // evidence before resolving anything in the local catalogue.
        if (!evidenceSupportsGuess(guess, blob)) {
          return { error: 'could not verify a specific song from the available search evidence' };
        }

        const songs = await resolveGuess(guess, blob);
        let verifiedSongs = await verifyCandidate(guess, songs);

        // Some providers rank a lyric mirror above the canonical song page and
        // the first identification can therefore be wrong even though the
        // requested track is in Navidrome. Retry once with an exact opening
        // lyric fragment, but only after the first locally verified lookup
        // failed. The second guess still has to resolve to a real library id.
        if (!verifiedSongs.length && requestName(reference).split(' ').length >= 8) {
          const focused = await searchBudget.search(lyricSearchQuery(reference, guess.artist, 'head'));
          const focusedBlob = webBlob(focused, 5000);
          if (focusedBlob) {
            const focusedGuess = await identifyTrackFromText(reference, focusedBlob, signal);
            const focusedEvidence = focusedBlob + '\n' + blob;
            if (focusedGuess && evidenceSupportsGuess(focusedGuess, focusedEvidence)) {
              const focusedSongs = await resolveGuess(focusedGuess, focusedEvidence);
              verifiedSongs = await verifyCandidate(focusedGuess, focusedSongs, focusedEvidence);
            }
          }
        }

        const candidates = collect(verifiedSongs);
        if (!candidates.length) return { candidates, note: 'could not find the described song in this library' };
        return { candidates };
      } catch (err) {
        if (options.abortSignal?.aborted) throw err;
        if (isWebSearchProviderError(err)) failures.push(err);
          return { error: (err as Error).message };
        }
      },
    });
  },
});

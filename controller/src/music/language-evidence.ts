// Web evidence for unresolved library language tags.
//
// Search is a discovery layer only. A result must identify the local title and
// artist before any of its text can reach the language classifier. This keeps a
// same-title result by another artist, an unrelated search snippet, or a nearby
// instrumental/remix from becoming language evidence.

import { searchWeb, type SearchResponse, type SearchResult } from '../skills/web-search.js';
import { canonicalLanguage, requestName, requestNameVariants } from './request-normalize.js';
import type { TrackRecord } from './library-db/types.js';

export interface WebLanguageEvidence {
  text: string | null;
  languages: string[];
  instrumental: boolean;
}

export type LanguageEvidenceSearch = (query: string) => Promise<SearchResponse>;

const VERSION_MARKERS = [
  'acoustic', 'club mix', 'cover', 'demo', 'extended', 'instrumental',
  'karaoke', 'live', 'lofi', 'lo fi', 'radio edit', 'remix', 'reverb',
  'slowed', 'sped up', 'unplugged',
];

function hasPhrase(text: string, value: string): boolean {
  const haystack = requestName(text).split(' ').filter(Boolean);
  return requestNameVariants(value).some(variant => {
    const needle = variant.split(' ').filter(Boolean);
    if (!needle.length || needle.length > haystack.length) return false;
    return haystack.some((_, start) =>
      start + needle.length <= haystack.length &&
      needle.every((token, offset) => haystack[start + offset] === token),
    );
  });
}

function versionMarkers(value: string | null | undefined): string[] {
  const normalized = requestName(value ?? '');
  return VERSION_MARKERS.filter(marker => normalized.includes(marker));
}

function compatibleVersion(track: TrackRecord, resultTitle: string): boolean {
  const local = new Set(versionMarkers(`${track.title ?? ''} ${track.album ?? ''}`));
  const remote = new Set(versionMarkers(resultTitle));
  if (remote.size && ![...remote].every(marker => local.has(marker))) return false;
  if (local.size && ![...local].every(marker => remote.has(marker))) return false;
  return true;
}

function leadArtist(artist: string): string {
  return artist.split(/\s+(?:feat\.?|ft\.?|featuring|with)\s+|\s*[&,/]\s*/iu)[0]?.trim() || artist;
}

/**
 * Verify that a web result is about the exact local recording identity.
 * Exported as a pure seam so provider fixtures can test rejection behavior.
 */
export function verifyLanguageSearchResult(track: TrackRecord, result: SearchResult): boolean {
  if (!track.title || !track.artist || (!result.title && !result.content)) return false;
  if (!compatibleVersion(track, result.title)) return false;
  const body = `${result.title} ${result.content}`;
  if (!hasPhrase(body, track.title)) return false;
  const artistMatch = hasPhrase(body, track.artist) || hasPhrase(body, leadArtist(track.artist));
  return artistMatch;
}

function candidatePhrases(value: string): string[] {
  const tokens = requestName(value).split(' ').filter(Boolean);
  const phrases: string[] = [];
  for (let width = Math.min(4, tokens.length); width >= 1; width -= 1) {
    for (let start = 0; start + width <= tokens.length; start += 1) {
      phrases.push(tokens.slice(start, start + width).join(' '));
    }
  }
  return phrases;
}

function explicitLanguageCodes(text: string): string[] {
  const candidates: string[] = [];
  for (const match of text.matchAll(/\b(?:language|lyrics?)\s*(?:(?:are|is)\s*)?(?:in|:|-)\s*([^\n.;|]+)/giu)) {
    candidates.push(match[1] ?? '');
  }
  const codes = new Set<string>();
  for (const candidate of candidates) {
    for (const phrase of candidatePhrases(candidate)) {
      const code = canonicalLanguage(phrase);
      if (code && code !== 'und' && code !== 'xxx' && code !== 'zxx') codes.add(code);
    }
  }
  return [...codes];
}

function usefulLyricText(content: string): boolean {
  const text = content.trim();
  return text.length >= 80 && (text.match(/[\p{L}]{2,}/gu) ?? []).length >= 15;
}

function resultScore(track: TrackRecord, result: SearchResult): number {
  let score = 0;
  if (hasPhrase(result.title, track.title ?? '')) score += 4;
  if (hasPhrase(result.title, track.artist ?? '')) score += 3;
  if (hasPhrase(result.content, track.title ?? '')) score += 2;
  if (hasPhrase(result.content, leadArtist(track.artist ?? ''))) score += 1;
  if (usefulLyricText(result.content)) score += 1;
  return score;
}

function emptyEvidence(): WebLanguageEvidence {
  return { text: null, languages: [], instrumental: false };
}

/**
 * Search the configured provider with two bounded exact-identity queries.
 * Provider failures are intentionally converted to no evidence: the caller
 * writes an unknown result, which remains in the next normal pending run.
 */
export async function resolveWebLanguageEvidence(
  track: TrackRecord,
  search: LanguageEvidenceSearch = searchWeb,
): Promise<WebLanguageEvidence> {
  if (!track.title?.trim() || !track.artist?.trim()) return emptyEvidence();
  const title = track.title.replace(/["\\]/g, ' ').trim();
  const artist = track.artist.replace(/["\\]/g, ' ').trim();
  const base = `"${title}" "${artist}"`;
  const queries = [`${base} lyrics`, `${base} language`];
  const responses = await Promise.allSettled(queries.map(query => search(query)));
  const candidates: Array<{ result: SearchResult; score: number; languages: string[]; instrumental: boolean }> = [];

  for (const response of responses) {
    if (response.status !== 'fulfilled') continue;
    const body = response.value;
    for (const result of body.results) {
      if (!verifyLanguageSearchResult(track, result)) continue;
      const joined = `${result.title} ${result.content}`;
      const languages = explicitLanguageCodes(joined);
      const instrumental = /\binstrumental\b/iu.test(result.title) ||
        (/\binstrumental\b/iu.test(result.content) && !track.title.toLocaleLowerCase('en').includes('instrumental'));
      candidates.push({ result, score: resultScore(track, result), languages, instrumental });
    }
    if (body.answer && verifyLanguageSearchResult(track, { title: body.answer, content: '' })) {
      const languages = explicitLanguageCodes(body.answer);
      if (languages.length) {
        candidates.push({ result: { title: body.answer, content: '' }, score: 5, languages, instrumental: false });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.result.title.localeCompare(b.result.title));
  const best = candidates[0];
  if (!best) return emptyEvidence();

  const competing = candidates.find(candidate => candidate !== best && candidate.score === best.score &&
    JSON.stringify(candidate.languages) !== JSON.stringify(best.languages));
  if (competing) return emptyEvidence();

  return {
    text: usefulLyricText(best.result.content) ? best.result.content : null,
    languages: best.languages,
    instrumental: best.instrumental,
  };
}

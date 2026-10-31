// Language evidence for library tracks. This module deliberately has a small
// public surface: local/script detection is deterministic, exact MusicBrainz
// evidence is injected by the caller, and the optional LLM fallback only sees a
// bounded lyric excerpt. Titles, artists and genres are never used to invent a
// language.

import { z } from 'zod';
import { djObject } from '../llm/sdk.js';
import { optionalSegmentsAllowed } from '../broadcast/dj-budget.js';
import { canonicalLanguage } from './request-normalize.js';
import type { LanguageMode, LanguageSource, TrackLanguageTag } from './library-db/types.js';

export const LANGUAGE_TAG_CONTRACT_VERSION = 1;
export const LANGUAGE_LYRIC_SAMPLE_MAX = 1200;
export const LANGUAGE_BATCH_MAX = 10;

export interface LanguageEvidence {
  text: string | null;
  taggedLanguage?: string | null;
}

export interface LanguageDecision {
  primaryLanguage: string | null;
  languages: string[];
  mode: LanguageMode;
  source: LanguageSource;
  confidence: TrackLanguageTag['confidence'];
  model?: string | null;
}

const WORDS: Record<string, string[]> = {
  eng: ['the', 'and', 'you', 'your', 'with', 'this', 'that', 'love', 'when', 'what', 'my', 'me', 'for', 'not', 'just'],
  hin: ['hai', 'hain', 'mera', 'meri', 'mere', 'tera', 'teri', 'tere', 'tum', 'mujhe', 'mujhko', 'kya', 'kyun', 'dil', 'pyaar', 'pyar', 'raat', 'din', 'aankhon', 'zindagi'],
  pan: ['main', 'mai', 'tussi', 'saanu', 'tenu', 'tera', 'teri', 'ni', 've', 'yaar', 'dil', 'jatt', 'kudi', 'munda', 'chann', 'rab', 'assi', 'pyaar'],
  bgc: ['mhara', 'thara', 'mne', 'tne', 'ib', 'konya', 'ghani', 'chhora', 'chhori', 'manne', 'tanne', 'se', 'su', 'ke'],
  bho: ['hamaar', 'tohaar', 'raura', 'ba', 'baani', 'kaise', 'ka', 'ke', 'me', 'ho', 'saiyan', 'gori', 'chahi', 'rahe'],
  mar: ['majha', 'mala', 'majha', 'tula', 'tumhi', 'ahe', 'aahe', 'kay', 'mi', 'prem', 'mana', 'jiv', 'ga'],
  urd: ['hai', 'hain', 'mera', 'meri', 'tum', 'mujhe', 'dil', 'ishq', 'mohabbat', 'raat', 'zindagi', 'aankhon', 'khuda'],
  ben: ['ami', 'tumi', 'amar', 'tomar', 'bhalo', 'mon', 'preme', 'ache', 'keno', 'gaan'],
  tam: ['naan', 'nee', 'neenga', 'enakku', 'ungal', 'kadhal', 'uyir', 'oru', 'enna', 'illa'],
  tel: ['nenu', 'nuvvu', 'meeru', 'naa', 'nee', 'prema', 'manasu', 'oka', 'unnav', 'ledu'],
  guj: ['hu', 'tame', 'mane', 'maru', 'tamaro', 'prem', 'dil', 'che', 'nathi', 'ek'],
  nep: ['ma', 'timilai', 'mero', 'timi', 'maya', 'man', 'cha', 'chha', 'kina', 'yo'],
};

const SCRIPT_RANGES: Array<{ code: string; re: RegExp }> = [
  { code: 'pan', re: /[\u0A00-\u0A7F]/gu },
  { code: 'ben', re: /[\u0980-\u09FF]/gu },
  { code: 'guj', re: /[\u0A80-\u0AFF]/gu },
  { code: 'tam', re: /[\u0B80-\u0BFF]/gu },
  { code: 'tel', re: /[\u0C00-\u0C7F]/gu },
  { code: 'kan', re: /[\u0C80-\u0CFF]/gu },
  { code: 'mal', re: /[\u0D00-\u0D7F]/gu },
  { code: 'hin', re: /[\u0900-\u097F]/gu },
  { code: 'urd', re: /[\u0600-\u06FF]/gu },
];

function words(text: string): string[] {
  return text.toLocaleLowerCase('en').match(/[\p{L}\p{M}]+/gu) ?? [];
}

function scriptScore(text: string): Array<{ code: string; count: number }> {
  return SCRIPT_RANGES
    .map(({ code, re }) => ({ code, count: (text.match(re) ?? []).length }))
    .filter(x => x.count > 0)
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

function scoreLatin(text: string): Array<{ code: string; count: number }> {
  const ws = words(text);
  return Object.entries(WORDS)
    .map(([code, list]) => ({ code, count: ws.filter(w => list.includes(w)).length }))
    .filter(x => x.count > 0)
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

function withMode(languages: string[], source: LanguageSource, confidence: TrackLanguageTag['confidence']): LanguageDecision {
  const unique = [...new Set(languages.filter(Boolean))];
  if (!unique.length) {
    return { primaryLanguage: null, languages: [], mode: 'unknown', source, confidence };
  }
  return {
    primaryLanguage: unique[0]!,
    languages: unique,
    mode: unique.length > 1 ? 'mixed' : 'single',
    source,
    confidence,
  };
}

export function sampleLyrics(text: string | null | undefined): string {
  return String(text ?? '').replace(/\s+/gu, ' ').trim().slice(0, LANGUAGE_LYRIC_SAMPLE_MAX);
}

// Returns null when the excerpt is too short or the evidence is ambiguous.
// A script-only Indian result is intentionally review-level so the AI fallback
// can distinguish Hindi, Bhojpuri, Marathi and Urdu instead of collapsing them.
export function detectLocalLanguage(text: string | null | undefined): LanguageDecision | null {
  const sample = sampleLyrics(text);
  if (sample.length < 80) return null;
  const scripts = scriptScore(sample);
  if (scripts.length) {
    const top = scripts[0]!;
    const second = scripts[1];
    if (top.count / Math.max(sample.length, 1) >= 0.35 && (!second || top.count >= second.count * 2)) {
      // Latin words beside a non-Latin script are common in bilingual lyrics.
      // Keep this review-level so the AI path can decide whether the secondary
      // language is substantial instead of silently labelling the whole track
      // as the dominant script's language.
      const latinCount = (sample.match(/[A-Za-z]/gu) ?? []).length;
      if (latinCount >= 12 && latinCount >= top.count * 0.2) {
        return withMode([top.code], 'local', 'review');
      }
      // Script is a useful hint for the AI prompt, not a language decision:
      // Devanagari, Arabic and several other scripts are shared by multiple
      // languages and cannot safely identify one from glyphs alone.
      return withMode([top.code], 'local', 'review');
    }
    return null;
  }
  const scores = scoreLatin(sample);
  const top = scores[0];
  const next = scores[1];
  // Latin transliteration is deliberately conservative: these seed lexicons
  // are only a fast path for common unambiguous excerpts, never a complete
  // language catalogue. Shared vocabulary or a weak margin goes to exact
  // provider evidence, then the global AI fallback.
  if (!top || top.count < 8) return null;
  if (next && top.count - next.count < 5) return null;
  // Even a strong seed-lexicon score remains review-level. The lexicon is a
  // bounded accelerator, not a claim that the open world of Latin-script
  // languages is covered. The provider/AI stages make the final decision.
  return withMode([top.code], 'local', 'review');
}

export function languageFromLyricsTag(value: string | null | undefined): LanguageDecision | null {
  const code = canonicalLanguage(value);
  if (!code || code === 'und' || code === 'xxx') return null;
  if (code === 'zxx') return { primaryLanguage: null, languages: [], mode: 'instrumental', source: 'lyrics-tag', confidence: 'high' };
  return withMode([code], 'lyrics-tag', 'high');
}

const LanguageResult = z.object({
  primaryLanguage: z.string().nullable(),
  languages: z.array(z.string()).default([]),
  mode: z.enum(['single', 'mixed', 'instrumental', 'unknown']),
  confidence: z.enum(['high', 'medium', 'review']).default('review'),
});

const LanguageBatchResult = z.object({ results: z.array(LanguageResult) });

function sanitize(result: z.infer<typeof LanguageResult>): LanguageDecision {
  const primary = canonicalLanguage(result.primaryLanguage);
  const codes = [...new Set([
    ...result.languages.map(canonicalLanguage),
    primary,
  ].filter((x): x is string => !!x && x !== 'und' && x !== 'xxx' && x !== 'zxx'))];
  const mode = result.mode === 'instrumental' ? 'instrumental' : result.mode === 'unknown' ? 'unknown' : codes.length > 1 ? 'mixed' : codes.length ? 'single' : 'unknown';
  return {
    primaryLanguage: mode === 'instrumental' || mode === 'unknown' ? null : (primary && codes.includes(primary) ? primary : codes[0] ?? null),
    languages: mode === 'instrumental' || mode === 'unknown' ? [] : codes,
    mode,
    source: 'llm',
    confidence: result.confidence,
  };
}

export async function detectWithAi(samples: string[]): Promise<LanguageDecision[]> {
  if (!samples.length) return [];
  if (!optionalSegmentsAllowed()) {
    throw Object.assign(
      new Error('Language AI fallback paused by the daily LLM budget'),
      { code: 'LLM_BUDGET_EXHAUSTED' },
    );
  }
  const numbered = samples.map((sample, i) => `${i + 1}. ${sample}`).join('\n');
  const parsed = await djObject({
    system: `You identify the language of song lyrics. Return one result per numbered excerpt. Use any valid ISO 639-3 code in primaryLanguage and languages, including less common and regional languages not listed in this prompt. Keep regional languages distinct rather than collapsing them into a larger related language. Examples include Hindi hin, Punjabi pan, Haryanvi bgc, Bhojpuri bho, Marathi mar, Urdu urd, Bengali ben, Tamil tam, Telugu tel, Gujarati guj, Nepali nep, and English eng. Use mode mixed only when a secondary language is substantial and repeated, not for a borrowed word. Use instrumental when there is no linguistic vocal content. Use unknown when the excerpt is insufficient. Do not infer from an artist, title, genre, nationality, or script alone.`,
    prompt: `Identify these lyric excerpts. Do not repeat or quote them in your answer.\n\n${numbered}`,
    schema: LanguageBatchResult,
    temperature: 0,
    kind: 'tag-language-batch',
  });
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  if (results.length !== samples.length) throw new Error(`language batch length mismatch: expected ${samples.length}, got ${results.length}`);
  return results.map(sanitize);
}

export function unknownLanguage(source: LanguageSource = 'local'): LanguageDecision {
  return { primaryLanguage: null, languages: [], mode: 'unknown', source, confidence: 'review' };
}

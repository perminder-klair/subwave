import { createHash } from 'node:crypto';
import type { ResearchCandidate, SleeveNoteCategory, WikipediaSpark } from './researcher.js';

// The measured Hole paste was about 39k prose characters / 9.3k prompt tokens
// on the station model. A 20k ceiling targets roughly 4.8k prompt tokens,
// reducing prefill time and the chance a live task interrupts this call.
export const MAX_WIKIPEDIA_CHUNK_CHARACTERS = 20_000;
export const MIN_WIKIPEDIA_CHUNK_CHARACTERS = 4_000;
export const MAX_WIKIPEDIA_CHUNK_CEILING_CHARACTERS = 60_000;
export const MAX_WIKIPEDIA_SPARKS_PER_CHUNK = 20;
const SKIPPED_SECTIONS = /^(?:discography|song catalogue|filmography|selected filmography|track listing|personnel|band members|lineup|awards(?: and (?:nominations|achievements))?|charts?|certifications?|references|notes|see also|external links|further reading|bibliography|concert tours|tour dates|timeline)$/iu;
const STOP = new Set(['about', 'after', 'also', 'among', 'and', 'are', 'as', 'at', 'been', 'but', 'by', 'for', 'from', 'had', 'has', 'have', 'her', 'his', 'into', 'its', 'more', 'most', 'not', 'of', 'on', 'one', 'or', 'over', 'she', 'that', 'the', 'their', 'them', 'then', 'they', 'this', 'through', 'to', 'was', 'were', 'which', 'with']);

export interface WikipediaChunk {
  sectionPath: string;
  text: string;
}

function sentenceParts(value: string): string[] {
  return [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(value)]
    .map(({ segment }) => segment.trim()).filter(Boolean);
}

function boundedTextParts(value: string, maxCharacters: number): string[] {
  return sentenceParts(value).flatMap((sentence) => {
    const parts: string[] = [];
    let remaining = sentence;
    while (remaining.length > maxCharacters) {
      let split = remaining.lastIndexOf(' ', maxCharacters);
      if (split < Math.floor(maxCharacters * 0.6)) split = maxCharacters;
      parts.push(remaining.slice(0, split).trim());
      remaining = remaining.slice(split).trim();
    }
    if (remaining) parts.push(remaining);
    return parts;
  });
}

/** Split on existing article headings and prose paragraphs, using a conservative token proxy. */
export function planWikipediaChunks(text: string, maxCharacters = MAX_WIKIPEDIA_CHUNK_CHARACTERS): WikipediaChunk[] {
  const cleanText = text.replace(/^<!--\s*subwave-wikipedia-source-format:\d+\s*-->\s*/u, '');
  const sections: Array<{ path: string; body: string[]; order: number }> = [];
  const headings: string[] = [];
  let body: string[] = [];
  const flushSection = () => {
    const prose = body.join('\n\n').trim();
    if (prose) sections.push({ path: headings.join(' / ') || 'Introduction', body: [prose], order: sections.length });
    body = [];
  };
  for (const line of cleanText.split(/\r?\n/u)) {
    const match = line.trim().match(/^(={2,6})\s*(.*?)\s*\1$/u);
    if (match) {
      flushSection();
      const depth = match[1].length - 2;
      headings.length = depth;
      headings[depth] = match[2].trim();
    } else if (line.trim()) body.push(line.trim());
  }
  flushSection();
  const chunks: WikipediaChunk[] = [];
  let currentParts: string[] = [];
  let currentPaths: string[] = [];
  let currentLength = 0;
  const emit = () => {
    const value = currentParts.join('\n\n').trim();
    if (value) chunks.push({ sectionPath: [...new Set(currentPaths)].join(' · '), text: value });
    currentParts = [];
    currentPaths = [];
    currentLength = 0;
  };
  const addBlock = (path: string, value: string) => {
    const block = `== ${path} ==\n\n${value}`;
    if (currentLength && currentLength + block.length + 2 > maxCharacters) emit();
    if (block.length > maxCharacters) {
      for (const sentence of boundedTextParts(value, maxCharacters - path.length - 16)) {
        const part = `== ${path} ==\n\n${sentence}`;
        if (currentLength && currentLength + part.length + 2 > maxCharacters) emit();
        currentParts.push(part);
        currentPaths.push(path);
        currentLength += part.length + 2;
      }
      return;
    }
    currentParts.push(block);
    currentPaths.push(path);
    currentLength += block.length + 2;
  };
  for (const section of sections) {
    if (section.path.split(' / ').some((heading) => SKIPPED_SECTIONS.test(heading))) continue;
    const paras = section.body[0].split(/\n\s*\n/u).map((paragraph) => paragraph.trim()).filter(Boolean);
    let current: string[] = [];
    let sectionLength = 0;
    const emitSection = () => {
      if (current.length) addBlock(section.path, current.join('\n\n'));
      current = [];
      sectionLength = 0;
    };
    for (const paragraph of paras) {
      if (paragraph.length > maxCharacters - section.path.length - 16) {
        emitSection();
        let fragment = '';
        for (const sentence of boundedTextParts(paragraph, maxCharacters - section.path.length - 16)) {
          if (fragment && fragment.length + sentence.length + 1 > maxCharacters - section.path.length - 16) {
            addBlock(section.path, fragment);
            fragment = '';
          }
          fragment += `${fragment ? ' ' : ''}${sentence}`;
        }
        if (fragment) addBlock(section.path, fragment);
        continue;
      }
      if (sectionLength && sectionLength + paragraph.length + 2 > maxCharacters - section.path.length - 16) emitSection();
      current.push(paragraph);
      sectionLength += paragraph.length + 2;
    }
    emitSection();
  }
  emit();
  return chunks;
}

/** Divide an entry-wide claim budget across planned chunks by source length. */
export function allocateWikipediaClaims(chunks: readonly { text: string }[], total: number): number[] {
  if (!chunks.length) return [];
  const budget = Math.max(0, Math.min(MAX_WIKIPEDIA_SPARKS_PER_CHUNK * chunks.length, Math.trunc(total)));
  const lengths = chunks.map(({ text }) => Math.max(0, text.length));
  const totalLength = lengths.reduce((sum, length) => sum + length, 0);
  if (!totalLength || !budget) return chunks.map(() => 0);
  const exact = lengths.map((length) => budget * length / totalLength);
  const allocated = exact.map(Math.floor);
  const remaining = budget - allocated.reduce((sum, count) => sum + count, 0);
  const byRemainder = exact.map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  for (let index = 0; index < remaining; index++) allocated[byRemainder[index].index]++;
  return allocated;
}

function words(value: string): string[] {
  return value.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function evidenceFor(spark: string, source: string): string | null {
  const sparkWords = [...new Set(words(spark).filter((word) => word.length > 2 && !STOP.has(word)))];
  const numbers = spark.match(/\b\d+(?:[.,]\d+)?\b/gu) ?? [];
  const quoted = [...spark.matchAll(/["“]([^"”]{3,100})["”]/gu)].map((match) => match[1]);
  let best: { text: string; score: number } | null = null;
  let heading = '';
  for (const block of source.split(/\n\s*\n/u).map((part) => part.trim()).filter(Boolean)) {
    if (/^={2,6}\s*.+?\s*={2,6}$/u.test(block)) {
      heading = block;
      continue;
    }
    const sentences = sentenceParts(block);
    for (let start = 0; start < sentences.length; start++) {
      for (let count = 1; count <= 4 && start + count <= sentences.length; count++) {
        const excerpt = sentences.slice(start, start + count).join(' ');
        const evidence = start === 0 && heading ? `${heading}\n\n${excerpt}` : excerpt;
        if (evidence.length > 900 || evidence.length < 24) continue;
        const lower = evidence.toLocaleLowerCase();
        if (numbers.some((number) => !evidence.includes(number))
          || quoted.some((phrase) => !lower.includes(phrase.toLocaleLowerCase()))) continue;
        const evidenceWords = new Set(words(evidence));
        const overlap = sparkWords.filter((word) => evidenceWords.has(word)).length;
        const score = overlap / Math.max(1, sparkWords.length);
        if (overlap >= Math.min(4, Math.max(2, Math.ceil(sparkWords.length * 0.3)))
          && (!best || score > best.score || (score === best.score && evidence.length < best.text.length))) {
          best = { text: evidence, score };
        }
      }
    }
    // A heading is context for the first prose block in its section only; do
    // not pair it with later paragraphs where it would not be contiguous source.
    heading = '';
  }
  return best?.text ?? null;
}

function sparkTopic(spark: string): string {
  const key = words(spark).filter((word) => word.length > 2 && !STOP.has(word)).slice(0, 5)
    .map((word) => `${word[0]?.toLocaleUpperCase() ?? ''}${word.slice(1)}`).join(' ');
  const suffix = createHash('sha256').update(spark.normalize('NFKC').replace(/\s+/gu, ' ').toLocaleLowerCase())
    .digest('hex').slice(0, 7);
  return `${key || 'Story'} · ${suffix}`.slice(0, 100);
}

/** Attach an exact source sentence to the model's fact, then let the existing controller screen decide. */
export function wikipediaCandidatesFromSparks(
  sparks: readonly WikipediaSpark[], source: string, subjectKind: 'artist' | 'album',
): ResearchCandidate[] {
  return sparks.flatMap((spark, index) => {
    const evidence = evidenceFor(spark.wording, source);
    if (!evidence) return [];
    if (subjectKind === 'artist' && (!spark.category || !spark.airtimeScope)) return [];
    const relationship = /\b(?:collaborat|cover(?:ed)?|influenc|inspir|interpolat|sampl(?:e|ed|ing))\w*\b/iu.test(spark.wording);
    const category: SleeveNoteCategory = spark.category
      ?? (relationship ? 'musical-connections' : subjectKind === 'album' ? 'release-stories' : 'artist-stories');
    return [{ category, topic: sparkTopic(spark.wording), wording: spark.wording, evidence,
      extractionRank: index + 1,
      ...(subjectKind === 'artist' && spark.airtimeScope ? { airtimeScope: spark.airtimeScope } : {}),
      ...(spark.matchingReleaseTitle ? { matchingReleaseTitle: spark.matchingReleaseTitle } : {}),
      ...(spark.matchingTrackTitle ? { matchingTrackTitle: spark.matchingTrackTitle } : {}),
    }];
  });
}

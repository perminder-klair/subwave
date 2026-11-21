export const DEFAULT_WIKIPEDIA_EXTRACT_PROMPT = `Read the supplied Wikipedia text and choose up to {wikiNumber} distinct story facts for a radio DJ, who will use the wording you provide in a link introducing a track by the artist. Rank them from strongest to weakest for an interesting, natural link. Prefer human or musical stories, creative choices, unexpected connections, conflicts, causes and consequences. Skip bare dates, chart numbers, reviews and personnel listings. Only choose subjects that would make for a light-hearted link, avoiding heavy subjects. Keep each fact close to the source wording; do not combine facts, add explanations or conclusions, or strengthen opinions. Return fewer when the text contains fewer strong facts.`;

export function activeWikipediaExtractPrompt(customPrompt: string | undefined, wikiNumber?: number): string {
  const prompt = customPrompt?.trim() || DEFAULT_WIKIPEDIA_EXTRACT_PROMPT;
  return wikiNumber === undefined ? prompt : prompt.replaceAll('{wikiNumber}', String(wikiNumber));
}

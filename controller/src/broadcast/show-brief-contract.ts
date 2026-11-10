// Check era/cast/appearance contracts, with optional genre-word feedback for
// draft editing. Word matches are not a semantic classifier or prose fact checker.
type Era = { fromYear: number | null; toYear: number | null };
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const namedDecades: Record<string, number> = { thirties: 1930, forties: 1940, fifties: 1950, sixties: 1960, seventies: 1970, eighties: 1980, nineties: 1990, noughties: 2000, aughts: 2000 };
// Decode only double-escaped prose punctuation, never arbitrary JSON or filters.
export function normalizeShowProse(text: string): string {
  return text.replace(/\\+u(201[89abcd]|2026|00a0)/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)));
}
export function hasEraReference(text: string): boolean {
  return /\b(?:(?:19|20)\d{2}(?:[’']?s)?|(?:\d0)[’']?s|thirties|forties|fifties|sixties|seventies|eighties|nineties|noughties|aughts)\b/i.test(text);
}
export function validateShowBrief(brief: { name: string; topic: string; talkingPoint: string }, eras: Era[], personaNames: string[], cast: string[], genreContract?: { known: string[]; selected: string[]; context: string[]; inspectAmbiguous?: boolean }): void {
  const text = `${brief.name}\n${brief.topic}\n${brief.talkingPoint}`;
  const contains = (from: number, to = from) => eras.some(era => (era.fromYear ?? 0) <= from && (era.toYear ?? Infinity) >= to);
  const periods: Array<[number, number]> = [];
  for (const match of text.matchAll(/\b((?:19|20)\d{2})\s*(?:[–—-]|to|through)\s*((?:19|20)\d{2})\b/g)) periods.push([Number(match[1]), Number(match[2])]);
  for (const match of text.matchAll(/\b((?:19|20)\d{2})\b/g)) periods.push([Number(match[1]), Number(match[1])]);
  const addDecade = (from: number, qualifier?: string) => {
    const offsets = qualifier?.toLowerCase() === 'early' ? [0, 3] : qualifier?.toLowerCase() === 'mid' ? [4, 6] : qualifier?.toLowerCase() === 'late' ? [7, 9] : [0, 9];
    periods.push([from + offsets[0], from + offsets[1]]);
  };
  for (const match of text.matchAll(/\b(?:(early|mid|late)[ -]+)?((?:19|20)?\d0)[’']?s\b/gi)) {
    const year = Number(match[2]);
    const from = year < 100 ? (year <= 20 ? 2000 : 1900) + year : year;
    addDecade(from, match[1]);
  }
  for (const [word, from] of Object.entries(namedDecades)) {
    for (const match of text.matchAll(new RegExp(`\\b(?:(early|mid|late)[ -]+)?${word}\\b`, 'gi'))) addDecade(from, match[1]);
  }
  if (periods.some(([from, to]) => to < from || !contains(from, to))) {
    throw new Error('The show brief promises a period outside its agreed music filters. Please regenerate the episode.');
  }
  if (/\b(?:\d{2,4}[’']?s|(?:19|20)\d{2})\s+(?:and|to|through)\s+(?:beyond|today|now|the present|present day)\b/i.test(text) && !eras.some(era => era.toYear == null)) {
    throw new Error('The show brief promises music beyond its agreed period. Please regenerate the episode.');
  }
  if (genreContract) {
    const allowed = new Set([...genreContract.selected, ...genreContract.context].map(genre => genre.toLowerCase()));
    let remaining = text;
    for (const genre of [...genreContract.known].sort((a, b) => b.length - a.length)) {
      const pattern = new RegExp(`(?:^|\\b)${escaped(genre)}(?:$|\\b)`, 'gi');
      remaining = remaining.replace(pattern, match => {
        // ponytail: inspect exact multiword catalogue names only; single words
        // such as Soul or House are ambiguous prose. This is not a semantic audit.
        if ((genreContract.inspectAmbiguous || genre.trim().split(/[ -]+/).length > 1) && !allowed.has(genre.toLowerCase())) {
          throw new Error(`The show brief names an unselected style (${genre}). Please regenerate the episode.`);
        }
        return ' '.repeat(match.length);
      });
    }
  }
  const others = personaNames.filter(name => name.trim() && !cast.includes(name));
  if (others.some(name => new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(name)}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(text))) {
    throw new Error('The show brief names a presenter outside this episode’s cast. Please regenerate the episode.');
  }
  if (/\b(?:surprise guests?|special artists?|guest appearances?|live interviews?)\b/i.test(text)) {
    throw new Error('The show brief promises an unsupported appearance or interview. Please regenerate the episode.');
  }
}

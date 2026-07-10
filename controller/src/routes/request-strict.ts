export interface StrictRequestTarget {
  title: string | null;
  artist: string | null;
  specific: boolean;
}

const clean = (value: unknown): string =>
  String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s*\[[^\]]*\]\s*/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');

function sameText(want: string | null, got: unknown): boolean {
  if (!want) return true;
  return clean(want) === clean(got);
}

function artistMatches(want: string | null, got: unknown): boolean {
  if (!want) return true;
  const w = clean(want);
  const g = clean(got);
  if (!w || !g) return false;
  return g === w || g.startsWith(`${w} `) || g.endsWith(` ${w}`) || g.includes(` ${w} `);
}

export function strictRequestTarget(matched: any): StrictRequestTarget {
  const artist = typeof matched?.artist === 'string' && matched.artist.trim()
    ? matched.artist.trim()
    : null;
  const artistKey = clean(artist);
  const title = (Array.isArray(matched?.search_terms) ? matched.search_terms : [])
    .map((term: unknown) => String(term ?? '').trim())
    .filter(Boolean)
    .find((term: string) => clean(term) !== artistKey) || null;

  return { title, artist, specific: !!(title || artist) };
}

export function strictRequestSatisfied(target: StrictRequestTarget | null, track: any): boolean {
  if (!target?.specific) return true;
  if (!track) return false;
  return sameText(target.title, track.title) && artistMatches(target.artist, track.artist);
}

export function pickStrictCandidate(target: StrictRequestTarget | null, candidates: any[]): any | null {
  if (!target?.specific) return null;
  return (candidates || []).find((track) => strictRequestSatisfied(target, track)) || null;
}

export function strictFailureMessage(target: StrictRequestTarget): string {
  if (target.title && target.artist) {
    return `Couldn't find "${target.title}" by ${target.artist} in the library.`;
  }
  if (target.title) return `Couldn't find "${target.title}" in the library.`;
  if (target.artist) return `Couldn't find ${target.artist} in the library.`;
  return `Couldn't find an exact match in the library.`;
}

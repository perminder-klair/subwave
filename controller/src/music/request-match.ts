// Exact-match helpers for listener requests. Broad request search remains
// deliberately forgiving; this tiny first pass protects the unambiguous
// "title by artist" form from being diluted by an artist's other results.

export interface RequestMatchCandidate {
  id?: string | null;
  title?: string | null;
  artist?: string | null;
}

function key(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export function exactTitleByArtist<T extends RequestMatchCandidate>(
  candidates: T[],
  { titles, artist }: { titles: string[]; artist: string | null | undefined },
): T | null {
  const artistKey = key(artist);
  const titleKeys = new Set(titles.map(key).filter(Boolean));
  if (!artistKey || titleKeys.size === 0) return null;
  return candidates.find(candidate =>
    !!candidate?.id
    && titleKeys.has(key(candidate.title))
    && key(candidate.artist) === artistKey,
  ) || null;
}

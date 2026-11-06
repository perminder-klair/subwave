// Era review: the same recording stored in several places (the album's own
// folder and a playlist folder, a copy kept twice). The Era tab groups albums
// by their TAGS (album + album artist, like Navidrome and the picker), so a
// copy of "Heroes" in PLAYLISTS/Rock joins the real album. That grouping is
// right for the year question — a copy is the same recording and must get the
// same year — but listing every copy made one album read as duplicated. This
// module folds copies under one entry and names the album's main folder, so the
// tab reads like the disk. Pure: no database.

export interface CopyInput {
  id: string;
  title: string | null;
  artist: string | null;
  durationSec: number | null;
  filePath: string | null;
}

export interface CopyGroup<T extends CopyInput> {
  /** The entry shown: the copy in the main folder when there is one. */
  primary: T;
  /** The other copies of the same recording, primary excluded. */
  copies: T[];
}

/** The folder a file sits in ('' when the path has none). */
export function folderOf(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  const i = filePath.lastIndexOf('/');
  return i > 0 ? filePath.slice(0, i) : null;
}

export function fileNameOf(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  return filePath.slice(filePath.lastIndexOf('/') + 1) || null;
}

/** The folder holding most of the album's files; ties go to the first in sort
 *  order, so the answer never depends on row order. */
export function mainFolderOf(rows: ReadonlyArray<Pick<CopyInput, 'filePath'>>): string | null {
  const n = new Map<string, number>();
  for (const r of rows) {
    const f = folderOf(r.filePath);
    if (f) n.set(f, (n.get(f) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [f, c] of [...n].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (c > bestN) { best = f; bestN = c; }
  }
  return best;
}

const fold = (s: string | null) => (s ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

/** Same recording: same title, same artist and the same length to the second.
 *  An edit and an extended mix differ in length, so they stay apart. A track of
 *  unknown length is never folded with anything. */
export function recordingKey(r: CopyInput): string {
  if (typeof r.durationSec !== 'number' || !Number.isFinite(r.durationSec) || r.durationSec <= 0) return `id:${r.id}`;
  return `${fold(r.title)}\u0000${fold(r.artist)}\u0000${Math.round(r.durationSec)}`;
}

/** Folds each recording's copies under one entry. Groups come back ordered: the
 *  main folder's files first, by file name (which carries the track number in
 *  most libraries), then the rest by path. */
export function groupCopies<T extends CopyInput>(rows: ReadonlyArray<T>, main = mainFolderOf(rows)): CopyGroup<T>[] {
  const byKey = new Map<string, T[]>();
  for (const r of rows) {
    const k = recordingKey(r);
    const g = byKey.get(k);
    if (g) g.push(r); else byKey.set(k, [r]);
  }
  const rank = (r: T) => (folderOf(r.filePath) === main ? 0 : 1);
  const path = (r: T) => r.filePath ?? `\uffff${r.id}`;
  const cmp = (a: T, b: T) => rank(a) - rank(b) || (path(a) < path(b) ? -1 : path(a) > path(b) ? 1 : 0);
  const groups = [...byKey.values()].map(members => {
    const sorted = [...members].sort(cmp);
    return { primary: sorted[0], copies: sorted.slice(1) };
  });
  return groups.sort((a, b) => cmp(a.primary, b.primary));
}

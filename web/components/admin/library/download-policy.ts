// The Library download's rules (DownloadButton.tsx), pure so they are tested
// without a browser. One button look, two places, and never the whole library
// by accident:
// - ticked rows download from the shared selection bar, on every tab
//   (AddToPlaylistBar), as `ids`;
// - a whole list downloads from its card header (ListDownload): the Liked list,
//   and a Browse list only once narrowed (a search or a filter), both up to
//   LIBRARY_DOWNLOAD_LIST_MAX tracks. Otherwise the header shows a short hint.
// The controller refuses the same cases (controller/src/music/download-policy.ts),
// with the same number, read here from the schema mirror.

import { LIBRARY_DOWNLOAD_LIST_MAX } from '../../../lib/schemas.generated';
import type { Energy, LikedSort, Sort, Vocal } from './types';

export { LIBRARY_DOWNLOAD_LIST_MAX };

export interface BrowseFilterState {
  moods: string[]; energy: Energy; vocal: Vocal; genre: string;
  yearFrom: string; yearTo: string; q: string; sort: Sort;
}

// The Browse list's query parameters, paging aside. The list's own request
// and the download's `filter` are both built here, so "the whole list" is
// exactly the list the operator sees (the controller reads both with one
// parser, routes/library/browse.ts `browseFilterFromQuery`).
export function browseFilterParams(f: BrowseFilterState): Record<string, string> {
  const p: Record<string, string> = {};
  if (f.moods.length) p.moods = f.moods.join(',');
  if (f.energy !== 'any') p.energy = f.energy;
  if (f.vocal !== 'any') p.vocal = f.vocal;
  if (f.genre) p.genre = f.genre;
  if (f.yearFrom) p.yearFrom = f.yearFrom;
  if (f.yearTo) p.yearTo = f.yearTo;
  if (f.q.trim()) p.q = f.q.trim();
  p.sort = f.sort;
  return p;
}

// Narrowed: the list's request filters on something; the sort alone does not.
export function browseNarrowed(f: BrowseFilterState): boolean {
  return Object.keys(browseFilterParams(f)).some(k => k !== 'sort');
}

// A whole list, where its header offers it.
export type ListSource =
  | { kind: 'browse'; filter: BrowseFilterState }
  | { kind: 'liked'; sort: LikedSort };

export type DownloadBody =
  | { ids: string[] }
  | { filter: Record<string, string> }
  | { liked: { sort: LikedSort } };

export function selectionBody(selected: readonly string[]): DownloadBody {
  return { ids: [...selected] };
}

export function listBody(source: ListSource): DownloadBody {
  return source.kind === 'liked'
    ? { liked: { sort: source.sort } }
    : { filter: browseFilterParams(source.filter) };
}

// What a list's header shows: the button with the list's count, a hint saying
// why there is none, or nothing (the list has not answered, or is empty).
export type ListOffer =
  | { kind: 'button'; count: number }
  | { kind: 'hint'; text: string }
  | { kind: 'none' };

const n = (v: number) => v.toLocaleString('en-US');

export function listOffer(source: ListSource, total: number | null, cap = LIBRARY_DOWNLOAD_LIST_MAX): ListOffer {
  if (source.kind === 'browse' && !browseNarrowed(source.filter)) {
    return { kind: 'hint', text: 'Filter the list or tick tracks to download' };
  }
  if (!total) return { kind: 'none' };
  if (total > cap) {
    return {
      kind: 'hint',
      text: source.kind === 'browse'
        ? `Narrow the list to ${n(cap)} tracks or fewer to download it`
        : `Over ${n(cap)} liked tracks: tick tracks to download`,
    };
  }
  return { kind: 'button', count: total };
}

export function downloadLabel(count: number | null, pending: boolean): string {
  if (pending) return 'Preparing…';
  if (!count) return 'Download';
  return `Download ${n(count)} track${count === 1 ? '' : 's'}`;
}

export function listTitle(kind: ListSource['kind']): string {
  const what = kind === 'liked' ? 'every liked track' : 'every track in this list';
  return `Download ${what}, all pages (several come as one zip)`;
}

export function selectionTitle(count: number): string {
  return `Download the ${count} ticked track${count === 1 ? '' : 's'} (several come as one zip)`;
}

// What POST /library/download answers.
export interface DownloadLink {
  path: string;
  count: number;
  bytes: number;
  unsized: number;
  name: string;
  single: boolean;
  reindexing?: boolean;
}

// Above either, the operator confirms first: a slip on a big list would start
// hours of transfer.
export const CONFIRM_TRACKS = 50;
export const CONFIRM_BYTES = 2 * 1024 ** 3;

export function needsConfirm(link: Pick<DownloadLink, 'count' | 'bytes'>): boolean {
  return link.count > CONFIRM_TRACKS || link.bytes > CONFIRM_BYTES;
}

export function fmtBytes(v: number): string {
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(1)} GB`;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(0)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${v} B`;
}

// The size the library walk recorded: an estimate, and some tracks have none.
export function sizeText(link: Pick<DownloadLink, 'count' | 'bytes' | 'unsized'>): string {
  if (link.unsized >= link.count || link.bytes <= 0) return 'size unknown';
  const est = `about ${fmtBytes(link.bytes)}`;
  return link.unsized > 0
    ? `${est}, plus ${link.unsized} track${link.unsized === 1 ? '' : 's'} of unknown size`
    : est;
}

export function confirmText(link: DownloadLink): string {
  const what = `${link.count.toLocaleString('en-US')} track${link.count === 1 ? '' : 's'}`;
  return `${what}, ${sizeText(link)}, as ${link.single ? 'one file' : `one zip (${link.name})`}. `
    + 'Your browser saves it as it arrives; the tracks come from the music server one at a time.';
}

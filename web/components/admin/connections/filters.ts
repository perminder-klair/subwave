import type { ConnectionEdgeType } from './types';

export const EDGE_FILTERS: Array<{ id: ConnectionEdgeType; label: string }> = [
  { id: 'samples', label: 'Samples' }, { id: 'sampled-in', label: 'Sampled by' },
  { id: 'cover-of', label: 'Cover of' }, { id: 'covered-by', label: 'Covered by' },
  { id: 'producer', label: 'Producer' }, { id: 'writer', label: 'Writer' },
  { id: 'performed-by', label: 'Artists' }, { id: 'appears-on', label: 'Albums' },
  { id: 'series-membership', label: 'Lists' },
];
export const ALL_EDGE_TYPES = EDGE_FILTERS.map((filter) => filter.id);
export const LEGEND_GROUPS: Array<{ label: string; types: ConnectionEdgeType[]; className: string; symbol: string; overview: boolean }> = [
  { label: 'Samples', types: ['samples', 'sampled-in'], className: 'text-[var(--brain-artist)]', symbol: '●', overview: true },
  { label: 'Covers', types: ['cover-of', 'covered-by'], className: 'text-[var(--brain-recording)]', symbol: '●', overview: true },
  { label: 'Writers / producers', types: ['writer', 'producer'], className: 'text-[var(--brain-contributor)]', symbol: '◆', overview: true },
  { label: 'Artists / albums / lists', types: ['performed-by', 'appears-on', 'series-membership'], className: 'text-muted', symbol: '●', overview: false },
];

export function toggleConnectionGroup(current: readonly ConnectionEdgeType[], group: readonly ConnectionEdgeType[]): ConnectionEdgeType[] {
  const hide = group.some((type) => current.includes(type));
  return ALL_EDGE_TYPES.filter((type) => group.includes(type) ? !hide : current.includes(type));
}

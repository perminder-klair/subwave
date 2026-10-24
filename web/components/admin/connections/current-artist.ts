import type { ConnectionGraphData, ConnectionNode, ConnectionSearchResult } from './types';

/** Name fallback is a unique display lookup, never a new canonical match. */
export function currentArtistOnOverview(
  graph: ConnectionGraphData | undefined,
  current: ConnectionSearchResult | undefined,
  artistName: string | undefined,
): ConnectionNode | null {
  const artists = graph?.nodes.filter(node => node.kind === 'artist') ?? [];
  const canonical = current?.artistNodeId ? artists.find(node => node.id === current.artistNodeId) : undefined;
  if (canonical) return canonical;
  if (current?.localArtistId) {
    const local = artists.filter(node => node.localArtistId === current.localArtistId);
    if (local.length === 1) return local[0] ?? null;
  }
  const key = (name: string) => name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
  if (!artistName?.trim()) return null;
  const matches = artists.filter(node => node.local && key(node.title) === key(artistName));
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

import type { BrainCoverage, ConnectionGraphData } from './types';

export const COVERAGE_LABELS: Record<BrainCoverage['state'], string> = {
  ready: 'Stories ready', empty: 'Researched, nothing usable', unexplored: 'Unexplored',
  queued: 'Queued', researching: 'Researching', incomplete: 'Research incomplete',
};

export function withBrainCoverage(graph: ConnectionGraphData | undefined, artists: Record<string, BrainCoverage> | undefined): ConnectionGraphData | undefined {
  if (!graph || !artists) return graph;
  return { ...graph, nodes: graph.nodes.map(node => ({ ...node, coverage: node.kind === 'artist'
    ? artists[node.id] ?? (node.localArtistId ? artists[`library-artist:${node.localArtistId}`] : undefined) : undefined })) };
}

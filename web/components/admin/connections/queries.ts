import { adminJson, type AdminFetch } from '../../../lib/admin-query';
import type {
  BrainCoverage,
  ConnectionEdgeType,
  ConnectionEntityType,
  ConnectionGraphData,
  ConnectionSearchResult,
} from './types';

export const connectionKeys = {
  coverage: () => ['sleeve-notes', 'connections', 'coverage'] as const,
  all: () => ['sleeve-notes', 'connections'] as const,
  search: (query: string) => [...connectionKeys.all(), 'search', query] as const,
  graph: (entityType: string, entityId: string, edges: readonly string[]) =>
    [...connectionKeys.all(), 'graph', entityType, entityId, ...edges] as const,
  overview: (edges: readonly string[]) => [...connectionKeys.all(), 'overview', ...edges] as const,
  current: (localTrackId: string) => [...connectionKeys.all(), 'current', localTrackId] as const,
};

export async function searchConnectionEntities(
  adminFetch: AdminFetch,
  query: string,
  signal?: AbortSignal,
): Promise<ConnectionSearchResult[]> {
  const response = await adminJson<{ active: boolean; results: ConnectionSearchResult[] }>(
    adminFetch,
    `/sleeve-notes/connections/search?q=${encodeURIComponent(query)}&limit=12`,
    undefined,
    signal,
  );
  return response.results;
}

export function loadConnectionGraph(
  adminFetch: AdminFetch,
  entityType: ConnectionEntityType,
  entityId: string,
  edgeTypes: readonly ConnectionEdgeType[],
  signal?: AbortSignal,
): Promise<ConnectionGraphData> {
  const params = new URLSearchParams({ entityType, entityId, edges: edgeTypes.join(',') });
  return adminJson(adminFetch, `/sleeve-notes/connections/graph?${params.toString()}`, undefined, signal);
}

export async function resolveCurrentConnection(
  adminFetch: AdminFetch,
  localTrackId: string,
  signal?: AbortSignal,
): Promise<ConnectionSearchResult> {
  const response = await adminJson<{ active: boolean; result: ConnectionSearchResult }>(
    adminFetch,
    `/sleeve-notes/connections/resolve/${encodeURIComponent(localTrackId)}`,
    undefined,
    signal,
  );
  return response.result;
}

export function loadConnectionOverview(
  adminFetch: AdminFetch, edgeTypes: readonly ConnectionEdgeType[], signal?: AbortSignal,
): Promise<ConnectionGraphData> {
  const params = new URLSearchParams({ edges: edgeTypes.join(',') });
  return adminJson(adminFetch, `/sleeve-notes/connections/overview?${params.toString()}`, undefined, signal);
}

export function loadBrainCoverage(adminFetch: AdminFetch, signal?: AbortSignal): Promise<{ active: boolean; artists: Record<string, BrainCoverage> }> {
  return adminJson(adminFetch, '/sleeve-notes/connections/coverage', undefined, signal);
}

export const statsKeys = {
  all: ['stats'] as const,
  rollups: () => ['stats', 'rollups'] as const,
  listeners: (range: string) => ['stats', 'listeners', range] as const,
  audience: (range: string) => ['stats', 'audience', range] as const,
  connections: () => ['stats', 'connections'] as const,
  system: () => ['stats', 'system'] as const,
};

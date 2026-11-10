import { useModelDiscoveryQuery } from './discovery-queries';

interface UseModelDiscoveryOpts {
  provider: string;
  baseUrl?: string;
  ollamaUrl?: string;
  scope?: 'embedding' | 'chat';
  enabled: boolean;
  adminFetch: (url: string, init?: RequestInit) => Promise<Response>;
}

interface UseModelDiscoveryResult {
  models: string[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useModelDiscovery(opts: UseModelDiscoveryOpts): UseModelDiscoveryResult {
  return useModelDiscoveryQuery(opts, opts.enabled, opts.adminFetch);
}

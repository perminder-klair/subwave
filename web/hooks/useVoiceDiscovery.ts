import { type DiscoveredVoice, useVoiceDiscoveryQuery } from './discovery-queries';

export type { DiscoveredVoice };

interface UseVoiceDiscoveryOpts {
  provider: string;
  baseUrl?: string;
  enabled: boolean;
  adminFetch: (url: string, init?: RequestInit) => Promise<Response>;
}

interface UseVoiceDiscoveryResult {
  voices: DiscoveredVoice[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useVoiceDiscovery(opts: UseVoiceDiscoveryOpts): UseVoiceDiscoveryResult {
  return useVoiceDiscoveryQuery(opts, opts.enabled, opts.adminFetch);
}

import { useCallback, useEffect, useRef, useState } from 'react';

interface UseModelDiscoveryOpts {
  provider: string;
  baseUrl?: string;
  ollamaUrl?: string;
  enabled: boolean;
  adminFetch: (url: string, init?: RequestInit) => Promise<Response>;
}

interface UseModelDiscoveryResult {
  models: string[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useModelDiscovery({
  provider,
  baseUrl,
  ollamaUrl,
  enabled,
  adminFetch,
}: UseModelDiscoveryOpts): UseModelDiscoveryResult {
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const providerRef = useRef(provider);
  providerRef.current = provider;

  const fetchModels = useCallback(async () => {
    if (!enabled || !provider) {
      setModels([]);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ provider });
      if (baseUrl) params.set('baseUrl', baseUrl);
      if (ollamaUrl) params.set('ollamaUrl', ollamaUrl);
      const r = await adminFetch(`/settings/llm/models?${params}`);
      const data = await r.json() as { ok: boolean; models: string[]; error?: string };
      if (providerRef.current !== provider) return;
      if (data.ok) {
        setModels(data.models);
        setError(null);
      } else {
        setModels([]);
        setError(data.error || 'Discovery failed');
      }
    } catch (e: unknown) {
      if (providerRef.current !== provider) return;
      setModels([]);
      setError(e instanceof Error ? e.message : 'Discovery failed');
    } finally {
      setLoading(false);
    }
  }, [provider, baseUrl, ollamaUrl, enabled, adminFetch]);

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  return { models, loading, error, refresh: fetchModels };
}

import { useCallback, useEffect, useRef, useState } from 'react';

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

// Debounce window for discovery triggered by typing into a base-URL / server
// field, so a multi-character edit fires one request instead of one per keystroke.
const DEBOUNCE_MS = 400;

export function useModelDiscovery({
  provider,
  baseUrl,
  ollamaUrl,
  scope,
  enabled,
  adminFetch,
}: UseModelDiscoveryOpts): UseModelDiscoveryResult {
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Monotonic request id: only the latest in-flight request may write state, so
  // a slow response for a stale (provider, baseUrl, scope) can't clobber a newer
  // one. This guards every input, not just the provider.
  const reqIdRef = useRef(0);

  const runFetch = useCallback(async (signal?: AbortSignal) => {
    if (!enabled || !provider) {
      setModels([]);
      setError(null);
      setLoading(false);
      return;
    }
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ provider });
      if (baseUrl) params.set('baseUrl', baseUrl);
      if (ollamaUrl) params.set('ollamaUrl', ollamaUrl);
      if (scope) params.set('scope', scope);
      const r = await adminFetch(`/settings/llm/models?${params}`, signal ? { signal } : undefined);
      const data = await r.json() as { ok: boolean; models: string[]; error?: string };
      if (reqId !== reqIdRef.current) return;
      if (data.ok) {
        setModels(data.models);
        setError(null);
      } else {
        setModels([]);
        setError(data.error || 'Discovery failed');
      }
    } catch (e: unknown) {
      if (signal?.aborted || reqId !== reqIdRef.current) return;
      setModels([]);
      setError(e instanceof Error ? e.message : 'Discovery failed');
    } finally {
      if (reqId === reqIdRef.current) setLoading(false);
    }
  }, [provider, baseUrl, ollamaUrl, scope, enabled, adminFetch]);

  // Auto-discover on input change, debounced. The AbortController cancels an
  // in-flight request when the inputs change again before it resolves.
  useEffect(() => {
    if (!enabled || !provider) {
      setModels([]);
      setError(null);
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => { runFetch(ctrl.signal); }, DEBOUNCE_MS);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [runFetch, enabled, provider]);

  // Manual refresh fires immediately (no debounce) and bumps the request id, so
  // any debounced or in-flight auto-discovery is superseded.
  const refresh = useCallback(() => { runFetch(); }, [runFetch]);

  return { models, loading, error, refresh };
}

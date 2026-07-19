// Pulls the voice list from a cloud TTS provider so the persona + station
// voice fields can offer a dropdown instead of a free-text box. The TTS twin
// of useModelDiscovery — same debounce / stale-response / abort contract.
//
// Only `openai-compatible` and `elevenlabs` are discoverable (see
// controller/src/llm/internal/speech/voice-catalog.ts); `openai` has a fixed
// published voice set that lives in lib/cloudVoices.ts. Discovery failing is a
// normal outcome, not an error state to shout about — the caller falls back to
// the free-text input it used before.
import { useCallback, useEffect, useRef, useState } from 'react';

export interface DiscoveredVoice {
  id: string;
  label: string;
  hint?: string;
}

interface UseVoiceDiscoveryOpts {
  provider: string;
  // openai-compatible server URL (including the /v1 suffix). Sent so the
  // operator can discover against a URL they've typed but not yet saved.
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

// Matches useModelDiscovery: one request per multi-character edit of a
// base-URL field, not one per keystroke.
const DEBOUNCE_MS = 400;

export function useVoiceDiscovery({
  provider,
  baseUrl,
  enabled,
  adminFetch,
}: UseVoiceDiscoveryOpts): UseVoiceDiscoveryResult {
  const [voices, setVoices] = useState<DiscoveredVoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Monotonic request id: only the newest in-flight request may write state,
  // so a slow response for a stale (provider, baseUrl) can't clobber it.
  const reqIdRef = useRef(0);

  const runFetch = useCallback(async (signal?: AbortSignal) => {
    if (!enabled || !provider) {
      setVoices([]);
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
      const r = await adminFetch(`/settings/tts/voices?${params}`, signal ? { signal } : undefined);
      const data = await r.json() as { ok: boolean; voices: DiscoveredVoice[]; error?: string };
      if (reqId !== reqIdRef.current) return;
      if (data.ok) {
        setVoices(Array.isArray(data.voices) ? data.voices : []);
        setError(null);
      } else {
        setVoices([]);
        setError(data.error || 'Discovery failed');
      }
    } catch (e: unknown) {
      if (signal?.aborted || reqId !== reqIdRef.current) return;
      setVoices([]);
      setError(e instanceof Error ? e.message : 'Discovery failed');
    } finally {
      if (reqId === reqIdRef.current) setLoading(false);
    }
  }, [provider, baseUrl, enabled, adminFetch]);

  // Auto-discover on input change, debounced. The AbortController cancels an
  // in-flight request when the inputs change again before it resolves.
  useEffect(() => {
    // The list on screen belongs to the PREVIOUS provider/server. Drop it now
    // rather than when the new response lands: discovery can take seconds (or
    // time out), and until then the old provider's voices would sit there
    // labelled as this one's — an ElevenLabs field offering a local server's
    // speaker ids, which would save a voice that provider can't synthesize.
    setVoices([]);
    setError(null);
    if (!enabled || !provider) {
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => { runFetch(ctrl.signal); }, DEBOUNCE_MS);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [runFetch, enabled, provider]);

  // Manual refresh fires immediately and bumps the request id, superseding any
  // debounced or in-flight auto-discovery.
  const refresh = useCallback(() => { runFetch(); }, [runFetch]);

  return { voices, loading, error, refresh };
}

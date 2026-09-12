'use client';

import { useCallback, useState } from 'react';
import { useAdminAuth } from '@/lib/adminAuth';
import { fishAudioIssue } from '@/lib/schemas.generated';

// Every step reads and writes through the `set` updater rather than its own
// state, so the Review step can show the whole picture without prop-drilling.
export interface WizardData {
  navidrome: { url: string; user: string; pass: string };
  navidromeTest: { ok: boolean | null; msg?: string };

  llm: {
    provider: string;
    model: string;
    apiKey: string;
    baseUrl: string;
    ollamaUrl: string;
  };
  llmTest: { ok: boolean | null; msg?: string };

  tts: {
    defaultEngine: 'piper' | 'kokoro' | 'cloud' | 'chatterbox' | 'pocket-tts' | 'remote';
    // Advisory only: the web wizard can't start the tts-heavy sidecar, so this
    // records intent (settings.tts.heavyEnabled) and shows the docker commands.
    heavyEnabled: boolean;
    cloud: { enabled: boolean; provider: string; apiKey: string; model: string; voice: string };
  };

  dj: {
    stationName: string;
    locationName: string;
    // Strings because they back text inputs; parsed and range-checked by the
    // controller's settings.update() on save.
    lat: string;
    lng: string;
    // IANA zone. '' = Auto (server zone), matching the admin sentinel.
    timezone: string;
    frequency: 'silent' | 'quiet' | 'moderate' | 'chatty' | 'aggressive';
  };

  // Destined for state/secrets.env, keyed by env-var name to match the
  // controller's allow list.
  apiKeys: Record<string, string>;
}

export const DEFAULT_DATA: WizardData = {
  navidrome: { url: '', user: '', pass: '' },
  navidromeTest: { ok: null },
  llm: {
    provider: 'ollama',
    // Ollama's hosted "cloud" model works with a stock install (no local pull)
    // and matches the terminal wizard's default.
    model: 'glm-5.1:cloud',
    apiKey: '',
    baseUrl: '',
    ollamaUrl: 'http://host.docker.internal:11434',
  },
  llmTest: { ok: null },
  tts: {
    defaultEngine: 'piper',
    heavyEnabled: false,
    cloud: { enabled: false, provider: 'openai', apiKey: '', model: 's2.1-pro', voice: '' },
  },
  dj: {
    stationName: 'SUB/WAVE',
    // Punjab (Chandigarh) — operator's home region; coordinates drive weather.
    locationName: 'Punjab',
    lat: '30.7333',
    lng: '76.7794',
    timezone: '',
    frequency: 'moderate',
  },
  apiKeys: {},
};

export type StepId = 'navidrome' | 'llm' | 'tts' | 'dj' | 'review';

export const STEP_ORDER: StepId[] = ['navidrome', 'llm', 'tts', 'dj', 'review'];

export const STEP_LABELS: Record<StepId, string> = {
  navidrome: 'Navidrome',
  llm: 'LLM',
  tts: 'TTS',
  dj: 'DJ persona',
  review: 'Review',
};

// AbortSignal timeouts reject with TimeoutError; everything else (refused, DNS,
// CORS/TLS) is a bare "Failed to fetch", so name the controller instead.
function fetchErrorMsg(err: unknown): string {
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return 'timed out — the controller did not respond';
  }
  const m = err instanceof Error ? err.message : '';
  return `could not reach the controller${m ? ` (${m})` : ''}`;
}

export function useWizard() {
  const auth = useAdminAuth();
  const [data, setData] = useState<WizardData>(DEFAULT_DATA);
  const [stepIdx, setStepIdx] = useState(0);

  const step = STEP_ORDER[stepIdx];
  const next = useCallback(() => setStepIdx(i => Math.min(i + 1, STEP_ORDER.length - 1)), []);
  const back = useCallback(() => setStepIdx(i => Math.max(i - 1, 0)), []);
  const goto = useCallback((id: StepId) => {
    const i = STEP_ORDER.indexOf(id);
    if (i >= 0) setStepIdx(i);
  }, []);

  const patch = useCallback((p: Partial<WizardData> | ((d: WizardData) => Partial<WizardData>)) => {
    setData(d => {
      const incoming = typeof p === 'function' ? p(d) : p;
      return { ...d, ...incoming };
    });
  }, []);

  // Every wizard write goes through adminFetch for the shell's 401 handling.
  // Both test helpers catch their own failures into the result pill rather than
  // throwing, which would wedge the button on "Testing…" (#682). They take the
  // config as an argument: each step's form only writes back into `data` on
  // Next, so Test must probe the live values.
  const testNavidrome = useCallback(async (creds: WizardData['navidrome']) => {
    // 15s: clears the 5s server-side Subsonic probe; the hop has no default.
    try {
      const r = await auth.adminFetch('/onboarding/test-navidrome', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(creds),
        signal: AbortSignal.timeout(15000),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; serverType?: string; serverVersion?: string; error?: string };
      const result = { ok: !!j.ok, msg: j.ok ? `${j.serverType || 'Subsonic'} v${j.serverVersion || ''}` : (j.error || `controller returned HTTP ${r.status}`) };
      patch({ navidromeTest: result });
      return result;
    } catch (err: unknown) {
      const result = { ok: false, msg: fetchErrorMsg(err) };
      patch({ navidromeTest: result });
      return result;
    }
  }, [auth, patch]);

  const testLlm = useCallback(async (values: WizardData['llm']) => {
    // 60s sits above the controller's 45s generateText abort, so a slow model
    // surfaces the server's error rather than a client timeout.
    try {
      const r = await auth.adminFetch('/onboarding/test-llm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(values),
        signal: AbortSignal.timeout(60000),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; sample?: string; error?: string };
      const result = { ok: !!j.ok, msg: j.ok ? `responded: "${j.sample}"` : (j.error || `controller returned HTTP ${r.status}`) };
      patch({ llmTest: result });
      return result;
    } catch (err: unknown) {
      const result = { ok: false, msg: fetchErrorMsg(err) };
      patch({ llmTest: result });
      return result;
    }
  }, [auth, patch]);

  // Uses data.llm.baseUrl when set; otherwise the controller defaults to the
  // locca host URL.
  const discoverLocca = useCallback(async () => {
    const qs = data.llm.baseUrl ? `?baseUrl=${encodeURIComponent(data.llm.baseUrl)}` : '';
    const r = await auth.adminFetch(`/settings/llm/discover${qs}`);
    const j = (await r.json().catch(() => ({}))) as {
      reachable?: boolean;
      models?: string[];
      error?: string;
    };
    return { reachable: !!j.reachable, models: j.models || [], error: j.error };
  }, [auth, data.llm.baseUrl]);

  const save = useCallback(async () => {
    const apiKeys: Record<string, string> = { ...data.apiKeys };
    if (data.llm.apiKey) {
      const k =
        data.llm.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' :
        data.llm.provider === 'openai' ? 'OPENAI_API_KEY' :
        data.llm.provider === 'azure' ? 'AZURE_API_KEY' :
        data.llm.provider === 'google' ? 'GOOGLE_GENERATIVE_AI_API_KEY' :
        data.llm.provider === 'deepseek' ? 'DEEPSEEK_API_KEY' :
        data.llm.provider === 'openrouter' ? 'OPENROUTER_API_KEY' :
        data.llm.provider === 'requesty' ? 'REQUESTY_API_KEY' :
        data.llm.provider === 'gateway' ? 'AI_GATEWAY_API_KEY' : '';
      if (k) apiKeys[k] = data.llm.apiKey;
    }
    if (data.tts.cloud.enabled && data.tts.cloud.apiKey) {
      const k =
        data.tts.cloud.provider === 'openai' ? 'OPENAI_API_KEY' :
        data.tts.cloud.provider === 'elevenlabs' ? 'ELEVENLABS_API_KEY' :
        data.tts.cloud.provider === 'fish-audio' ? 'FISH_API_KEY' : '';
      if (k) apiKeys[k] = data.tts.cloud.apiKey;
    }
    // The key may come from the root environment, so fishAudioIssue judges only
    // the fields the wizard must persist. Same helper the controller's save runs.
    const fishIssue = fishAudioIssue(data.tts.cloud);
    if (fishIssue) return { ok: false, error: fishIssue };

    const body = {
      navidrome: data.navidrome,
      llm: {
        provider: data.llm.provider,
        model: data.llm.model,
        // Deliberately NO apiKey field: cloud keys go to apiKeys
        // (state/secrets.env), and an empty settings.llm.apiKey means "clear the
        // stored key", not "no key" (applyInlineKey, #657/#1351). Absent =
        // leave it alone.
        baseUrl: data.llm.baseUrl,
        ollamaUrl: data.llm.ollamaUrl,
        // Exception: openai-compatible has no env var, so its key lives inline
        // in settings.llm.apiKey. Sent only when typed this run, absent
        // otherwise (#1351). The hosted DJ Brain preset rides this path.
        ...(data.llm.provider === 'openai-compatible' && data.llm.apiKey
          ? { apiKey: data.llm.apiKey }
          : {}),
      },
      tts: {
        defaultEngine: data.tts.defaultEngine,
        heavyEnabled: data.tts.heavyEnabled,
        cloud: data.tts.cloud.enabled
          ? {
            enabled: true,
            provider: data.tts.cloud.provider,
            ...(data.tts.cloud.provider === 'fish-audio'
              ? { model: data.tts.cloud.model.trim(), voice: data.tts.cloud.voice.trim() }
              : {}),
          }
          : { enabled: false },
      },
      weather: { locationName: data.dj.locationName, lat: data.dj.lat, lng: data.dj.lng },
      station: data.dj.stationName,
      // '' = Auto; sent so a picked city's zone reaches settings.update().
      timezone: data.dj.timezone,
      apiKeys,
    };
    const r = await auth.adminFetch('/onboarding/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    return { ok: !!j.ok, error: j.error };
  }, [auth, data]);

  return {
    auth,
    data,
    patch,
    step,
    stepIdx,
    next,
    back,
    goto,
    testNavidrome,
    testLlm,
    discoverLocca,
    save,
  };
}

export type WizardController = ReturnType<typeof useWizard>;

// What a SUB/WAVE DJ Brain key buys, asked of the brain itself.
//
// The brain (my.getsubwave.com/v1) is an ordinary OpenAI-compatible endpoint,
// so the station wires it through the openai-compatible LLM and cloud-TTS
// providers like any other server. The one thing a station can't know from the
// URL is the plan behind the key: Brain is LLM only, Brain Studio adds the
// studio voice. Wiring cloud TTS on an LLM-only key would send every spoken
// line to a 429 first and rescue it after, so setup asks before it wires.
//
// The brain answers through its model list: GET /v1/models names
// `dj-brain-voice` only for a key with a voice budget (subwave-brain
// src/routes/models.ts). That list is the whole contract; a brain that lists
// the voice for every key (one from before the filter) makes this answer yes,
// which is the old behaviour, never a lost voice.

import { fetchWithTimeout } from '../util/fetch-timeout.js';

export const DJ_BRAIN_CHAT_MODEL = 'dj-brain';
export const DJ_BRAIN_VOICE_MODEL = 'dj-brain-voice';

export interface DjBrainCheck {
  ok: boolean;
  /** The key includes the studio voice. False whenever ok is false. */
  voice: boolean;
  message: string;
  latencyMs: number;
}

/** The voice verdict from a /models list. Pure. */
export function djBrainVoiceIncluded(modelIds: readonly string[]): boolean {
  return modelIds.includes(DJ_BRAIN_VOICE_MODEL);
}

/** Model ids from an OpenAI-shaped /models body; anything else is []. Pure. */
export function modelIdsFrom(body: unknown): string[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((m) => (m as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === 'string');
}

/** Ask the brain what this key includes. Never throws. */
export async function checkDjBrain(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetchWithTimeout = fetchWithTimeout,
): Promise<DjBrainCheck> {
  const t0 = Date.now();
  const url = `${baseUrl.trim().replace(/\/+$/, '')}/models`;
  const fail = (message: string): DjBrainCheck => ({ ok: false, voice: false, message, latencyMs: Date.now() - t0 });
  if (!apiKey.trim()) return fail('Paste your DJ Brain key first');
  try {
    const r = await fetchImpl(url, {
      timeoutMs: 8000,
      bodyDeadline: true,
      headers: { authorization: `Bearer ${apiKey.trim()}` },
    });
    if (r.status === 401 || r.status === 403) return fail('The brain did not accept this key');
    if (!r.ok) return fail(`The brain answered HTTP ${r.status}`);
    const ids = modelIdsFrom(await r.json().catch(() => null));
    if (!ids.includes(DJ_BRAIN_CHAT_MODEL)) return fail('That URL answered, but it is not a DJ Brain');
    const voice = djBrainVoiceIncluded(ids);
    return {
      ok: true,
      voice,
      message: voice ? '✓ Key accepted: brain and studio voice' : '✓ Key accepted: brain only (your station keeps its own voice)',
      latencyMs: Date.now() - t0,
    };
  } catch (err: unknown) {
    return fail((err as { message?: string })?.message || 'The brain is unreachable');
  }
}

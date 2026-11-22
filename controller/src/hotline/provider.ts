// The Hotline's provider seam (docs/plans/hotline.md, "Provider and transport").
//
// The client talks to the provider directly over WebRTC. The controller only
// mints a short-lived session secret with the prompt, voice and tools baked in,
// so the station's key never leaves it and the client cannot choose what the DJ
// is told. Tool calls come back through the controller (`routes/hotline.ts`).
//
// One provider today, OpenAI Realtime. A second (ElevenLabs Agents) is another
// entry here with the same `mintCallSession` contract.
import { fetchWithTimeout } from '../util/fetch-timeout.js';

export interface RealtimeToolDef {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface MintedSession {
  provider: 'openai';
  model: string;
  voice: string;
  // The ephemeral secret the client authenticates its SDP offer with.
  clientSecret: string;
  // Where the client posts its SDP offer (OpenAI's WebRTC calls endpoint).
  sdpUrl: string;
  expiresAt: number | null;
}

// The provider's display name, for the one-time notice a Caller sees before
// their first Call ("Your voice is processed by OpenAI…").
export const PROVIDER_LABELS: Record<string, string> = { openai: 'OpenAI' };

const OPENAI_BASE = 'https://api.openai.com/v1';
// Only connection setup needs to land inside this; the Call itself is bounded
// by the line's cap.
const SECRET_TTL_SEC = 120;
const MINT_TIMEOUT_MS = 15_000;

export function providerReady(provider: string): boolean {
  if (provider === 'openai') return !!process.env.OPENAI_API_KEY?.trim();
  return false;
}

export async function mintCallSession(args: {
  provider: 'openai';
  model: string;
  voice: string;
  instructions: string;
  tools: RealtimeToolDef[];
}): Promise<MintedSession> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  const res = await fetchWithTimeout(`${OPENAI_BASE}/realtime/client_secrets`, {
    timeoutMs: MINT_TIMEOUT_MS,
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expires_after: { anchor: 'created_at', seconds: SECRET_TTL_SEC },
      session: {
        type: 'realtime',
        model: args.model,
        instructions: args.instructions,
        audio: {
          input: { turn_detection: { type: 'semantic_vad' } },
          output: { voice: args.voice },
        },
        tools: args.tools,
        tool_choice: 'auto',
      },
    }),
  });
  const body: any = await res.json().catch(() => null);
  if (!res.ok) {
    const message = body?.error?.message || `HTTP ${res.status}`;
    throw new Error(`OpenAI Realtime refused the session: ${message}`);
  }
  const clientSecret = body?.value ?? body?.client_secret?.value;
  if (typeof clientSecret !== 'string' || !clientSecret) throw new Error('OpenAI Realtime returned no client secret');
  return {
    provider: 'openai',
    model: args.model,
    voice: args.voice,
    clientSecret,
    sdpUrl: `${OPENAI_BASE}/realtime/calls`,
    expiresAt: Number.isFinite(body?.expires_at) ? body.expires_at : null,
  };
}

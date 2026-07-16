// Shared client for POST /settings/tts/preview — the one endpoint that renders
// a short spoken sample for an engine/voice/speed combination. Used by the
// "Play sample" button (VoicePreviewButton) and by the per-row preview
// affordance inside the searchable voice picker (VoicePicker), so both
// surfaces audition through exactly the same request shape. The endpoint
// bypasses the on-air persona AND the silent engine fallback, so an
// unavailable engine returns a real error message here rather than quietly
// playing Piper. No React, no DOM.
import type { AdminAuth } from '../../../lib/adminAuth';

export interface PreviewParams {
  engine: string;
  voice: string;
  cloudProvider?: string;
  // Final rate multiplier to audition (server clamps to 0.5–2.0×).
  speed?: number;
  // Kokoro phonemizer language override (e.g. "en-gb", "ja").
  lang?: string;
  // Persona's free-text on-air language ("Turkish", "Türkçe"). When set, the
  // server renders the sample sentence in that language (falling back to the
  // English line if it doesn't recognize it), so the audition matches what
  // the persona sounds like on air.
  language?: string;
  // Unsaved ElevenLabs voice_settings sliders (issue #696) — sent so the
  // sample auditions the CURRENT slider positions, not the last-saved values.
  voiceSettings?: {
    voiceStability: number;
    voiceStyle: number;
    voiceSimilarityBoost: number;
    voiceUseSpeakerBoost: boolean;
  };
}

export type PreviewResult =
  | { ok: true; blob: Blob }
  | { ok: false; message: string };

// Never throws for server/network failures — those come back as
// `{ ok: false }` with a printable message. An abort via `signal` DOES
// re-throw (the caller cancelled; there is nothing to report).
export async function fetchPreviewSample(
  adminFetch: AdminAuth['adminFetch'],
  params: PreviewParams,
  signal?: AbortSignal,
): Promise<PreviewResult> {
  try {
    const r = await adminFetch('/settings/tts/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal,
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({})) as { message?: string };
      return { ok: false, message: j.message || `Preview failed (${r.status})` };
    }
    return { ok: true, blob: await r.blob() };
  } catch (e) {
    if (signal?.aborted) throw e;
    return { ok: false, message: e instanceof Error ? e.message : 'Preview failed' };
  }
}

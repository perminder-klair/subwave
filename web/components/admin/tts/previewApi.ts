// Shared client for POST /settings/tts/preview, used by VoicePreviewButton and
// VoicePicker so both audition through the same request shape. The endpoint
// bypasses the on-air persona AND the silent engine fallback, so an unavailable
// engine returns a real error rather than quietly playing Piper. No React, no DOM.
import type { AdminAuth } from '../../../lib/adminAuth';

export interface PreviewParams {
  engine: string;
  voice: string;
  cloudProvider?: string;
  // Unsaved model id so the sample uses the exact provider/tier selection.
  cloudModel?: string;
  // Final rate multiplier to audition (server clamps to 0.5–2.0×).
  speed?: number;
  // Kokoro phonemizer language override (e.g. "en-gb", "ja").
  lang?: string;
  // Free-text on-air language ("Turkish", "Türkçe"); the server renders the sample
  // sentence in it, falling back to English when it doesn't recognize it.
  language?: string;
  // Explicit sample text, overriding both the default sentence and the
  // language-localized one. Truncated server-side at PREVIEW_TEXT_MAX (200).
  text?: string;
  // Unsaved corrections override (admin "Test corrections" button, Moods →
  // Speech tab) — tests the tab's CURRENT rows, saved or not.
  corrections?: { from: string; to: string }[];
  // Unsaved ElevenLabs sliders (issue #696), so the sample auditions the CURRENT
  // positions rather than the last-saved values.
  voiceSettings?: {
    voiceStability: number;
    voiceStyle: number;
    voiceSimilarityBoost: number;
    voiceUseSpeakerBoost: boolean;
  };
  // Unsaved Fish Audio controls for an exact before-save audition.
  fishSettings?: {
    temperature: number;
    topP: number;
    latency: 'low' | 'normal' | 'balanced';
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

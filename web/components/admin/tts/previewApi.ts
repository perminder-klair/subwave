// Previews bypass persona selection and silent engine fallback, returning an error for unavailable engines.
import type { AdminAuth } from '../../../lib/adminAuth';
import { AdminResponseError, adminResponse } from '../../../lib/admin-query';

export interface PreviewParams {
  engine: string;
  voice: string;
  cloudProvider?: string;
  // Unsaved model id so the sample uses the exact provider/tier selection.
  cloudModel?: string;
  // Gemini's own model id, so an unsaved dropdown choice is what gets
  // auditioned rather than the saved station model.
  geminiModel?: string;
  // Final rate multiplier to audition (server clamps to 0.5–2.0×).
  speed?: number;
  // Kokoro phonemizer language override (e.g. "en-gb", "ja").
  lang?: string;
  // Free-text on-air language ("Turkish", "Türkçe"); the server renders the sample
  // sentence in it, falling back to English when it doesn't recognize it.
  language?: string;
  voiceStyle?: string;
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
    const r = await adminResponse(adminFetch, '/settings/tts/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal,
    });
    return { ok: true, blob: await r.blob() };
  } catch (e) {
    if (signal?.aborted) throw e;
    if (e instanceof AdminResponseError) {
      const body = e.body as { message?: string };
      return { ok: false, message: body.message || `Preview failed (${e.status})` };
    }
    return { ok: false, message: e instanceof Error ? e.message : 'Preview failed' };
  }
}


export interface SfxEntry {
  name: string;
  description?: string;
  size?: number;
  durationSec?: number;
  builtin?: boolean;
  source?: string;
}

export interface SfxData {
  sfx?: SfxEntry[];
  generatorReady?: boolean;
}

export interface BedEntry {
  name: string;
  description?: string;
  size?: number;
  durationSec?: number | null;
  source?: string;
  builtin?: boolean;
}

export interface BedsData {
  beds?: BedEntry[];
  minDurationSec?: number;
  maxGenDurationSec?: number;
  generatorReady?: boolean;
}

// Every create/import submitter (ImagingPanel) answers this shape rather than
// a bare boolean, so the modal that owns the react-hook-form instance can map
// a server-side refusal back onto the right input via applyServerFieldErrors
// — the same fieldErrors channel POST /settings' inline toggles deliberately
// do NOT use (see ImagingPanel.tsx's saveSettings comment).
export type ImagingSubmitResult = { ok: true } | { ok: false; fieldErrors?: Record<string, string> };

export type JingleImportFailure = { name: string; reason: string };
export type JingleImportResult = {
  ok: number;
  total: number;
  failures: JingleImportFailure[];
  aborted: boolean;
};

export interface VoiceEntry {
  file: string;
  size?: number;
  durationSec?: number | null;
  legacy?: boolean;
  warning?: 'short' | 'long' | null;
}

export interface VoiceData {
  voices?: VoiceEntry[];
  dir?: string;
  legacyDir?: string;
  ffmpeg?: boolean;
  advisory?: { minSec: number; maxSec: number };
}

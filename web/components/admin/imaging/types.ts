// Imaging-page-only types — the asset shapes returned by the controller's
// /sfx and /beds routes, the SFX create-form, and the jingle bulk-import
// result. These moved out of settings/shared.tsx when Jingles / SFX / Beds
// left Settings for their own /admin/imaging page (they were never settings
// data — they're the station's audio assets). The generic settings-save
// primitives (SettingsData, SaveSettings, SectionHeader, PreviewButton) stay
// in settings/shared.tsx; the imaging components still import those from there.

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

export interface SfxForm {
  name: string;
  description: string;
  prompt: string;
  durationSec: string;
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

export interface BedsForm {
  name: string;
  description: string;
  prompt: string;
  durationSec: string;
}

export type JingleImportFailure = { name: string; reason: string };
export type JingleImportResult = {
  ok: number;
  total: number;
  failures: JingleImportFailure[];
  aborted: boolean;
};

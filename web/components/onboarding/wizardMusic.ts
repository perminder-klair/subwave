// The wizard's music step against what the station plays from NOW (#692,
// #1827 review). It used to open on Navidrome whatever the station played
// from, and its save sent only Navidrome credentials — which a router station
// keeps on file without switching back — while Review said "Navidrome".
// Pure, so the rules are tested without a browser.

import type { MusicMode } from '@/lib/schemas.generated';
import { selectionPayload, type DraftSource, type SavedSelectionView } from '../admin/music/sourceDraft';

export interface WizardMusic {
  mode: MusicMode;
  sources: DraftSource[];
  label: string;
  /** What the station plays from now; null until known (or if it could not be read). */
  saved: MusicMode | null;
}

/**
 * Fold the saved selection into an untouched wizard. A station on one router
 * source opens on it, so clicking through keeps it; a merged station opens on
 * the default, since the wizard edits one source and must not collapse a merge
 * the operator did not touch.
 */
export function musicFromSaved(current: WizardMusic, saved: SavedSelectionView, label: string): WizardMusic {
  const untouched = current.mode === 'navidrome' && current.sources.length === 0;
  if (untouched && saved.mode === 'router' && !saved.merge && saved.sources.length === 1) {
    return { mode: 'router', sources: saved.sources, label, saved: 'router' };
  }
  return { ...current, saved: saved.mode };
}

/** The music half of POST /onboarding/save. */
export function musicSaveBody(music: WizardMusic, navidrome: { url: string; user: string; pass: string }) {
  if (music.mode === 'router') return { music: selectionPayload('router', false, music.sources) };
  // Credentials alone are stored without switching a router station back;
  // choosing Navidrome here has to say so.
  return { navidrome, ...(music.saved === 'router' ? { music: { mode: 'navidrome' as const } } : {}) };
}

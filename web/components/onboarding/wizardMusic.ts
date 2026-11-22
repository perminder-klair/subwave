// The wizard's music step against what the station plays from NOW (#692,
// #1827 review). It used to open on Navidrome whatever the station played
// from, and its save sent only Navidrome credentials — which a station on
// another source keeps on file without switching back — while Review said
// "Navidrome".
// Pure, so the rules are tested without a browser.

import { STATION_NAVIDROME_PLUGIN, isStationNavidromeOnly, type MusicMode } from '@/lib/schemas.generated';
import { selectionPayload, type DraftSource, type SavedSelectionView } from '../admin/music/sourceDraft';

/**
 * The wizard's two choices. `navidrome` is the station's own Navidrome — played
 * through the music router by default, or directly if the operator chose that
 * — and `router` is any other source (Jellyfin, Plex, an installed plugin).
 */
export interface WizardMusic {
  mode: MusicMode;
  sources: DraftSource[];
  label: string;
  /** Which choice the station is on now; null until known (or if it could not be read). */
  saved: MusicMode | null;
}

/**
 * Fold the saved selection into an untouched wizard. A station on its own
 * Navidrome (the default) opens on Navidrome; one on a single other source
 * opens on it, so clicking through keeps it; a merged station opens on
 * Navidrome, since the wizard edits one source and must not collapse a merge
 * the operator did not touch.
 */
export function musicFromSaved(current: WizardMusic, saved: SavedSelectionView, label: string): WizardMusic {
  const untouched = current.mode === 'navidrome' && current.sources.length === 0;
  const onNavidrome = saved.mode === 'navidrome' || isStationNavidromeOnly(saved);
  if (untouched && !onNavidrome && !saved.merge && saved.sources.length === 1) {
    return { mode: 'router', sources: saved.sources, label, saved: 'router' };
  }
  return { ...current, saved: onNavidrome ? 'navidrome' : 'router' };
}

/** The music half of POST /onboarding/save. */
export function musicSaveBody(music: WizardMusic, navidrome: { url: string; user: string; pass: string }) {
  if (music.mode === 'router') return { music: selectionPayload('router', false, music.sources) };
  // Credentials alone are stored without moving a station off another source;
  // choosing Navidrome there sends it back to the default — its Navidrome,
  // through the router. A station already on its Navidrome keeps its mode.
  if (music.saved !== 'router') return { navidrome };
  return { navidrome, music: { mode: 'router' as const, merge: false, sources: [{ plugin: STATION_NAVIDROME_PLUGIN, config: {} }] } };
}

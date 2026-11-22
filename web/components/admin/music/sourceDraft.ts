// Draft state for the music-source forms (Admin → Music sources and the
// onboarding wizard). Pure, so the rules the forms enforce — when a draft
// is dirty, when it changes the station's track ids, what is sent — are
// tested without a browser.
//
// Secrets never come back from the controller: a saved source reports which
// secret keys are on file (`secretsSet`), and a blank secret in the draft
// means "keep the stored one".

import {
  STATION_NAVIDROME_PLUGIN,
  missingMusicFields,
  musicSelectionIdentity,
  type MusicConfigField,
  type MusicMode,
  type MusicPluginInfo,
} from '../../../lib/schemas.generated';

export type ConfigValue = string | number | boolean | null;

export interface DraftSource {
  plugin: string;
  config: Record<string, ConfigValue>;
  rawIds?: boolean;
  /** Secret keys with a stored value (from the controller; never the values). */
  secretsSet: string[];
}

export interface SavedSelectionView {
  mode: MusicMode;
  merge: boolean;
  sources: DraftSource[];
}

export function blankSource(plugin: MusicPluginInfo | undefined): DraftSource {
  const config: Record<string, ConfigValue> = {};
  for (const f of plugin?.config ?? []) {
    if (f.default !== undefined) config[f.key] = f.default;
  }
  return { plugin: plugin?.name ?? '', config, secretsSet: [] };
}

/**
 * The saved sources to seed a draft with, or null to wait for a better answer.
 * They are only readable against the router's manifests: without them the
 * controller cannot tell a URL from a secret and shows no settings at all. A
 * draft seeded from that answer, saved once the router was back, dropped every
 * optional setting (a Plex section, a Jellyfin user).
 */
export function seedableSources(view: SavedSelectionView & { router: unknown }): DraftSource[] | null {
  return view.router || view.sources.length === 0 ? view.sources : null;
}

/** Plugins an operator can pick: loaded without errors. */
export function selectablePlugins(plugins: readonly MusicPluginInfo[]): MusicPluginInfo[] {
  return plugins.filter((p) => !p.error);
}

function isBlank(v: ConfigValue | undefined): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

/**
 * Required fields the draft still lacks (env-locked and stored secrets count
 * as set). The controller's own rule (missingMusicFields, shared through the
 * schema mirror), returned as fields so the form can name them.
 */
export function missingFields(source: DraftSource, plugin: MusicPluginInfo | undefined): MusicConfigField[] {
  // The Navidrome source plays the station's Navidrome connection, which is
  // checked as a whole (it has its own card), never through the draft.
  if (!plugin || source.plugin === STATION_NAVIDROME_PLUGIN) return [];
  const stored = source.secretsSet.filter((k) => plugin.config.some((f) => f.key === k && f.type === 'secret'));
  const missing = missingMusicFields(source, plugin, stored);
  return plugin.config.filter((f) => missing.includes(f.key));
}

function comparable(sources: DraftSource[]): string {
  return JSON.stringify(
    sources.map((s) => ({
      plugin: s.plugin,
      rawIds: s.rawIds ?? null,
      config: Object.fromEntries(
        Object.entries(s.config)
          .filter(([, v]) => !isBlank(v))
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
    })),
  );
}

/** Has the operator changed anything worth saving? A typed secret always counts. */
export function draftDirty(saved: SavedSelectionView, mode: MusicMode, merge: boolean, sources: DraftSource[]): boolean {
  if (saved.mode !== mode) return true;
  if (mode !== 'router') return false;
  if (saved.merge !== merge) return true;
  return comparable(saved.sources) !== comparable(sources);
}

/**
 * Will saving this draft change the station's track ids? The controller's own
 * rule (musicSelectionIdentity, shared through the schema mirror), so the
 * warning appears exactly when the save will re-link the library.
 */
export function changesTrackIds(saved: SavedSelectionView, mode: MusicMode, sources: DraftSource[], plugins: readonly MusicPluginInfo[]): boolean {
  return musicSelectionIdentity(saved, plugins) !== musicSelectionIdentity({ mode, sources }, plugins);
}

/** The body for POST /settings/music-source (and the wizard's `music` block). */
export function selectionPayload(mode: MusicMode, merge: boolean, sources: DraftSource[]) {
  if (mode !== 'router') return { mode };
  return {
    mode,
    merge,
    sources: sources.map((s) => ({
      plugin: s.plugin,
      config: Object.fromEntries(Object.entries(s.config).filter(([, v]) => v !== undefined)),
      ...(s.rawIds !== undefined ? { rawIds: s.rawIds } : {}),
    })),
  };
}

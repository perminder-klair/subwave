// Draft state for the music-source forms (admin Admin → Music source and
// the onboarding wizard). Pure, so the rules the forms enforce — when a draft
// is dirty, when it changes the station's track ids, what is sent — are
// tested without a browser.
//
// Secrets never come back from the controller: a saved source reports which
// secret keys are on file (`secretsSet`), and a blank secret in the draft
// means "keep the stored one".

import { missingMusicFields, musicSelectionIdentity, type MusicConfigField, type MusicMode, type MusicPluginInfo } from '../../../lib/schemas.generated';

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
  if (!plugin) return [];
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
export function changesTrackIds(
  saved: SavedSelectionView,
  mode: MusicMode,
  sources: DraftSource[],
  plugins: readonly MusicPluginInfo[],
  /** The stored direct Navidrome URL, so its id-keeping plugin twin reads as the same library. */
  directNavidromeUrl?: string | null,
): boolean {
  return musicSelectionIdentity(saved, plugins, directNavidromeUrl) !== musicSelectionIdentity({ mode, sources }, plugins, directNavidromeUrl);
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

// ── The source picker (admin Music source page and the onboarding wizard) ──
//
// People choose where their music lives, not a "mode": Navidrome is one card
// among Jellyfin, Plex and the rest, and the router behind the others is an
// implementation detail. Navidrome's card is the direct connection; its router
// plugin is reached only through Advanced (combining libraries), so the same
// server never appears twice.

/** A card's id: `navidrome` (direct), a router plugin's name, or `advanced`. */
export type SourceChoice = string;
export const DIRECT_NAVIDROME = 'navidrome';
export const ADVANCED = 'advanced';
const DEMO = 'mock';

export interface SourceOption {
  id: SourceChoice;
  label: string;
  blurb: string;
  /** A short tag on the card. */
  tag?: 'recommended' | 'no setup' | 'installed';
  /** Unpickable, and why. */
  disabled?: string;
}

const BLURBS: Record<string, string> = {
  navidrome: 'Your Navidrome or any Subsonic server, connected directly.',
  jellyfin: 'A Jellyfin music library, with its favourites and playlists.',
  plex: 'A Plex Media Server music library.',
  mock: 'Generated tones, ready at once. Try SUB/WAVE now, connect your library later.',
};
// Built-ins in a fixed order; installed plugins follow, alphabetically; the demo last.
const ORDER = ['jellyfin', 'plex'];

/**
 * The cards, in order. Router sources are listed while the router is down too,
 * disabled with the reason, so a newcomer still sees that they exist.
 */
export function sourceOptions(plugins: readonly MusicPluginInfo[] | null, routerError: string | null): SourceOption[] {
  const down = plugins ? undefined : `the music router is not answering${routerError ? ` (${routerError})` : ''}`;
  const known: MusicPluginInfo[] = plugins
    ? selectablePlugins(plugins).filter((p) => p.name !== DIRECT_NAVIDROME)
    : (['jellyfin', 'plex', DEMO].map((name) => ({ name, label: name === DEMO ? 'Demo library' : name[0]!.toUpperCase() + name.slice(1), builtin: true }) as MusicPluginInfo));
  const rank = (p: MusicPluginInfo) => (p.name === DEMO ? 3 : ORDER.includes(p.name) ? 0 : p.builtin ? 1 : 2);
  const sorted = [...known].sort((a, b) => rank(a) - rank(b) || ORDER.indexOf(a.name) - ORDER.indexOf(b.name) || a.label.localeCompare(b.label));
  return [
    { id: DIRECT_NAVIDROME, label: 'Navidrome', blurb: BLURBS.navidrome!, tag: 'recommended' },
    ...sorted.map((p): SourceOption => ({
      id: p.name,
      label: p.name === DEMO ? 'Demo library' : p.label,
      blurb: BLURBS[p.name] ?? (p.description || 'An installed source plugin.'),
      ...(p.name === DEMO ? { tag: 'no setup' as const } : !p.builtin ? { tag: 'installed' as const } : {}),
      ...(down ? { disabled: down } : {}),
    })),
  ];
}

/**
 * Which card a selection is. One router source other than Navidrome is its
 * own card; a merge, or Navidrome through the router, is Advanced.
 */
export function choiceOf(sel: { mode: MusicMode; merge: boolean; sources: readonly DraftSource[] }): SourceChoice {
  if (sel.mode !== 'router') return DIRECT_NAVIDROME;
  if (!sel.merge && sel.sources.length === 1 && sel.sources[0]!.plugin && sel.sources[0]!.plugin !== DIRECT_NAVIDROME) {
    return sel.sources[0]!.plugin;
  }
  return ADVANCED;
}

/** A display name for a selection: "Navidrome", "Jellyfin", "Jellyfin + Plex". */
export function selectionLabel(sel: { mode: MusicMode; sources: readonly DraftSource[] }, plugins: readonly MusicPluginInfo[] | null): string {
  if (sel.mode !== 'router') return 'Navidrome';
  const names = sel.sources.map((s) => (s.plugin === DEMO ? 'Demo library' : plugins?.find((p) => p.name === s.plugin)?.label ?? s.plugin));
  return names.join(' + ') || 'nothing';
}

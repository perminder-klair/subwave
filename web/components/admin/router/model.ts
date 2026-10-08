// Pure derivations behind Admin → Music router: one channel strip per plugin,
// the service matrix, and the Signal path monitor's readouts. Kept out of the
// components so the rules can be tested without rendering.

import type {
  MusicCapabilities,
  MusicEndpointCoverage,
  MusicPluginInfo,
  RouterActivityRequest,
  RouterStatus,
} from '../../../lib/schemas.generated';

/** The saved selection as GET /settings/music-source returns it: secrets are reported set, never sent. */
export interface SavedSource {
  plugin: string;
  config: Record<string, string | number | boolean | null>;
  rawIds?: boolean;
  secretsSet?: string[];
}

export interface RouterView {
  mode: 'navidrome' | 'router';
  merge: boolean;
  sources: SavedSource[];
  router: RouterStatus | null;
  routerError: string | null;
  /** The router is down and the station plays its Navidrome directly. */
  failover?: { active: boolean };
  /** The station's Navidrome connection: what the navidrome source plays (it has no settings of its own). */
  navidrome?: { url: string; user: string; passSet: boolean; env: { url: boolean; user: boolean; pass: boolean } };
}

export interface Stats {
  artists: number;
  albums: number;
  songs: number;
  genres: number;
}

// The optional ops a source can lack, in the order the capability bank shows
// them. `stats` is left out: it only decides whether the counts above it exist.
export const CAPABILITY_BANK: ReadonlyArray<{ key: keyof MusicCapabilities; short: string; label: string }> = [
  { key: 'similarSongs', short: 'SIM', label: 'similar tracks' },
  { key: 'sonicSimilarity', short: 'SON', label: 'sonic similarity' },
  { key: 'topSongs', short: 'TOP', label: 'top tracks' },
  { key: 'artistInfo', short: 'BIO', label: 'artist info' },
  { key: 'artists', short: 'IDX', label: 'artist index' },
  { key: 'lyrics', short: 'LYR', label: 'lyrics' },
  { key: 'stars', short: 'STR', label: 'stars' },
  { key: 'playlists', short: 'PLS', label: 'playlists' },
  { key: 'scrobble', short: 'PLY', label: 'play counts' },
  { key: 'scanStatus', short: 'SCN', label: 'scan status' },
];

// --- channels -------------------------------------------------------------------

/** Lamp colour: a serving source reports its health; the rest are standby or broken. */
export type ChannelLamp = 'healthy' | 'unreachable' | 'not-configured' | 'error' | 'standby' | 'broken' | 'bus';

export interface ChannelSetting {
  key: string;
  label: string;
  value: string;
}

export interface Channel {
  key: string;
  name: string;
  label: string;
  kind: 'source' | 'bus';
  lamp: ChannelLamp;
  onAir: boolean;
  builtin: boolean;
  version: string;
  idPrefix: string;
  rawIds: boolean;
  /** The big number on the strip: a song share, or a three-letter state code. */
  readout: string;
  caption: string;
  /** Lit meter segments, 0–12. */
  meter: number;
  stats: Stats | null;
  ms: number | null;
  capabilities: MusicCapabilities | null;
  /** The reason a lamp is not green, or what the plugin is. */
  detail: string;
  alert: boolean;
  settings: ChannelSetting[];
}

const SEGMENTS = 12;

function stationNavidromeSettings(nv: NonNullable<RouterView['navidrome']>): ChannelSetting[] {
  const show = (env: boolean, value: string) => (env ? 'from env' : value || 'unset');
  return [
    { key: 'url', label: 'Server URL', value: show(nv.env.url, nv.url) },
    { key: 'user', label: 'Username', value: show(nv.env.user, nv.user) },
    { key: 'password', label: 'Password', value: show(nv.env.pass, nv.passSet ? '•••••• set' : '') },
  ];
}

function settingsOf(plugin: MusicPluginInfo | undefined, saved: SavedSource | undefined, view?: RouterView): ChannelSetting[] {
  if (!plugin) return [];
  if (plugin.name === 'navidrome' && view?.navidrome) return stationNavidromeSettings(view.navidrome);
  return plugin.config.map((field) => {
    let value: string;
    if (plugin.envLocked.includes(field.key)) value = 'from env';
    else if (!saved) value = field.required ? 'required' : 'unset';
    else if (saved.secretsSet?.includes(field.key)) value = '•••••• set';
    else {
      const v = saved.config[field.key];
      value = v === undefined || v === null || v === '' ? (field.default !== undefined ? `${field.default} (default)` : 'unset') : String(v);
    }
    return { key: field.key, label: field.label, value };
  });
}

function readingFor(
  state: string,
  songs: number | null,
  mergedSongs: number | null,
  merged: boolean,
): Pick<Channel, 'readout' | 'caption' | 'meter'> {
  if (state === 'unreachable') return { readout: 'ERR', caption: 'backend not answering', meter: 0 };
  if (state === 'not-configured') return { readout: 'CFG', caption: 'missing settings', meter: 0 };
  if (state === 'error') return { readout: 'ERR', caption: 'plugin fault', meter: 0 };
  if (merged && songs !== null && mergedSongs) {
    const share = Math.round((songs / mergedSongs) * 100);
    return { readout: `${share}%`, caption: 'of merged songs', meter: Math.max(1, Math.round((share / 100) * SEGMENTS)) };
  }
  return { readout: 'RDY', caption: merged ? 'serving source' : 'sole serving source', meter: 9 };
}

/**
 * Every plugin the router knows, as a channel strip: the serving sources first
 * in merge order, then the rest (built-ins before installed), and the merged
 * bus last when more than one source is serving.
 */
export function buildChannels(view: RouterView): Channel[] {
  const status = view.router;
  if (!status) return [];
  const active = view.mode === 'router' ? status.active : [];
  const merged = active.length > 1;
  const songsOf = (a: (typeof active)[number]) => a.health.stats?.songs ?? null;
  const counted = active.map(songsOf);
  const mergedSongs = counted.every((n) => n !== null) ? counted.reduce<number>((sum, n) => sum + (n ?? 0), 0) : null;

  const onAir: Channel[] = active.map((a) => {
    const plugin = status.plugins.find((p) => p.name === a.plugin);
    const saved = view.sources.find((s) => s.plugin === a.plugin);
    return {
      key: `src-${a.plugin}`,
      name: a.plugin,
      label: a.label,
      kind: 'source',
      lamp: a.health.state,
      onAir: true,
      builtin: plugin?.builtin ?? true,
      version: plugin?.version ?? '',
      idPrefix: a.idPrefix,
      rawIds: a.rawIds,
      ...readingFor(a.health.state, songsOf(a), mergedSongs, merged),
      stats: a.health.stats ?? null,
      ms: a.health.ms ?? null,
      capabilities: a.capabilities,
      detail: a.health.error || (a.health.state === 'healthy' ? 'connected' : a.health.state),
      alert: a.health.state !== 'healthy',
      settings: settingsOf(plugin, saved, view),
    };
  });

  const serving = new Set(active.map((a) => a.plugin));
  const standby: Channel[] = status.plugins
    .filter((p) => !serving.has(p.name))
    .sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.label.localeCompare(b.label))
    .map((p) => ({
      key: `src-${p.name}`,
      name: p.name,
      label: p.label,
      kind: 'source',
      lamp: p.error ? 'broken' : 'standby',
      onAir: false,
      builtin: p.builtin,
      version: p.version,
      idPrefix: p.idPrefix,
      rawIds: false,
      readout: p.error ? 'LOAD' : 'STBY',
      caption: p.error ? 'plugin did not load' : 'not serving',
      meter: 0,
      stats: null,
      ms: null,
      capabilities: p.capabilities,
      detail: p.error || p.description || 'standing by',
      alert: Boolean(p.error),
      settings: settingsOf(p, view.sources.find((s) => s.plugin === p.name), view),
    }));

  if (!merged || !status.serving) return [...onAir, ...standby];
  const totals = active.every((a) => a.health.stats)
    ? active.reduce<Stats>(
        (sum, a) => ({
          artists: sum.artists + a.health.stats!.artists,
          albums: sum.albums + a.health.stats!.albums,
          songs: sum.songs + a.health.stats!.songs,
          genres: sum.genres + a.health.stats!.genres,
        }),
        { artists: 0, albums: 0, songs: 0, genres: 0 },
      )
    : null;
  const bus: Channel = {
    key: 'bus',
    name: status.serving.name,
    label: 'Merged bus',
    kind: 'bus',
    lamp: 'bus',
    onAir: true,
    builtin: true,
    version: '',
    idPrefix: '',
    rawIds: false,
    readout: '100%',
    caption: 'merged bus output',
    meter: SEGMENTS,
    stats: totals,
    ms: null,
    capabilities: status.serving.capabilities,
    detail: 'Routed by id / merged lists interleave / writes follow ownership',
    alert: false,
    settings: [],
  };
  return [...onAir, bus, ...standby];
}

// --- service matrix ---------------------------------------------------------------

export type CoverageCell = 'full' | 'degraded' | 'unsupported' | 'unknown';

export interface CoverageColumn {
  key: string;
  label: string;
  onAir: boolean;
  bus: boolean;
}

export interface CoverageRow {
  endpoint: string;
  group: string;
  needs: string | null;
  feature: string | null;
  /** True when some column is known to fall short; unknown is not a difference. */
  varies: boolean;
  cells: Record<string, CoverageCell>;
}

export function coverageColumns(channels: readonly Channel[]): CoverageColumn[] {
  return channels.map((c) => ({ key: c.key, label: c.kind === 'bus' ? 'merged' : c.name, onAir: c.onAir, bus: c.kind === 'bus' }));
}

export function coverageRows(endpoints: readonly MusicEndpointCoverage[], channels: readonly Channel[]): CoverageRow[] {
  return endpoints.map((e) => {
    const cells: Record<string, CoverageCell> = {};
    for (const c of channels) {
      if (!e.needs) cells[c.key] = 'full';
      else if (!c.capabilities) cells[c.key] = 'unknown';
      else cells[c.key] = c.capabilities[e.needs] ? 'full' : (e.whenMissing ?? 'unsupported');
    }
    return {
      endpoint: e.endpoint,
      group: e.group,
      needs: e.needs,
      feature: e.feature ?? null,
      varies: Object.values(cells).some((v) => v === 'degraded' || v === 'unsupported'),
      cells,
    };
  });
}

// --- signal path --------------------------------------------------------------------

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return 'in flight';
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${ms.toLocaleString()} ms`;
}

const CLIENT_LABELS: Record<string, string> = {
  controller: 'Controller',
  liquidsoap: 'Liquidsoap',
  analyzer: 'Analyzer',
};

export function clientLabel(client: string): string {
  return CLIENT_LABELS[client] ?? client;
}

/** The sources a request touched, in the order it first reached them. */
export function sourcesOf(request: RouterActivityRequest): string[] {
  return [...new Set(request.calls.map((c) => c.source))];
}

export function activityMetrics(requests: readonly RouterActivityRequest[]): { captured: number; avgMs: number | null; failed: number } {
  const finished = requests.filter((r) => r.ms !== null);
  return {
    captured: requests.length,
    avgMs: finished.length ? Math.round(finished.reduce((sum, r) => sum + (r.ms ?? 0), 0) / finished.length) : null,
    failed: requests.filter((r) => r.state === 'error').length,
  };
}

/** What a backend's row in the monitor says for the selected request. */
export function backendNote(
  name: string,
  request: RouterActivityRequest | undefined,
  channel: Channel | undefined,
): { text: string; used: boolean; failed: boolean } {
  const calls = request?.calls.filter((c) => c.source === name) ?? [];
  if (calls.length) {
    const failed = calls.some((c) => c.state === 'error');
    const pending = calls.some((c) => c.ms === null);
    const total = calls.reduce((sum, c) => sum + (c.ms ?? 0), 0);
    const n = `${calls.length} ${calls.length === 1 ? 'call' : 'calls'}`;
    return { text: `${n} · ${failed ? 'error' : pending ? 'in flight' : formatMs(total)}`, used: true, failed };
  }
  if (!channel) return { text: 'Standby', used: false, failed: false };
  if (channel.lamp === 'unreachable') return { text: 'Unreachable at last health check', used: false, failed: false };
  if (channel.lamp === 'broken') return { text: 'Plugin did not load', used: false, failed: false };
  if (channel.onAir) return { text: 'Serving · no call in this request', used: false, failed: false };
  return { text: 'Standby', used: false, failed: false };
}

// --- the page header's status strip ----------------------------------------------

export interface StatusCell {
  label: string;
  value: string;
  /** Lights the value: ok green, warn amber, bad red. */
  tone?: 'ok' | 'warn' | 'bad';
}

/**
 * What the router is doing, one reading per cell, for the Music sources header.
 * Direct mode and the failover light the MODE cell rather than adding notes; a
 * FAULTS cell appears only when a plugin failed to load.
 */
export function statusCells(view: RouterView | undefined, error: string | null): StatusCell[] {
  if (!view) return [{ label: 'Link', value: error ? 'NO LINK TO THE CONTROLLER' : 'ESTABLISHING…', tone: error ? 'bad' : undefined }];
  const r = view.router;
  const failover = view.mode === 'router' && Boolean(view.failover?.active);
  const mode: StatusCell =
    view.mode !== 'router'
      ? { label: 'Mode', value: 'DIRECT', tone: 'warn' }
      : failover
        ? { label: 'Mode', value: 'FAILOVER', tone: 'bad' }
        : { label: 'Mode', value: 'ROUTER', tone: 'ok' };
  const serving: StatusCell =
    view.mode !== 'router' || failover
      ? { label: 'Serving', value: 'NAVIDROME DIRECT', tone: failover ? 'bad' : 'warn' }
      : r?.serving
        ? { label: 'Serving', value: r.serving.name.replace(/\+/g, ' + ').toUpperCase() }
        : { label: 'Serving', value: 'NOTHING', tone: 'bad' };
  if (!r) return [mode, serving, { label: 'Router', value: 'UNREACHABLE', tone: 'bad' }];
  const faults = r.plugins.filter((p) => p.error).length;
  return [
    mode,
    serving,
    { label: 'Router', value: `v${r.router.version} · API v${r.router.apiVersion}` },
    { label: 'Plugins', value: String(r.plugins.length) },
    { label: 'Endpoints', value: String(r.endpoints.length) },
    ...(faults ? [{ label: 'Faults', value: String(faults), tone: 'bad' as const }] : []),
  ];
}

/** The status lamp: red on any fault, outage or failover; amber when the router is bypassed. */
export function statusLamp(view: RouterView | undefined, error: string | null): 'ok' | 'idle' | 'error' {
  if (error || !view || view.routerError || view.router?.configError || view.failover?.active) return 'error';
  if (view.router?.plugins.some((p) => p.error)) return 'error';
  return view.mode === 'navidrome' ? 'idle' : 'ok';
}

// Music-source selection (#692): which backend the station's Subsonic client
// talks to. `router` sends every Subsonic call through the SUB/WAVE music
// router, which answers from music-source plugins; `navidrome` is the direct
// connection to the station's Navidrome, kept as an escape hatch and as the
// automatic failover when the router is down (music/source-failover.ts).
//
// Lives in setup-config.json beside the Navidrome password (per station, 0600),
// because plugin config carries secrets too. Absent → the router serving the
// station's own Navidrome with its raw ids (DEFAULT_MUSIC_SELECTION): every
// track id is what a direct connection published, so an upgrading station
// moves behind the router with nothing to re-link.
//
// The built-in `navidrome` source has no settings of its own: it always plays
// the station's Navidrome connection (setup-config.json's `navidrome` block,
// env applied), injected when the router's config.json is written. One place
// for those credentials, shared with direct mode and the failover.
//
// The router-status shapes mirror router/src/internal/routes.ts; change both
// together. They are parsed leniently (.catch) because the router is a separate
// process that may be a different version from this controller.
import { z } from 'zod';

export const MUSIC_MODES = ['navidrome', 'router'] as const;
export type MusicMode = (typeof MUSIC_MODES)[number];

/** Plugin names, as router/src/host/manifest.ts validates them. */
export const MUSIC_PLUGIN_NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;

/** Most sources a merged set may hold. */
export const MUSIC_SOURCES_MAX = 8;

/** The built-in plugin that plays the station's own Navidrome connection. */
export const STATION_NAVIDROME_PLUGIN = 'navidrome';

export const musicConfigValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const musicSourceEntrySchema = z.object({
  plugin: z.string().regex(MUSIC_PLUGIN_NAME_RE, 'unknown plugin name'),
  config: z.record(z.string(), musicConfigValueSchema).default({}),
  /** Publish this source's native ids unprefixed (a Navidrome library keeping its ids). */
  rawIds: z.boolean().optional(),
});

export type MusicSourceEntry = z.infer<typeof musicSourceEntrySchema>;

export type MusicSelection = { mode: MusicMode; merge: boolean; sources: MusicSourceEntry[] };

/** Absent or damaged → the router serving the station's own Navidrome, raw ids. */
export const DEFAULT_MUSIC_SELECTION: MusicSelection = {
  mode: 'router',
  merge: false,
  sources: [{ plugin: STATION_NAVIDROME_PLUGIN, config: {}, rawIds: true }],
};

/** The saved selection, read leniently: a damaged block degrades to the default. */
export const musicSelectionSchema = z
  .object({
    mode: z.enum(MUSIC_MODES).catch('router'),
    merge: z.boolean().catch(false),
    sources: z.array(musicSourceEntrySchema).max(MUSIC_SOURCES_MAX).catch([]),
  })
  .catch(DEFAULT_MUSIC_SELECTION);

/** The station's Navidrome alone, behind the router, publishing its own ids: the default. */
export function isStationNavidromeOnly(sel: { mode: MusicMode; sources: readonly { plugin: string; rawIds?: boolean }[] }): boolean {
  return sel.mode === 'router' && sel.sources.length === 1 && sel.sources[0]!.plugin === STATION_NAVIDROME_PLUGIN && sel.sources[0]!.rawIds !== false;
}

/** Whether the station's Navidrome connection is part of what it plays (direct, or as a router source). */
export function usesStationNavidrome(sel: { mode: MusicMode; sources: readonly { plugin: string }[] }): boolean {
  return sel.mode === 'navidrome' || sel.sources.some((s) => s.plugin === STATION_NAVIDROME_PLUGIN);
}

/**
 * POST /settings/music-source and the onboarding `music` block. A secret left
 * blank keeps the stored value, so the browser never needs the secret back.
 * Strict: a body that would save something unusable is refused.
 */
export const musicSelectionPatchSchema = z
  .object({
    mode: z.enum(MUSIC_MODES),
    merge: z.boolean().default(false),
    sources: z.array(musicSourceEntrySchema).max(MUSIC_SOURCES_MAX).default([]),
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'router' && v.sources.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['sources'], message: 'choose a music source' });
    }
    if (!v.merge && v.sources.length > 1) {
      ctx.addIssue({ code: 'custom', path: ['sources'], message: 'turn on merging to serve more than one source' });
    }
    if (v.sources.filter((s) => s.rawIds).length > 1) {
      ctx.addIssue({ code: 'custom', path: ['sources'], message: 'only one source can keep its own ids' });
    }
    const names = v.sources.map((s) => s.plugin);
    if (new Set(names).size !== names.length) {
      ctx.addIssue({ code: 'custom', path: ['sources'], message: 'each source can only be added once' });
    }
  });

export type MusicSelectionPatch = z.infer<typeof musicSelectionPatchSchema>;

/** POST /settings/music-source/test — one draft source. */
export const musicSourceTestSchema = musicSourceEntrySchema;

// --- router status (GET /internal/status on the router) -------------------------

export const musicConfigFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(['url', 'string', 'secret', 'number', 'boolean', 'select']).catch('string'),
  required: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  help: z.string().optional(),
  placeholder: z.string().optional(),
  env: z.string().optional(),
  // Whether a change re-keys the source's track ids (router sdk/types.ts ConfigField).
  affectsIds: z.boolean().optional(),
});

export type MusicConfigField = z.infer<typeof musicConfigFieldSchema>;

export const musicCapabilitiesSchema = z.object({
  sonicSimilarity: z.boolean().catch(false),
  artists: z.boolean().catch(false),
  artistInfo: z.boolean().catch(false),
  similarSongs: z.boolean().catch(false),
  topSongs: z.boolean().catch(false),
  lyrics: z.boolean().catch(false),
  stars: z.boolean().catch(false),
  playlists: z.boolean().catch(false),
  scrobble: z.boolean().catch(false),
  scanStatus: z.boolean().catch(false),
  stats: z.boolean().catch(false),
});

export type MusicCapabilities = z.infer<typeof musicCapabilitiesSchema>;

export const musicHealthSchema = z.object({
  state: z.enum(['healthy', 'unreachable', 'not-configured', 'error']).catch('error'),
  error: z.string().optional(),
  stats: z.object({ artists: z.number(), albums: z.number(), songs: z.number(), genres: z.number() }).optional(),
  ms: z.number().optional(),
});

export const musicPluginInfoSchema = z.object({
  name: z.string(),
  label: z.string(),
  description: z.string().catch(''),
  version: z.string().catch(''),
  apiVersion: z.number().catch(0),
  idPrefix: z.string().catch(''),
  builtin: z.boolean().catch(false),
  homepage: z.string().nullable().catch(null),
  config: z.array(musicConfigFieldSchema).catch([]),
  envLocked: z.array(z.string()).catch([]),
  error: z.string().nullable().catch(null),
  // What the plugin supported the last time the router built it (active or
  // tested); null when it has not been built since the router started.
  capabilities: musicCapabilitiesSchema.nullable().catch(null),
  // For development and tests only (the demo library): hidden from operators
  // unless already selected or SUBWAVE_DEV_PLUGINS=1.
  devOnly: z.boolean().catch(false),
});

export type MusicPluginInfo = z.infer<typeof musicPluginInfoSchema>;

export const musicActiveSourceSchema = z.object({
  plugin: z.string(),
  label: z.string(),
  idPrefix: z.string().catch(''),
  rawIds: z.boolean().catch(false),
  envLocked: z.array(z.string()).catch([]),
  capabilities: musicCapabilitiesSchema,
  health: musicHealthSchema,
});

// Which optional op each Subsonic endpoint leans on (router subsonic/coverage.ts),
// for the admin service matrix.
export const musicEndpointCoverageSchema = z.object({
  endpoint: z.string(),
  group: z.string().catch('Other'),
  needs: musicCapabilitiesSchema.keyof().nullable().catch(null),
  whenMissing: z.enum(['degraded', 'unsupported']).nullable().catch(null),
  feature: z.string().optional(),
});

export type MusicEndpointCoverage = z.infer<typeof musicEndpointCoverageSchema>;

export const routerStatusSchema = z.object({
  router: z.object({ version: z.string(), apiVersion: z.number() }),
  configured: z.boolean().catch(false),
  merge: z.boolean().catch(false),
  configError: z.string().nullable().catch(null),
  plugins: z.array(musicPluginInfoSchema).catch([]),
  active: z.array(musicActiveSourceSchema).catch([]),
  // What the handlers see: the one active source, or the merged set (union of capabilities).
  serving: z.object({ name: z.string(), label: z.string(), capabilities: musicCapabilitiesSchema }).nullable().catch(null),
  endpoints: z.array(musicEndpointCoverageSchema).catch([]),
});

export type RouterStatus = z.infer<typeof routerStatusSchema>;

export const routerTestResultSchema = z.object({
  ok: z.boolean().catch(false),
  state: z.enum(['healthy', 'unreachable', 'not-configured', 'error']).catch('error'),
  error: z.string().optional(),
  missing: z.array(z.string()).optional(),
  stats: z.object({ artists: z.number(), albums: z.number(), songs: z.number(), genres: z.number() }).optional(),
  capabilities: musicCapabilitiesSchema.optional(),
  envLocked: z.array(z.string()).optional(),
});

export type RouterTestResult = z.infer<typeof routerTestResultSchema>;

// --- router activity (GET /internal/activity on the router) -----------------------
// The admin Music router page's Signal path monitor: recent Subsonic requests
// and the source calls each made. Mirrors router/src/host/activity.ts, which
// never records a query string, id or credential.

export const routerActivityCallSchema = z.object({
  source: z.string(),
  op: z.string(),
  ms: z.number().nullable().catch(null),
  // `unsupported`: the source lacks the op and the handler degraded around it.
  state: z.enum(['pending', 'ok', 'error', 'unsupported']).catch('error'),
});

export type RouterActivityCall = z.infer<typeof routerActivityCallSchema>;

export const routerActivityRequestSchema = z.object({
  id: z.string(),
  endpoint: z.string(),
  /** controller | liquidsoap | analyzer, or the caller's user-agent product name. */
  client: z.string().catch('unknown'),
  at: z.number(),
  ms: z.number().nullable().catch(null),
  state: z.enum(['pending', 'ok', 'error']).catch('error'),
  error: z.string().optional(),
  calls: z.array(routerActivityCallSchema).catch([]),
});

export type RouterActivityRequest = z.infer<typeof routerActivityRequestSchema>;

export const routerActivitySchema = z.object({
  /** Changes when the router restarts. */
  session: z.string(),
  now: z.number(),
  since: z.number().catch(0),
  capacity: z.number().catch(60),
  totals: z.object({ requests: z.number(), failed: z.number() }).catch({ requests: 0, failed: 0 }),
  requests: z.array(routerActivityRequestSchema).catch([]),
});

export type RouterActivity = z.infer<typeof routerActivitySchema>;

/**
 * Required fields a draft source still lacks, given its plugin's manifest.
 * `keptSecrets` are secret keys with a stored value the draft left blank;
 * env-locked keys are satisfied by the environment.
 */
export function missingMusicFields(
  entry: MusicSourceEntry,
  plugin: Pick<MusicPluginInfo, 'config' | 'envLocked'>,
  keptSecrets: readonly string[] = [],
): string[] {
  return plugin.config
    .filter((f) => f.required)
    .filter((f) => {
      if (plugin.envLocked.includes(f.key) || keptSecrets.includes(f.key)) return false;
      const v = entry.config[f.key];
      return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
    })
    .map((f) => f.key);
}

// --- what decides a station's track ids ------------------------------------------
// Shared by the controller's save (a changed identity writes the switch marker
// and starts the re-link walk) and the admin form's "this changes every track
// id" warning, so the two cannot disagree.

export interface MusicIdentitySource {
  plugin: string;
  config: Record<string, unknown>;
  rawIds?: boolean;
}

/** Keys a plugin's manifest marks as secret. */
export function musicSecretKeys(plugin: Pick<MusicPluginInfo, 'config'> | undefined): string[] {
  return (plugin?.config ?? []).filter((f) => f.type === 'secret').map((f) => f.key);
}

// The settings that decide a source's ids. A manifest marks them with
// `affectsIds` (a server address or library section does; a display toggle
// does not); one that marks no field either way is read as "every non-secret
// field", which is what any plugin got before the mark existed. Without the
// manifest every key counts, so an unknown plugin errs towards re-linking.
function musicIdentityKeys(source: MusicIdentitySource, plugin: Pick<MusicPluginInfo, 'config'> | undefined): string[] {
  if (!plugin) return Object.keys(source.config);
  const secrets = musicSecretKeys(plugin);
  if (!plugin.config.some((f) => f.affectsIds !== undefined)) return Object.keys(source.config).filter((k) => !secrets.includes(k));
  return plugin.config.filter((f) => f.affectsIds === true && !secrets.includes(f.key)).map((f) => f.key);
}

/**
 * What decides the station's track ids: the mode and, in router mode, which
 * sources answer, how their ids are published, and the settings that say
 * where they point. Secrets never count — a new password reaches the same
 * library — and a blank value is the same as an absent one.
 */
export function musicSelectionIdentity(
  sel: { mode: MusicMode; merge?: boolean; sources: readonly MusicIdentitySource[] },
  plugins: readonly Pick<MusicPluginInfo, 'name' | 'config'>[] = [],
): string {
  // The station's Navidrome behind the router with raw ids publishes exactly
  // the ids a direct connection does, so moving between the two (the default,
  // the escape hatch, the failover) is never a switch.
  if (sel.mode !== 'router' || isStationNavidromeOnly(sel)) return 'navidrome';
  return JSON.stringify(
    sel.sources.map((s) => {
      const keys = musicIdentityKeys(s, plugins.find((p) => p.name === s.plugin))
        .filter((k) => s.config[k] !== undefined && s.config[k] !== null && s.config[k] !== '')
        .sort((a, b) => a.localeCompare(b));
      return { plugin: s.plugin, rawIds: s.rawIds === true, config: Object.fromEntries(keys.map((k) => [k, s.config[k]])) };
    }),
  );
}

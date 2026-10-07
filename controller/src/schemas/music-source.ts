// Music-source selection (#692): which backend the station's Subsonic client
// talks to. `navidrome` is the direct connection (setup-config.json's
// `navidrome` block, unchanged); `router` sends every Subsonic call through the
// SUB/WAVE music router, which answers from music-source plugins.
//
// Lives in setup-config.json beside the Navidrome password (per station, 0600),
// because plugin config carries secrets too. Absent → `navidrome`, so an
// upgrade is byte-identical.
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

export const musicConfigValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const musicSourceEntrySchema = z.object({
  plugin: z.string().regex(MUSIC_PLUGIN_NAME_RE, 'unknown plugin name'),
  config: z.record(z.string(), musicConfigValueSchema).default({}),
  /** Publish this source's native ids unprefixed (a Navidrome library keeping its ids). */
  rawIds: z.boolean().optional(),
});

export type MusicSourceEntry = z.infer<typeof musicSourceEntrySchema>;

/** The saved selection, read leniently: a damaged block degrades to direct Navidrome. */
export const musicSelectionSchema = z
  .object({
    mode: z.enum(MUSIC_MODES).catch('navidrome'),
    merge: z.boolean().catch(false),
    sources: z.array(musicSourceEntrySchema).max(MUSIC_SOURCES_MAX).catch([]),
  })
  .catch({ mode: 'navidrome', merge: false, sources: [] });

export type MusicSelection = z.infer<typeof musicSelectionSchema>;

export const DEFAULT_MUSIC_SELECTION: MusicSelection = { mode: 'navidrome', merge: false, sources: [] };

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

export const routerStatusSchema = z.object({
  router: z.object({ version: z.string(), apiVersion: z.number() }),
  configured: z.boolean().catch(false),
  merge: z.boolean().catch(false),
  configError: z.string().nullable().catch(null),
  plugins: z.array(musicPluginInfoSchema).catch([]),
  active: z.array(musicActiveSourceSchema).catch([]),
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

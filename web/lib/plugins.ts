// Community plugins directory: music-source plugins, which let a station play
// from a server or library SUB/WAVE doesn't speak out of the box (#2413).
// Entries come from the community catalog.json, an ISR-revalidated fetch
// (communityCatalog.ts) that degrades to an empty list when unreachable. The
// community repo's build-catalog.mjs validates the same shape on the way in;
// this parser trusts nothing either way, because the fetch is live.
//
// A listing is NOT installable from here: a plugin is code that runs in the
// router, and installing one is a deliberate operator step (docs/music-source-plugins.md).
import { fetchCommunityCatalog } from './communityCatalog';

/** Mirrors PLUGIN_NAME_RE in router/src/host/manifest.ts: the manifest `name`,
 *  which is also the folder the plugin installs into. */
const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The conformance kit's outcome counts (`npm --prefix router run conformance -- <plugin> --json`). */
export interface ConformanceCounts {
  pass: number;
  warn: number;
  fail: number;
  skip: number;
}

export interface CommunityPlugin {
  /** Derived from the entry's filename in the community repo; stable react key. */
  slug: string;
  /** Display name, the manifest `label` ("Music folder"). */
  name: string;
  /** The manifest `name` ("folder"): the folder under router/plugins/. */
  plugin: string;
  /** What it plays from, in a few words ("Emby", "A folder of audio files"). */
  connectsTo: string;
  /** Where its code lives. Required: a listing is a review of the code. */
  repo: string;
  /** The plugin API major it targets; a router loads only its own. */
  apiVersion: number;
  /** ≤280 chars. */
  description?: string;
  /** Name or @handle. A leading @ renders as a GitHub profile link. */
  author?: string;
  /** The SUB/WAVE version it was last checked against, x.y.z. */
  checkedWith?: string;
  /** The conformance result it was submitted with. */
  conformance?: ConformanceCounts;
  /** It reads files on the host, so the router needs a folder mounted. */
  hostFiles: boolean;
  /** ISO yyyy-mm-dd the plugin was added. */
  submitted?: string;
}

/** An https link, or undefined. */
function safeLink(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  try {
    return new URL(v.trim()).protocol === 'https:' ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}

const count = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1000 ? v : undefined;

/** All four counts or none: a partial result would read as a clean one. */
function parseConformance(v: unknown): ConformanceCounts | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const pass = count(o.pass);
  const warn = count(o.warn);
  const fail = count(o.fail);
  const skip = count(o.skip);
  if (pass === undefined || warn === undefined || fail === undefined || skip === undefined) return undefined;
  return { pass, warn, fail, skip };
}

const text = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
};

// name, plugin, connectsTo, an https repo and an apiVersion are the floor;
// anything less returns null and only that entry is skipped. A malformed
// optional field drops the field and keeps the plugin.
export function parsePlugin(data: Record<string, unknown>): CommunityPlugin | null {
  const name = text(data.name, 60);
  const plugin = typeof data.plugin === 'string' && PLUGIN_NAME_RE.test(data.plugin) ? data.plugin : undefined;
  const connectsTo = text(data.connectsTo, 60);
  const repo = safeLink(data.repo);
  const apiVersion =
    typeof data.apiVersion === 'number' && Number.isInteger(data.apiVersion) && data.apiVersion > 0
      ? data.apiVersion
      : undefined;
  if (!name || !plugin || !connectsTo || !repo || apiVersion === undefined) return null;

  const checkedWith = typeof data.checkedWith === 'string' ? data.checkedWith.trim().replace(/^v/, '') : '';
  const submitted = typeof data.submitted === 'string' ? data.submitted.trim() : '';

  return {
    slug: (typeof data.slug === 'string' && data.slug) || plugin,
    name,
    plugin,
    connectsTo,
    repo,
    apiVersion,
    description: text(data.description, 280),
    author: text(data.author, 60),
    checkedWith: SEMVER_RE.test(checkedWith) ? checkedWith : undefined,
    conformance: parseConformance(data.conformance),
    hostFiles: data.hostFiles === true,
    submitted: DATE_RE.test(submitted) ? submitted : undefined,
  };
}

/** Newest first, then by name; undated last. */
export function sortPlugins(list: CommunityPlugin[]): CommunityPlugin[] {
  return [...list].sort(
    (a, b) => (b.submitted ?? '').localeCompare(a.submitted ?? '') || a.name.localeCompare(b.name),
  );
}

export async function getAllPlugins(): Promise<CommunityPlugin[]> {
  const { plugins } = await fetchCommunityCatalog();
  return sortPlugins(plugins.map((p) => parsePlugin(p)).filter((p): p is CommunityPlugin => p !== null));
}

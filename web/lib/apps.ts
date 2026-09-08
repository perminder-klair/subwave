// Community apps directory: third-party things that talk to a station. Entries
// come from the community catalog.json, an ISR-revalidated fetch
// (communityCatalog.ts) that degrades to an empty list when unreachable.
import { fetchCommunityCatalog } from './communityCatalog';

/** Mirrors APP_TYPES in the community repo's build-catalog.mjs. `integration`
 *  is a catch-all (MCP servers, Home Assistant, hardware, libraries) and stays
 *  last for that reason. `skin` is a player face from the COMPILE-TIME registry
 *  (components/skins/index.ts) with no runtime install path, so a listed skin
 *  is source an operator builds into their own deployment. */
export const APP_TYPES = [
  'mobile',
  'web',
  'desktop',
  'terminal',
  'bot',
  'skin',
  'integration',
] as const;
export type AppType = (typeof APP_TYPES)[number];

export const APP_TYPE_LABELS: Record<AppType, string> = {
  mobile: 'Mobile',
  web: 'Web',
  desktop: 'Desktop',
  terminal: 'Terminal',
  bot: 'Bot',
  skin: 'Skin',
  integration: 'Integration',
};

// Images are submitter-hosted and catalog.json is a live remote fetch, so the
// host is a trust boundary. next/image is the real enforcement (it throws at
// render); re-checking here costs one image instead of the page. Keep in
// lockstep with web/next.config.js and the community repo.
const IMAGE_HOSTS = ['raw.githubusercontent.com', 'user-images.githubusercontent.com', 'github.com'];

export interface CommunityApp {
  /** Derived from the entry's filename in the community repo; stable react key. */
  slug: string;
  name: string;
  /** Where you get it — store listing, site, or repo. */
  url: string;
  type: AppType;
  /** ≤280 chars. */
  description?: string;
  /** Name or @handle. A leading @ renders as a GitHub profile link. */
  author?: string;
  /** Short tags — "iOS", "Sonos", "Home Assistant". */
  platforms?: string[];
  /** Source URL. Its presence is what puts a "source" link on the card — there
   *  is no separate open-source boolean that could contradict it. */
  repo?: string;
  /** Square image URL, host-allowlisted. */
  icon?: string;
  /** Wide image URL, host-allowlisted. */
  screenshot?: string;
  /** Floats to the top of the list when true. Maintainer-set. */
  featured?: boolean;
  /** ISO yyyy-mm-dd the app was added. */
  submitted?: string;
}

function isAppType(v: unknown): v is AppType {
  return typeof v === 'string' && (APP_TYPES as readonly string[]).includes(v);
}

/** An allowlisted https image URL, or undefined. Never throws. */
function safeImage(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  try {
    const u = new URL(v.trim());
    if (u.protocol !== 'https:') return undefined;
    return IMAGE_HOSTS.includes(u.host) ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** An http(s) link, or undefined. */
function safeLink(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}

// name, url and a known type are the floor; anything else returns null and only
// that entry is skipped. Bad image URLs drop the field and keep the app.
function parseApp(data: Record<string, unknown>): CommunityApp | null {
  const name = String(data.name ?? '').trim();
  const url = safeLink(data.url);
  if (!name || !url || !isAppType(data.type)) return null;

  const platforms = (Array.isArray(data.platforms) ? data.platforms : [])
    .map((p) => String(p).trim())
    .filter(Boolean)
    .map((p) => p.slice(0, 24))
    .slice(0, 6);

  return {
    slug:
      (typeof data.slug === 'string' && data.slug) ||
      name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name,
    url,
    type: data.type,
    description: data.description ? String(data.description).trim().slice(0, 280) : undefined,
    author: data.author ? String(data.author).trim().slice(0, 60) : undefined,
    ...(platforms.length ? { platforms } : {}),
    repo: safeLink(data.repo),
    icon: safeImage(data.icon),
    screenshot: safeImage(data.screenshot),
    featured: Boolean(data.featured),
    submitted: data.submitted ? String(data.submitted).trim() : undefined,
  };
}

export async function getAllApps(): Promise<CommunityApp[]> {
  const { apps } = await fetchCommunityCatalog();
  return apps
    .map((a) => parseApp(a))
    .filter((a): a is CommunityApp => a !== null)
    .sort((a, b) => {
      if (a.featured !== b.featured) return a.featured ? -1 : 1;
      // Newest first; ISO yyyy-mm-dd compares lexicographically, undated last.
      const byDate = (b.submitted ?? '').localeCompare(a.submitted ?? '');
      if (byDate !== 0) return byDate;
      return a.name.localeCompare(b.name);
    });
}

/** Takes an already-loaded list: /apps streams into several Suspense
 *  boundaries, so calling getAllApps() here would refetch the catalog. */
export function appStats(all: CommunityApp[]): { count: number; types: number } {
  return { count: all.length, types: new Set(all.map((a) => a.type)).size };
}

/** The types actually present, in APP_TYPES order. The chips render from this,
 *  not the full vocabulary, so a selection can never produce an empty grid —
 *  which is what lets the filter stay CSS-only. */
export function presentTypes(all: CommunityApp[]): AppType[] {
  const seen = new Set(all.map((a) => a.type));
  return APP_TYPES.filter((t) => seen.has(t));
}

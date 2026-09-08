// Community stations directory loader. Entries come from the community
// catalog index (catalog.json), not local files. Runs server-side; the fetch is
// ISR-revalidated (see communityCatalog.ts), so the directory refreshes without
// a web redeploy. Degrades to an empty list when the catalog is unreachable.
import { fetchCommunityCatalog } from './communityCatalog';
import { SITE_URL } from './site';

export interface Station {
  /** Derived from the filename; stable id for keys + map markers. */
  slug: string;
  name: string;
  /** Public site origin, e.g. https://radio.example.com. Also the probe base. */
  url: string;
  location?: string;
  country?: string;
  operator?: string;
  genre?: string;
  description?: string;
  /** Decimal degrees. Missing → not plotted on the map, but still listed. */
  lat?: number;
  lon?: number;
  featured?: boolean;
  submitted?: string;
}

// `url` must be the bare site origin: consumers append `/api/now-playing`,
// `/api` and `/stream.mp3`, so a submitted path 404s all of them (#925).
function toOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url.replace(/\/$/, '');
  }
}

// Missing fields fall back to undefined so a sparse submission still renders.
// lat/lon are kept only when both parse to finite numbers. The slug is stamped
// onto each entry by the catalog builder, from the filename.
function parseStation(data: Record<string, unknown>): Station | null {
  const name = String(data.name ?? '').trim();
  const url = String(data.url ?? '').trim();
  if (!name || !url) return null; // name + url are the floor

  const lat = Number(data.lat);
  const lon = Number(data.lon);
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lon);

  return {
    slug: (typeof data.slug === 'string' && data.slug) || name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name,
    url: toOrigin(url),
    location: data.location ? String(data.location) : undefined,
    country: data.country ? String(data.country) : undefined,
    operator: data.operator ? String(data.operator) : undefined,
    genre: data.genre ? String(data.genre) : undefined,
    description: data.description ? String(data.description) : undefined,
    ...(hasCoords ? { lat, lon } : {}),
    featured: Boolean(data.featured),
    submitted: data.submitted ? String(data.submitted) : undefined,
  };
}

/** Every station. Featured first, then alphabetical by name. */
export async function getAllStations(): Promise<Station[]> {
  const { stations } = await fetchCommunityCatalog();
  return stations
    .map((s) => parseStation(s))
    .filter((s): s is Station => s !== null)
    .sort((a, b) => {
      if (a.featured !== b.featured) return a.featured ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

// The serialisable subset of Station that crosses the server→client boundary
// for the landing page's PlayerShowcase tabs. The full Station stays server-side.

export interface ShowcaseStation {
  slug: string;
  name: string;
  /** Ignored when `isLocal`: the player then keeps its env-default same-origin
   *  wiring, so a self-hosted landing page demos that operator's own station. */
  url: string;
  genre?: string;
  isLocal?: boolean;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/** Local station first: the entry whose host matches SITE_URL is marked local.
 *  When none matches (self-hosted or dev), a synthetic "This station" tab is
 *  prepended so the demo still opens on the operator's own broadcast. */
export async function getShowcaseStations(): Promise<ShowcaseStation[]> {
  const siteHost = hostOf(SITE_URL);
  const all = (await getAllStations()).map<ShowcaseStation>((s) => ({
    slug: s.slug,
    name: s.name,
    url: s.url,
    ...(s.genre ? { genre: s.genre } : {}),
    ...(siteHost && hostOf(s.url) === siteHost ? { isLocal: true } : {}),
  }));
  const local = all.find((s) => s.isLocal);
  if (!local) {
    return [{ slug: '__local', name: 'This station', url: SITE_URL, isLocal: true }, ...all];
  }
  return [local, ...all.filter((s) => s !== local)];
}

/** Pure, over an already-loaded list: /stations reads the directory once and
 *  streams it into several Suspense boundaries, so calling getAllStations()
 *  here would cost a second catalog fetch per render. */
export function stationStats(all: Station[]): { count: number; countries: number } {
  const countries = new Set(
    all.map((s) => (s.country || s.location || '').trim().toLowerCase()).filter(Boolean),
  );
  return { count: all.length, countries: countries.size };
}

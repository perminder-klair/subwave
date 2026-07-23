// Community stations directory loader. Sources the per-station entries from the
// community catalog index (catalog.json, published by the community
// repo) rather than local files — the directory now lives in that repo alongside
// the skills/personas/shows catalogs. Runs server-side; the catalog fetch is
// ISR-revalidated (see communityCatalog.ts), so the directory refreshes without
// a web redeploy. Degrades to an empty list when the catalog is unreachable.
import { fetchCommunityCatalog } from './communityCatalog';
import { SITE_URL } from './site';

export interface Station {
  /** Derived from the filename; stable id for keys + map markers. */
  slug: string;
  /** Display name of the station. */
  name: string;
  /** Public site origin, e.g. https://radio.example.com. Also the live probe base. */
  url: string;
  /** Free-text "City, Country". */
  location?: string;
  /** Country, used for the "M countries" stat. */
  country?: string;
  /** Who runs it — name or @handle. */
  operator?: string;
  /** A short genre / vibe label. */
  genre?: string;
  /** One or two sentences. */
  description?: string;
  /** Decimal degrees, optional. Missing → not plotted on the map (still listed). */
  lat?: number;
  lon?: number;
  /** Floats to the top of the list when true. */
  featured?: boolean;
  /** ISO yyyy-mm-dd the station was added. */
  submitted?: string;
}

// `url` must be the bare site origin — StationCard probes `‹url›/api/now-playing`
// and originForStation appends `/api` + `/stream.mp3`, so a submitted path like
// `https://radio.example.com/listen` would 404 every consumer (#925 follow-up).
function toOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url.replace(/\/$/, '');
  }
}

// Coerce a catalog station entry into a clean Station. Unknown/missing fields
// fall back to undefined so a sparse submission (just name + url + location)
// still renders. lat/lon are only kept when both parse to finite numbers. The
// slug is stamped onto each entry by the catalog builder (from the filename).
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

// ── Landing showcase tabs ────────────────────────────────────────────────
// The landing page's embedded player can tune the demo to any directory
// station (PlayerShowcase tabs). This is the serialisable subset that crosses
// the server→client boundary; the full Station stays server-side.

export interface ShowcaseStation {
  slug: string;
  name: string;
  /** Public site origin. Ignored when `isLocal` — the player then keeps its
   *  env-default same-origin wiring, which is what makes a self-hosted
   *  landing page demo that operator's own station, not the flagship. */
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

/** Directory stations shaped for the landing showcase tabs, local station
 *  first. The directory entry whose host matches SITE_URL is marked local
 *  (the flagship, on getsubwave.com); when none matches — a self-hosted or
 *  dev deployment — a synthetic "This station" tab is prepended so the demo
 *  still opens on the operator's own broadcast. */
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

/** Header tallies: total stations + distinct countries. Pure, over an
 *  already-loaded list — /stations reads the directory once and streams it
 *  into several Suspense boundaries, so a tally helper that re-entered
 *  getAllStations() would mean a second catalog fetch per render. */
export function stationStats(all: Station[]): { count: number; countries: number } {
  const countries = new Set(
    all.map((s) => (s.country || s.location || '').trim().toLowerCase()).filter(Boolean),
  );
  return { count: all.length, countries: countries.size };
}

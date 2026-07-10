// Community stations directory loader. Reads the per-station JSON files under
// web/content/stations, one file per station, and exposes the list + a couple
// of summary stats. Everything here runs server-side at render time (the
// /stations route is statically generated), so the filesystem read never
// happens at request time in the standalone image.
//
// One file per station — NOT a single shared array — is deliberate: community
// submissions arrive as pull requests, and a file each means PRs never collide
// and are trivial to review or revert. Mirrors the content/news pattern.
import fs from 'node:fs';
import path from 'node:path';
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

const STATIONS_DIR = path.join(process.cwd(), 'content', 'stations');

function fileToSlug(file: string): string {
  return file.replace(/\.json$/i, '');
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

// Coerce whatever the JSON carries into a clean Station. Unknown/missing fields
// fall back to undefined so a sparse submission (just name + url + location)
// still renders. lat/lon are only kept when both parse to finite numbers.
function parseStation(slug: string, raw: string): Station | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null; // a malformed file is skipped, not fatal — the page still renders
  }
  const name = String(data.name ?? '').trim();
  const url = String(data.url ?? '').trim();
  if (!name || !url) return null; // name + url are the floor

  const lat = Number(data.lat);
  const lon = Number(data.lon);
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lon);

  return {
    slug: (typeof data.slug === 'string' && data.slug) || slug,
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

let _cache: Station[] | null = null;

/** Every station. Featured first, then alphabetical by name. Memoised. */
export function getAllStations(): Station[] {
  if (_cache) return _cache;
  let files: string[];
  try {
    files = fs.readdirSync(STATIONS_DIR);
  } catch {
    return []; // no content dir yet → empty wire, page still renders
  }
  _cache = files
    .filter((f) => f.toLowerCase().endsWith('.json'))
    .map((f) => parseStation(fileToSlug(f), fs.readFileSync(path.join(STATIONS_DIR, f), 'utf8')))
    .filter((s): s is Station => s !== null)
    .sort((a, b) => {
      if (a.featured !== b.featured) return a.featured ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  return _cache;
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
export function getShowcaseStations(): ShowcaseStation[] {
  const siteHost = hostOf(SITE_URL);
  const all = getAllStations().map<ShowcaseStation>((s) => ({
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

/** Header tallies: total stations + distinct countries. */
export function getStationStats(): { count: number; countries: number } {
  const all = getAllStations();
  const countries = new Set(
    all.map((s) => (s.country || s.location || '').trim().toLowerCase()).filter(Boolean),
  );
  return { count: all.length, countries: countries.size };
}

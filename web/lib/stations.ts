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
    url: url.replace(/\/$/, ''),
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

/** Stations with usable coordinates — the ones the map can plot. */
export function getMappableStations(): Station[] {
  return getAllStations().filter((s) => s.lat != null && s.lon != null);
}

/** Header tallies: total stations + distinct countries. */
export function getStationStats(): { count: number; countries: number } {
  const all = getAllStations();
  const countries = new Set(
    all.map((s) => (s.country || s.location || '').trim().toLowerCase()).filter(Boolean),
  );
  return { count: all.length, countries: countries.size };
}

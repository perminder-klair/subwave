// Cache beacon-resolved countries by IP for the admin Icecast table. This bounded, expiring
// map stays in memory; raw IPs never reach disk. Countries are advisory and never authorize
// access.

import { normalizeLookupIp } from './geoip.js';

/** A listener tunes in once per page load and may stay for hours. */
export const BEACON_COUNTRY_TTL_MS = 24 * 60 * 60 * 1000;
/** Bounds memory on a busy or abused public endpoint; oldest entry goes first. */
export const BEACON_COUNTRY_MAX = 5000;

interface Entry {
  country: string;
  at: number;
}

// Map iteration order is insertion order, and remember() re-inserts on every
// write, so the first key is always the least recently beaconed.
const byIp = new Map<string, Entry>();

export function rememberBeaconCountry(
  rawIp: string | undefined,
  country: string | undefined,
  now = Date.now(),
): void {
  const ip = normalizeLookupIp(rawIp);
  if (!ip || !country) return;
  byIp.delete(ip);
  byIp.set(ip, { country, at: now });
  while (byIp.size > BEACON_COUNTRY_MAX) {
    const oldest = byIp.keys().next().value;
    if (oldest === undefined) break;
    byIp.delete(oldest);
  }
}

export function beaconCountryFor(rawIp: string | undefined, now = Date.now()): string | undefined {
  const ip = normalizeLookupIp(rawIp);
  if (!ip) return undefined;
  const hit = byIp.get(ip);
  if (!hit) return undefined;
  if (now - hit.at > BEACON_COUNTRY_TTL_MS) {
    byIp.delete(ip);
    return undefined;
  }
  return hit.country;
}

/** Test seam. */
export function resetBeaconCountries(): void {
  byIp.clear();
}

/** Test seam. */
export function beaconCountryCount(): number {
  return byIp.size;
}

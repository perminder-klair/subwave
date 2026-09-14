// Offline GeoIP country lookup, the last link in the listener-country chain and
// the only one needing a file on disk. Reads the MaxMind MMDB format via
// mmdb-lib, so GeoLite2-Country, DB-IP Lite and IP2Location LITE all work.
//
// NOTHING IS BUNDLED — every such database is a licensed download, so the
// feature is inert until an operator points GEOIP_DB_PATH or
// settings.stream.geoipDbPath at a file they fetched themselves.
//
// Fails open throughout: a missing, truncated or wrong-flavour database and an
// uncovered address all return undefined and none of them throw, because this
// runs on the listener's first page load.

import { readFileSync } from 'node:fs';
import { Reader } from 'mmdb-lib';
import type { CountryResponse, CityResponse } from 'mmdb-lib';
import { config } from '../config.js';
import * as settings from '../settings.js';

// Env wins, then the setting. Read per call, not captured, so an admin edit
// applies without a restart; the reader re-opens when the answer changes.
export function geoipDbPath(): string {
  if (config.geoip.dbPath) return config.geoip.dbPath;
  try {
    return String((settings.get() as any)?.stream?.geoipDbPath || '').trim();
  } catch {
    return '';
  }
}

// One opened reader, keyed by its path. A FAILED open caches `null` under the
// same key so a missing file isn't re-read and re-logged on every beacon.
let opened: { path: string; reader: Reader<CountryResponse | CityResponse> | null } | null = null;

function openReader(path: string): Reader<CountryResponse | CityResponse> | null {
  try {
    // Sync read, once per path per process — on the first beacon, not per
    // request. An async load would hand the first callers undefined anyway.
    return new Reader<CountryResponse | CityResponse>(readFileSync(path));
  } catch (err: any) {
    console.warn(`[geoip] cannot read ${path}: ${err?.message || err} — listener country falls back to headers only`);
    return null;
  }
}

// `::ffff:1.2.3.4` → `1.2.3.4`, `[::1]` → `::1`. A dual-stack listener reports
// IPv4 peers in the v4-mapped form, which the MMDB tree has no entry for. A
// `host:port` pair is deliberately NOT split — unbracketed IPv6 is all colons.
export function normalizeLookupIp(raw: unknown): string {
  let ip = String(raw ?? '').trim();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return mapped ? mapped[1] : ip;
}

// ISO alpha-2 for an IP, or undefined. Never throws. `registered_country` is
// the documented fallback for an address mapped to a registrant but no
// location. Returns the database's string verbatim — the country-code rule
// lives in listener-country.ts.
export function lookupCountry(rawIp: string): string | undefined {
  const path = geoipDbPath();
  if (!path) {
    opened = null; // a cleared setting must release the buffer, not keep serving it
    return undefined;
  }
  if (!opened || opened.path !== path) opened = { path, reader: openReader(path) };
  if (!opened.reader) return undefined;

  const ip = normalizeLookupIp(rawIp);
  if (!ip) return undefined;
  try {
    const res = opened.reader.get(ip);
    const code = res?.country?.iso_code || res?.registered_country?.iso_code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    // mmdb-lib throws on an unparseable address; that is a miss.
    return undefined;
  }
}

/** Test seam: drop the cached reader so the next lookup re-opens. */
export function resetGeoipCache(): void {
  opened = null;
}

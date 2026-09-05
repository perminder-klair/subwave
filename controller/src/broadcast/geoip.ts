// Offline GeoIP country lookup — the last link in the listener-country chain
// (broadcast/listener-country.ts), and the only one that needs a file on disk.
//
// WHY A DEPENDENCY AT ALL, AND WHY THIS ONE
// -----------------------------------------
// The header links cover every station that HAS a proxy setting a country
// header. They cover nothing for a station on a bare port, which is a real
// shape here (docker-compose.byo.yml binds host ports by design). Answering
// that needs an IP→country table, and the only sane way to carry one is to read
// a database the operator supplies rather than to call a web service on the
// listener's first page load.
//
// `mmdb-lib` is 92 KB with ZERO dependencies of its own and reads the MaxMind
// MMDB format that GeoLite2-Country, DB-IP Lite and IP2Location LITE all ship —
// so no download is coupled to one vendor. `maxmind` (the fuller wrapper) adds
// an LRU and a file watcher on top of the same reader; neither is worth a
// second dependency for one lookup on a first-load beacon.
//
// NOTHING IS BUNDLED. Every one of those databases is a licensed download with
// its own attribution terms, so the default is no database and no lookup: the
// feature is inert until an operator points GEOIP_DB_PATH or
// settings.stream.geoipDbPath at a file they fetched themselves.
//
// FAILING OPEN IS THE WHOLE POSTURE. A missing file, a truncated file, a City
// database where a Country one was expected, an address the tree doesn't cover
// — all of them return `undefined` and none of them throw. A beacon runs on the
// listener's first page load and analytics must never break a listener.

import { readFileSync } from 'node:fs';
import { Reader } from 'mmdb-lib';
import type { CountryResponse, CityResponse } from 'mmdb-lib';
import { config } from '../config.js';
import * as settings from '../settings.js';

/**
 * The database path in force: env first, then the setting.
 *
 * Same order as every other config value — env wins, the wizard/admin layer
 * fills the gap (see config.ts). Read per call rather than captured, so an
 * admin edit applies without a restart; the reader below re-opens when the
 * answer changes.
 */
export function geoipDbPath(): string {
  if (config.geoip.dbPath) return config.geoip.dbPath;
  try {
    return String((settings.get() as any)?.stream?.geoipDbPath || '').trim();
  } catch {
    return '';
  }
}

// One opened reader, keyed by the path it was opened from. A FAILED open caches
// `null` under the same key on purpose: without it a missing file would be
// re-read, re-parsed and re-logged on every single beacon.
let opened: { path: string; reader: Reader<CountryResponse | CityResponse> | null } | null = null;

function openReader(path: string): Reader<CountryResponse | CityResponse> | null {
  try {
    // Sync read, once per path per process. The file is a few MB and this runs
    // on the first beacon after boot, not per request; an async load would have
    // to hand the first callers `undefined` anyway, which is a worse answer
    // than one brief read.
    return new Reader<CountryResponse | CityResponse>(readFileSync(path));
  } catch (err: any) {
    console.warn(`[geoip] cannot read ${path}: ${err?.message || err} — listener country falls back to headers only`);
    return null;
  }
}

/**
 * `::ffff:1.2.3.4` → `1.2.3.4`, `[::1]` → `::1`.
 *
 * `req.socket.remoteAddress` reports IPv4 peers in the v4-mapped v6 form on a
 * dual-stack listener, and an MMDB tree has no entry for that spelling — the
 * lookup would miss on exactly the plain-reverse-proxy deployments this exists
 * for. A `host:port` pair is deliberately NOT split: an unbracketed IPv6
 * address is all colons, and guessing wrong there is worse than a miss.
 */
export function normalizeLookupIp(raw: unknown): string {
  let ip = String(raw ?? '').trim();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return mapped ? mapped[1] : ip;
}

/**
 * ISO alpha-2 for an IP, or `undefined`. Never throws.
 *
 * `registered_country` is the documented fallback for an address MaxMind maps
 * to a registrant but not to a location (satellite and anycast ranges, mostly).
 * Callers normalise the result themselves — this returns the database's string
 * verbatim so the one country-code rule stays in listener-country.ts.
 */
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
    // mmdb-lib throws on an address it cannot parse; that is a miss.
    return undefined;
  }
}

/** Test seam: drop the cached reader so the next lookup re-opens. */
export function resetGeoipCache(): void {
  opened = null;
}

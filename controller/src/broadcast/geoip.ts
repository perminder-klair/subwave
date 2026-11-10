// Use an operator-supplied MMDB file; no licensed database is bundled. Missing, invalid, or
// uncovered data returns undefined without throwing on the listener's first load.

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
// same key so a missing file isn't re-read on every beacon, but only for
// FAILED_OPEN_RETRY_MS: a failure used to stick until the controller restarted,
// so fixing the file's permissions changed nothing until then.
export const FAILED_OPEN_RETRY_MS = 60_000;

let opened: {
  path: string;
  reader: Reader<CountryResponse | CityResponse> | null;
  /** Why the open failed, for the admin Listeners card. */
  error?: string;
  at: number;
} | null = null;

function openReader(path: string): { reader: Reader<CountryResponse | CityResponse> | null; error?: string } {
  try {
    // Sync read, once per path per process — on the first beacon, not per
    // request. An async load would hand the first callers undefined anyway.
    return { reader: new Reader<CountryResponse | CityResponse>(readFileSync(path)) };
  } catch (err: any) {
    return { reader: null, error: String(err?.code || err?.message || err) };
  }
}

// The reader for the configured path, opening (or re-trying a failed open) as
// needed. Logs only when the outcome changes, so a retry every minute on a
// broken file does not fill the log.
function currentReader(path: string, now = Date.now()): Reader<CountryResponse | CityResponse> | null {
  const stale = !opened || opened.path !== path
    || (!opened.reader && now - opened.at >= FAILED_OPEN_RETRY_MS);
  if (stale) {
    const prev = opened;
    const next = { path, ...openReader(path), at: now };
    if (!next.reader && (prev?.path !== path || prev?.error !== next.error)) {
      console.warn(`[geoip] cannot read ${path}: ${next.error} — listener country falls back to headers only`);
    } else if (next.reader && prev?.path === path && !prev.reader) {
      console.log(`[geoip] opened ${path}`);
    }
    opened = next;
  }
  return opened!.reader;
}

export interface GeoipStatus {
  /** Where the path came from; `none` = no database configured. */
  source: 'env' | 'setting' | 'none';
  path: string;
  ok: boolean;
  /** Short reason when `ok` is false and a path is set (e.g. ENOENT, EACCES). */
  error?: string;
}

// For the admin Listeners card, so a blank Country column explains itself.
// Opens the database if nothing has yet, exactly as a lookup would.
export function geoipStatus(now = Date.now()): GeoipStatus {
  const path = geoipDbPath();
  if (!path) {
    opened = null;
    return { source: 'none', path: '', ok: false };
  }
  const source = config.geoip.dbPath ? 'env' : 'setting';
  const reader = currentReader(path, now);
  return reader ? { source, path, ok: true } : { source, path, ok: false, error: opened?.error };
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
  const reader = currentReader(path);
  if (!reader) return undefined;

  const ip = normalizeLookupIp(rawIp);
  if (!ip) return undefined;
  try {
    const res = reader.get(ip);
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

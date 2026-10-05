// The country attached to a /beacon (#1485), resolved as a chain in descending
// order of trust: `cf-ipcountry`, then the header named by
// `settings.stream.countryHeader`, then an offline MMDB lookup over the IP.
//
// EVERY step FAILS OPEN: a malformed header, an unreadable database or a step
// that throws is a MISS that falls through, and an exhausted chain returns
// undefined, which record() doesn't count. This runs inside the listener's
// first-load beacon, so it must never throw.
//
// Pure, taking its GeoIP step as an argument so the ordering is testable
// without a database on disk.

import { STREAM_COUNTRY_HEADER_RE } from '../schemas/settings.js';

// ISO 3166-1 alpha-2 is two letters. Anything else is a miss, not a bucket.
const COUNTRY_CODE_RE = /^[A-Z]{2}$/;

// Cloudflare's "we don't know". Treating them as a MISS is what lets a later
// link answer instead of the chain stopping here.
const UNKNOWN_CODES = new Set(['XX', 'T1']);

// Trim + upper-case only. No slicing: a 4-character value is junk, not a code
// with two spare characters.
export function normalizeCountryCode(raw: unknown): string | undefined {
  const v = String(raw ?? '').trim().toUpperCase();
  if (!COUNTRY_CODE_RE.test(v)) return undefined;
  if (UNKNOWN_CODES.has(v)) return undefined;
  return v;
}

// Lower-cased for the lookup (Node lower-cases incoming header keys). The
// grammar is the SAME constant the save path validates against, imported rather
// than restated. Re-checked here because settings.json is hand-editable and an
// arbitrary string indexing req.headers could name a non-header.
export function normalizeHeaderName(raw: unknown): string | undefined {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!STREAM_COUNTRY_HEADER_RE.test(v)) return undefined;
  return v;
}

// A repeated header arrives as an array; the FIRST entry is the closest proxy's
// and the one to trust. `Object.hasOwn` so an inherited property is never
// mistaken for a header.
function headerValue(headers: Record<string, unknown> | undefined, name: string): unknown {
  if (!headers || !Object.hasOwn(headers, name)) return undefined;
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export interface CountryResolveInput {
  /** Express `req.headers` (keys already lower-cased by Node). */
  headers?: Record<string, unknown>;
  /** The same client IP the beacon records under — may be absent. */
  ip?: string;
  /** `settings.stream.countryHeader`; empty/malformed disables step 2. */
  countryHeader?: string;
  /** Step 3, injected so the chain stays pure. May return anything, may throw. */
  geoipLookup?: (ip: string) => unknown;
}

/** Returns an ISO alpha-2 code or `undefined`; never throws. */
export function resolveListenerCountry(input: CountryResolveInput): string | undefined {
  const headers = input.headers;

  // 1. Cloudflare.
  const cf = normalizeCountryCode(headerValue(headers, 'cf-ipcountry'));
  if (cf) return cf;

  // 2. The operator's own proxy.
  const custom = normalizeHeaderName(input.countryHeader);
  if (custom) {
    const fromHeader = normalizeCountryCode(headerValue(headers, custom));
    if (fromHeader) return fromHeader;
  }

  // 3. The offline database, only reached when both headers came up empty.
  const ip = String(input.ip ?? '').trim();
  if (ip && input.geoipLookup) {
    try {
      const fromDb = normalizeCountryCode(input.geoipLookup(ip));
      if (fromDb) return fromDb;
    } catch {
      /* an unreadable database is a miss, never a failed beacon */
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// The country beside an Icecast connection (admin Dash → Listeners)
// ---------------------------------------------------------------------------
//
// Icecast knows only the IP, so the header links above cannot run. Two sources
// remain, in the SAME order of trust as the chain:
//
//  1. `beacon` — what that IP's own POST /beacon resolved through the full chain
//     (Cloudflare, the operator's header, then the database). Remembered in
//     memory by broadcast/beacon-countries.ts. Covers web-player listeners.
//  2. `geoip` — the offline database over the Icecast IP. The only source for
//     VLC, Sonos and hardware radios, which never load the page.
//
// Same failure posture: every link is a miss, never an error, and an exhausted
// chain returns no country rather than a guess.

export type ConnectionCountrySource = 'beacon' | 'geoip';

export interface ConnectionCountry {
  country: string;
  source: ConnectionCountrySource;
}

export interface ConnectionCountryInput {
  ip?: string;
  /** Injected so the order stays testable without the process-wide cache. */
  beaconLookup?: (ip: string) => unknown;
  geoipLookup?: (ip: string) => unknown;
}

export function resolveConnectionCountry(input: ConnectionCountryInput): ConnectionCountry | undefined {
  const ip = String(input.ip ?? '').trim();
  if (!ip) return undefined;
  const links: [ConnectionCountrySource, ((ip: string) => unknown) | undefined][] = [
    ['beacon', input.beaconLookup],
    ['geoip', input.geoipLookup],
  ];
  for (const [source, lookup] of links) {
    if (!lookup) continue;
    try {
      const country = normalizeCountryCode(lookup(ip));
      if (country) return { country, source };
    } catch {
      /* a failing link is a miss */
    }
  }
  return undefined;
}

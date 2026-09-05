// Where a listener is, as far as the audience rollup is concerned — the single
// policy module for the country attached to a /beacon.
//
// Until #1485 this was one inline header read (`cf-ipcountry`), so every station
// NOT behind Cloudflare — a plain nginx/Traefik/Caddy in front, or no proxy at
// all — got an empty country column on the Stats page with nothing to configure.
// The answer is a CHAIN, tried in descending order of trust:
//
//   1. `cf-ipcountry`          Cloudflare's own header. Free and correct where
//                              it exists; still the default because the shipped
//                              prod topology terminates TLS at Cloudflare.
//   2. a named header          `settings.stream.countryHeader` — whatever the
//                              operator's own proxy sets (`X-Country-Code`,
//                              `X-GeoIP-Country`, …). Empty by default, so an
//                              upgrade reads exactly one header, as before.
//   3. an offline MMDB lookup  broadcast/geoip.ts, over the beacon's IP. Opt-in
//                              behind an operator-supplied database path.
//
// EVERY step FAILS OPEN. A malformed header, an unreadable database, a private
// or unroutable IP, a step that throws — each is a MISS that falls through to
// the next link, and an exhausted chain returns `undefined`, which record()
// simply doesn't count. A blank country column is the designed outcome of not
// knowing; an error reaching the beacon handler is not, because that handler is
// on the listener's first page load.
//
// The chain is deliberately pure and takes its GeoIP step as an argument, so the
// ordering is testable without a database on disk (scripts/listener-country.test.ts).

import { STREAM_COUNTRY_HEADER_RE } from '../schemas/settings.js';

// ISO 3166-1 alpha-2 is two letters, always. Anything else — a country NAME
// from a chatty proxy, a truncated value, a numeric code — is a miss rather
// than a bucket in the rollup, since a key nobody can read is worse than blank.
const COUNTRY_CODE_RE = /^[A-Z]{2}$/;

// Cloudflare's own "we don't know": `XX` for an unresolvable address (and on
// some plans for Tor exits), `T1` for a Tor exit node. Both are already dropped
// downstream by audience.record(); treating them as a MISS here is what lets a
// configured header or the MMDB answer instead of the chain stopping on them.
const UNKNOWN_CODES = new Set(['XX', 'T1']);

/**
 * Normalise one candidate into an ISO alpha-2 code, or `undefined`.
 *
 * Trim + upper-case only. No slicing: a 4-character value is junk, not a code
 * with two spare characters, and `record()`'s old `.slice(0, 4)` would have
 * filed it under a key the Stats page renders as gibberish.
 */
export function normalizeCountryCode(raw: unknown): string | undefined {
  const v = String(raw ?? '').trim().toUpperCase();
  if (!COUNTRY_CODE_RE.test(v)) return undefined;
  if (UNKNOWN_CODES.has(v)) return undefined;
  return v;
}

/**
 * A header name the operator typed, lower-cased for the lookup (Node lower-cases
 * incoming header keys).
 *
 * The grammar is the SAME constant the save path validates against — imported
 * from schemas/settings.ts rather than restated, because a read path that
 * disagreed with the save path would accept a stored value it then refuses to
 * use, or worse. Re-checked here anyway: `settings.json` is hand-editable, so a
 * value reaching this function has not necessarily been through the schema, and
 * an arbitrary string indexing `req.headers` could name something that isn't a
 * header at all (`constructor`, say).
 */
export function normalizeHeaderName(raw: unknown): string | undefined {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!STREAM_COUNTRY_HEADER_RE.test(v)) return undefined;
  return v;
}

/**
 * Read one header off an Express-shaped headers bag.
 *
 * Node hands back `string | string[]` — a repeated header arrives as an array,
 * and the FIRST entry is the one the closest proxy set, which is the one to
 * trust. `Object.hasOwn` rather than a bare index so an inherited property can
 * never be mistaken for a header.
 */
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
  /**
   * Step 3. Injected so the chain stays pure; `broadcast/geoip.ts` supplies the
   * real one. It may return anything — the result goes through the same
   * normaliser as the headers — and it must not be relied upon not to throw.
   */
  geoipLookup?: (ip: string) => unknown;
}

/**
 * The chain. Returns an ISO alpha-2 code or `undefined`; never throws.
 */
export function resolveListenerCountry(input: CountryResolveInput): string | undefined {
  const headers = input.headers;

  // 1. Cloudflare.
  const cf = normalizeCountryCode(headerValue(headers, 'cf-ipcountry'));
  if (cf) return cf;

  // 2. The operator's own proxy. `cf-ipcountry` is not special-cased away here:
  // naming it is a no-op that costs one already-failed read, not a bug worth a
  // branch.
  const custom = normalizeHeaderName(input.countryHeader);
  if (custom) {
    const fromHeader = normalizeCountryCode(headerValue(headers, custom));
    if (fromHeader) return fromHeader;
  }

  // 3. The offline database. Only reached when both headers came up empty, so
  // an operator behind Cloudflare pays nothing for having configured it.
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

// The listener-country fallback chain (#1485, FR 15).
//
// Before this, routes/audience.ts read `cf-ipcountry` and nothing else, so every
// station behind a plain reverse proxy got a blank country column on the Stats
// page. `broadcast/listener-country.ts` replaces that one read with an ordered
// chain, and four properties of it are load-bearing:
//
//  - ORDER. Cloudflare's header outranks the operator's, which outranks the
//    offline database. Getting this backwards means a station behind Cloudflare
//    starts answering from a stale MMDB it configured for a different edge.
//  - EVERY LINK FAILS OPEN. This runs inside POST /beacon, on a listener's first
//    page load. A junk header, a header name that isn't one, a database that
//    throws — each must be a MISS that falls through, and an exhausted chain
//    must return `undefined` so nothing is counted. Never an error.
//  - A LATER LINK RUNS WHEN AN EARLIER ONE MISSES, not only when it is absent.
//    `XX` (Cloudflare's own "unknown") and `T1` (Tor) are the cases that matter:
//    stopping the chain on them is how a configured fallback never gets asked on
//    exactly the requests it exists for.
//  - THE GRAMMARS ARE SHARED. The header name the schema accepts on save is the
//    one the read path will use; two copies would drift into a stored value the
//    resolver refuses to act on, which presents as "I set it and nothing
//    happened".
//
// Also pins the cold-load round trip for the two new settings keys, which is the
// failure `controller/CLAUDE.md` documents twice: a field composed on the save
// path but missing from load()'s stream block works for one process and then
// vanishes on restart, with nothing in the logs.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// STATE_DIR is redirected before the first config-derived import, so
// settings.load()/update() touch nothing real.
const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-listener-country-'));
process.env.STATE_DIR = stateRoot;

const {
  resolveListenerCountry,
  normalizeCountryCode,
  normalizeHeaderName,
} = await import('../src/broadcast/listener-country.js');
const { STREAM_COUNTRY_HEADER_RE, streamPatchSchema } =
  await import('../src/schemas/settings.js');
const { normalizeLookupIp, lookupCountry, resetGeoipCache, geoipDbPath } =
  await import('../src/broadcast/geoip.js');
const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');

const SETTINGS_PATH = path.join(stateRoot, 'settings.json');

// ---------------------------------------------------------------------------
// The chain, in order
// ---------------------------------------------------------------------------

test('cf-ipcountry wins over every later link', () => {
  const seen: string[] = [];
  const country = resolveListenerCountry({
    headers: { 'cf-ipcountry': 'GB', 'x-country-code': 'FR' },
    ip: '1.2.3.4',
    countryHeader: 'x-country-code',
    geoipLookup: (ip) => { seen.push(ip); return 'DE'; },
  });
  assert.equal(country, 'GB');
  // Not merely the right answer — the later links must not have been consulted
  // at all, since the GeoIP one reads a file.
  assert.deepEqual(seen, [], 'the database is never opened once a header answered');
});

test('the configured header answers when cf-ipcountry is absent', () => {
  const country = resolveListenerCountry({
    headers: { 'x-country-code': 'fr' },
    ip: '1.2.3.4',
    countryHeader: 'X-Country-Code',
    geoipLookup: () => 'DE',
  });
  // Case-folded on both sides: the operator types the header as their proxy
  // documents it, Node lower-cases the key, and the code comes back upper.
  assert.equal(country, 'FR');
});

test('GeoIP answers only when both headers came up empty', () => {
  const country = resolveListenerCountry({
    headers: {},
    ip: '1.2.3.4',
    countryHeader: 'x-country-code',
    geoipLookup: () => 'de',
  });
  assert.equal(country, 'DE');
});

test('an unconfigured station reads exactly one header, as before', () => {
  assert.equal(
    resolveListenerCountry({ headers: { 'cf-ipcountry': 'IE' }, ip: '1.2.3.4' }),
    'IE',
  );
  // No countryHeader, no geoipLookup — the pre-#1485 behaviour byte for byte.
  assert.equal(
    resolveListenerCountry({ headers: { 'x-country-code': 'IE' }, ip: '1.2.3.4' }),
    undefined,
    'a header nobody named is not read',
  );
});

// ---------------------------------------------------------------------------
// Failing open
// ---------------------------------------------------------------------------

test('an exhausted chain is blank, never an error', () => {
  assert.equal(resolveListenerCountry({}), undefined);
  assert.equal(resolveListenerCountry({ headers: {}, ip: '' }), undefined);
  assert.equal(
    resolveListenerCountry({ headers: { 'cf-ipcountry': '' }, ip: '1.2.3.4' }),
    undefined,
  );
});

test('a throwing GeoIP lookup is a miss, not a failed beacon', () => {
  assert.equal(
    resolveListenerCountry({
      headers: {},
      ip: '1.2.3.4',
      geoipLookup: () => { throw new Error('database corrupt'); },
    }),
    undefined,
  );
});

test('XX and T1 fall THROUGH rather than stopping the chain', () => {
  for (const unknown of ['XX', 'T1', 'xx']) {
    assert.equal(
      resolveListenerCountry({
        headers: { 'cf-ipcountry': unknown, 'x-country-code': 'NL' },
        countryHeader: 'x-country-code',
      }),
      'NL',
      `${unknown} is Cloudflare saying it does not know, so the next link is asked`,
    );
    // …and with nothing behind it, an unknown stays blank.
    assert.equal(
      resolveListenerCountry({ headers: { 'cf-ipcountry': unknown } }),
      undefined,
    );
  }
});

test('junk header values never reach the rollup', () => {
  // The old read sliced to 4 characters, which filed a country NAME under a key
  // the Stats page renders as gibberish.
  for (const junk of ['United Kingdom', 'GBR', 'G', '826', '  ', 'g8', '<b>']) {
    assert.equal(
      resolveListenerCountry({ headers: { 'cf-ipcountry': junk } }),
      undefined,
      `${JSON.stringify(junk)} is not an ISO alpha-2 code`,
    );
  }
});

test('a header name that is not one disables only its own link', () => {
  for (const bad of ['', '   ', 'x country', 'x-country:', 'a'.repeat(65), 'x/country', 'x"c']) {
    assert.equal(normalizeHeaderName(bad), undefined, `${JSON.stringify(bad)} rejected`);
    // The chain keeps going: GeoIP still answers.
    assert.equal(
      resolveListenerCountry({
        headers: { 'x-country-code': 'FR' },
        ip: '1.2.3.4',
        countryHeader: bad,
        geoipLookup: () => 'DE',
      }),
      'DE',
    );
  }
});

test('a header name naming a prototype property reads no header', () => {
  // `constructor` and `__proto__` are legal RFC 7230 tokens, so the grammar
  // accepts them — the guard that matters is Object.hasOwn, which must find
  // nothing rather than stringifying Object's own property.
  for (const name of ['constructor', '__proto__', 'toString']) {
    assert.equal(normalizeHeaderName(name), name.toLowerCase());
    assert.equal(
      resolveListenerCountry({ headers: {}, countryHeader: name }),
      undefined,
      `${name} is not a header on an empty bag`,
    );
  }
});

test('a repeated header takes the first value', () => {
  // Node hands a repeated header back as an array; the first entry is the one
  // the closest proxy set.
  assert.equal(
    resolveListenerCountry({ headers: { 'cf-ipcountry': ['SE', 'NO'] } }),
    'SE',
  );
  assert.equal(resolveListenerCountry({ headers: { 'cf-ipcountry': [] } }), undefined);
});

test('a GeoIP result is normalised like any other candidate', () => {
  const base = { headers: {}, ip: '1.2.3.4' };
  assert.equal(resolveListenerCountry({ ...base, geoipLookup: () => null }), undefined);
  assert.equal(resolveListenerCountry({ ...base, geoipLookup: () => 'Germany' }), undefined);
  assert.equal(resolveListenerCountry({ ...base, geoipLookup: () => ' de ' }), 'DE');
});

test('no IP means no database read', () => {
  let called = false;
  assert.equal(
    resolveListenerCountry({ headers: {}, ip: '', geoipLookup: () => { called = true; return 'DE'; } }),
    undefined,
  );
  assert.equal(called, false);
});

test('normalizeCountryCode is the one country rule', () => {
  assert.equal(normalizeCountryCode(' gb '), 'GB');
  assert.equal(normalizeCountryCode(undefined), undefined);
  assert.equal(normalizeCountryCode(null), undefined);
  assert.equal(normalizeCountryCode(42), undefined);
});

// ---------------------------------------------------------------------------
// The GeoIP reader itself — inert by default, and never throws
// ---------------------------------------------------------------------------

test('v4-mapped and bracketed addresses are unwrapped before lookup', () => {
  // A dual-stack listener reports IPv4 peers as ::ffff:a.b.c.d, a spelling no
  // MMDB tree carries — the miss would land on exactly the bare-port stations
  // the database is for.
  assert.equal(normalizeLookupIp('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(normalizeLookupIp('[2001:db8::1]'), '2001:db8::1');
  assert.equal(normalizeLookupIp(' 203.0.113.9 '), '203.0.113.9');
  // An unbracketed IPv6 address is all colons — never split on the last one.
  assert.equal(normalizeLookupIp('2001:db8::1'), '2001:db8::1');
  assert.equal(normalizeLookupIp(undefined), '');
});

test('an unset or unreadable database is a miss, never a throw', async () => {
  await settings.load();
  resetGeoipCache();
  assert.equal(geoipDbPath(), '', 'nothing is bundled — the default is no database');
  assert.equal(lookupCountry('203.0.113.9'), undefined);

  await settings.update({ stream: { geoipDbPath: path.join(stateRoot, 'nope.mmdb') } });
  resetGeoipCache();
  assert.equal(lookupCountry('203.0.113.9'), undefined, 'a missing file fails open');

  // A file that exists but is not an MMDB — the Reader throws on the metadata
  // scan, and that must be caught once and cached, not re-thrown per beacon.
  const bogus = path.join(stateRoot, 'bogus.mmdb');
  writeFileSync(bogus, 'this is not a maxmind database');
  await settings.update({ stream: { geoipDbPath: bogus } });
  resetGeoipCache();
  assert.equal(lookupCountry('203.0.113.9'), undefined, 'a malformed file fails open');
  assert.equal(lookupCountry('not-an-ip'), undefined);

  await settings.update({ stream: { geoipDbPath: '' } });
  resetGeoipCache();
});

// ---------------------------------------------------------------------------
// Settings: one grammar, and a cold-load round trip
// ---------------------------------------------------------------------------

test('the save path and the read path share one header grammar', () => {
  for (const good of ['x-country-code', 'X-GeoIP-Country', 'CF-IPCountry', 'country']) {
    assert.ok(STREAM_COUNTRY_HEADER_RE.test(good), `${good} is a header name`);
    assert.equal(
      streamPatchSchema.safeParse({ countryHeader: good }).success,
      true,
      `${good} saves`,
    );
    assert.equal(normalizeHeaderName(good), good.toLowerCase(), `${good} is then used`);
  }
});

test('a malformed header name is REFUSED on save, not silently repaired', () => {
  // Typed by hand into a field whose only feedback is the Stats page staying
  // blank a day later, so a silent drop is the operator watching their own
  // input disappear.
  const bad = streamPatchSchema.safeParse({ countryHeader: 'X-Country: GB' });
  assert.equal(bad.success, false);
  assert.match(String(bad.error?.issues?.[0]?.message), /stream\.countryHeader/);

  // Empty stays legal — it is the default and it means "read one header".
  const cleared = streamPatchSchema.safeParse({ countryHeader: '  ' });
  assert.equal(cleared.success, true);
  assert.equal(cleared.data?.countryHeader, '');
});

test('an over-long database path is refused', () => {
  const long = streamPatchSchema.safeParse({ geoipDbPath: `/${'a'.repeat(512)}` });
  assert.equal(long.success, false);
  assert.match(String(long.error?.issues?.[0]?.message), /stream\.geoipDbPath/);
  assert.equal(
    streamPatchSchema.safeParse({ geoipDbPath: ' /var/sub-wave/geoip.mmdb ' }).data?.geoipDbPath,
    '/var/sub-wave/geoip.mmdb',
    'trimmed, not rejected',
  );
});

test('both keys survive a controller restart', async () => {
  await settings.load();
  await settings.update({
    stream: { countryHeader: 'X-Country-Code', geoipDbPath: '/var/sub-wave/geoip.mmdb' },
  });
  // A cold load is the assertion that matters: a field missing from load()'s
  // stream block still validates, still saves and still works for the rest of
  // the process, then silently reverts on the next boot.
  setCache(null);
  await settings.load();
  assert.equal(settings.get().stream.countryHeader, 'X-Country-Code');
  assert.equal(settings.get().stream.geoipDbPath, '/var/sub-wave/geoip.mmdb');
});

test('an absent or hand-mangled block coerces to the pre-existing behaviour', async () => {
  writeFileSync(SETTINGS_PATH, JSON.stringify({ stream: { bitrate: 192 } }));
  setCache(null);
  await settings.load();
  assert.equal(settings.get().stream.countryHeader, '', 'an upgrade reads one header');
  assert.equal(settings.get().stream.geoipDbPath, '');

  // A hand-edited settings.json is repaired, never fatal — a bad header name
  // costs the header link, not the boot.
  writeFileSync(SETTINGS_PATH, JSON.stringify({
    stream: { countryHeader: 'X-Country: GB', geoipDbPath: 42 },
  }));
  setCache(null);
  await settings.load();
  assert.equal(settings.get().stream.countryHeader, '');
  assert.equal(settings.get().stream.geoipDbPath, '');
});

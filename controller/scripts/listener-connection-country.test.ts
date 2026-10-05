// The Country column on admin Dash → Listeners.
//
// Icecast's listclients gives an IP and nothing else, so a row's country comes
// from two places: what that IP's own POST /beacon resolved (the full #1485
// chain, Cloudflare header first), then the offline GeoIP database for clients
// that never load the page (VLC, Sonos, hardware). Pinned here:
//
//  - ORDER. The beacon outranks the database, matching the beacon chain itself,
//    where the edge's header outranks a possibly stale MMDB.
//  - FAIL OPEN. A throwing or junk link is a miss; an exhausted chain names no
//    country. This decorates an admin table and must never fail the route.
//  - THE CACHE IS BOUNDED. It is fed by a public endpoint, so it ages entries out
//    and caps its size, evicting the least recently beaconed IP first.
//  - IP SPELLINGS MATCH. A dual-stack socket reports `::ffff:1.2.3.4`; the beacon
//    and the Icecast row must key the same listener to the same entry.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.STATE_DIR = mkdtempSync(path.join(tmpdir(), 'subwave-conn-country-'));

const { resolveConnectionCountry } = await import('../src/broadcast/listener-country.js');
const {
  rememberBeaconCountry,
  beaconCountryFor,
  resetBeaconCountries,
  beaconCountryCount,
  BEACON_COUNTRY_TTL_MS,
  BEACON_COUNTRY_MAX,
} = await import('../src/broadcast/beacon-countries.js');

test('the beacon outranks the GeoIP database', () => {
  const r = resolveConnectionCountry({
    ip: '203.0.113.7',
    beaconLookup: () => 'GR',
    geoipLookup: () => 'FR',
  });
  assert.deepEqual(r, { country: 'GR', source: 'beacon' });
});

test('the database answers when no beacon is known', () => {
  const r = resolveConnectionCountry({
    ip: '203.0.113.7',
    beaconLookup: () => undefined,
    geoipLookup: () => 'fr',
  });
  assert.deepEqual(r, { country: 'FR', source: 'geoip' });
});

test('a throwing or junk link is a miss, and an exhausted chain names nothing', () => {
  assert.deepEqual(
    resolveConnectionCountry({
      ip: '203.0.113.7',
      beaconLookup: () => { throw new Error('boom'); },
      geoipLookup: () => 'DE',
    }),
    { country: 'DE', source: 'geoip' },
  );
  assert.equal(
    resolveConnectionCountry({ ip: '203.0.113.7', beaconLookup: () => 'XX', geoipLookup: () => 'Germany' }),
    undefined,
  );
  assert.equal(resolveConnectionCountry({ ip: '', geoipLookup: () => 'DE' }), undefined);
  assert.equal(resolveConnectionCountry({ ip: '203.0.113.7' }), undefined);
});

test('a remembered beacon is found under the v4-mapped spelling of the same IP', () => {
  resetBeaconCountries();
  rememberBeaconCountry('::ffff:198.51.100.4', 'GR');
  assert.equal(beaconCountryFor('198.51.100.4'), 'GR');
  rememberBeaconCountry('198.51.100.5', 'IT');
  assert.equal(beaconCountryFor('::ffff:198.51.100.5'), 'IT');
});

test('nothing is remembered without both an IP and a country', () => {
  resetBeaconCountries();
  rememberBeaconCountry('', 'GR');
  rememberBeaconCountry('198.51.100.4', undefined);
  assert.equal(beaconCountryCount(), 0);
});

test('entries age out after the TTL', () => {
  resetBeaconCountries();
  const t0 = 1_000_000;
  rememberBeaconCountry('198.51.100.4', 'GR', t0);
  assert.equal(beaconCountryFor('198.51.100.4', t0 + BEACON_COUNTRY_TTL_MS), 'GR');
  assert.equal(beaconCountryFor('198.51.100.4', t0 + BEACON_COUNTRY_TTL_MS + 1), undefined);
  assert.equal(beaconCountryCount(), 0);
});

test('the cache is capped and evicts the least recently beaconed IP', () => {
  resetBeaconCountries();
  for (let i = 0; i < BEACON_COUNTRY_MAX; i++) rememberBeaconCountry(`10.0.${i >> 8}.${i & 255}`, 'GR', i);
  // Re-beaconing the oldest makes it the newest, so the SECOND one is evicted.
  rememberBeaconCountry('10.0.0.0', 'FR', BEACON_COUNTRY_MAX);
  rememberBeaconCountry('192.0.2.1', 'IT', BEACON_COUNTRY_MAX + 1);
  assert.equal(beaconCountryCount(), BEACON_COUNTRY_MAX);
  assert.equal(beaconCountryFor('10.0.0.0', BEACON_COUNTRY_MAX + 2), 'FR');
  assert.equal(beaconCountryFor('10.0.0.1', BEACON_COUNTRY_MAX + 2), undefined);
  assert.equal(beaconCountryFor('192.0.2.1', BEACON_COUNTRY_MAX + 2), 'IT');
});

// ---------------------------------------------------------------------------
// GeoIP status for the Listeners card, and retrying a failed open
// ---------------------------------------------------------------------------

const { geoipStatus, lookupCountry, resetGeoipCache, FAILED_OPEN_RETRY_MS } =
  await import('../src/broadcast/geoip.js');
const settings = await import('../src/settings.js');
const { writeFileSync } = await import('node:fs');

test('no path configured reports source none', async () => {
  await settings.update({ stream: { geoipDbPath: '' } });
  resetGeoipCache();
  assert.deepEqual(geoipStatus(), { source: 'none', path: '', ok: false });
});

test('an unreadable path reports the reason, and is retried after the window', async () => {
  const p = path.join(process.env.STATE_DIR!, 'geo', 'country.mmdb');
  await settings.update({ stream: { geoipDbPath: p } });
  resetGeoipCache();
  const t0 = 5_000_000;
  const missing = geoipStatus(t0);
  assert.equal(missing.source, 'setting');
  assert.equal(missing.path, p);
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'ENOENT');

  // The file appears (here: junk, so the open still fails, with a new reason).
  const { mkdirSync } = await import('node:fs');
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, 'not a database');
  assert.equal(geoipStatus(t0 + 1000).error, 'ENOENT', 'a failure is cached inside the window');
  const retried = geoipStatus(t0 + FAILED_OPEN_RETRY_MS);
  assert.equal(retried.ok, false);
  assert.notEqual(retried.error, 'ENOENT', 'after the window the file is opened again');
  assert.equal(lookupCountry('203.0.113.9'), undefined, 'and a lookup still fails open');

  await settings.update({ stream: { geoipDbPath: '' } });
  resetGeoipCache();
});

// Unit pins for the pure multi-station helpers (spec:
// docs/superpowers/specs/2026-07-24-multi-station-profiles-design.md §2/§5/§6).
// Run: npx tsx scripts/stations-pure.test.ts — node:assert-via-tsx style of
// scripts/llm-pure.test.ts; auto-discovered by npm test.

import assert from 'node:assert/strict';
import {
  MAX_STATIONS,
  STATION_ID_RE,
  parseActivePointer,
  slugifyStationName,
  duplicateAction,
  conversionAction,
} from '../src/stations/pure.js';

// The per-install station ceiling — the manager, the route's `limit` field,
// and the admin UI all key off this one constant.
assert.equal(MAX_STATIONS, 8);

// --- station id validation -------------------------------------------------
assert.ok(STATION_ID_RE.test('main'));
assert.ok(STATION_ID_RE.test('late-night-2'));
assert.ok(STATION_ID_RE.test('a'));
assert.ok(!STATION_ID_RE.test(''));
assert.ok(!STATION_ID_RE.test('Main'));
assert.ok(!STATION_ID_RE.test('-lead'));
assert.ok(!STATION_ID_RE.test('../evil'));
assert.ok(!STATION_ID_RE.test('a/b'));
assert.ok(!STATION_ID_RE.test('a'.repeat(42))); // 41 chars max

// --- active.json parsing ---------------------------------------------------
assert.equal(parseActivePointer('{"activeId":"main"}'), 'main');
assert.equal(parseActivePointer(' {"activeId": "late-night-2"} '), 'late-night-2');
assert.equal(parseActivePointer('{"activeId":"../evil"}'), null);
assert.equal(parseActivePointer('{"activeId":42}'), null);
assert.equal(parseActivePointer('{}'), null);
assert.equal(parseActivePointer('not json'), null);
assert.equal(parseActivePointer(''), null);

// --- slugify ----------------------------------------------------------------
assert.equal(slugifyStationName('Late Night FM'), 'late-night-fm');
assert.equal(slugifyStationName('SUB/WAVE'), 'sub-wave');
assert.equal(slugifyStationName('  ***  '), 'station'); // nothing usable → fallback
assert.equal(slugifyStationName('a'.repeat(60)), 'a'.repeat(41)); // capped to the RE max
assert.ok(STATION_ID_RE.test(slugifyStationName('Ünïcode Béats!!')));

// --- duplicate allowlist (spec §5) ------------------------------------------
// copy: station identity + derived config
for (const f of [
  'settings.json', 'setup-config.json', 'secrets.env', 'moods.json',
  'schedule.json', 'jingles.m3u', 'jingles.json', 'beds.json', 'bed.mp3',
  'voices', 'persona-avatars', 'jingles', 'beds', 'skills', 'sfx',
  'liquidsoap_crossfade.txt', 'liquidsoap_station_name.txt',
  'icecast_listener_auth.txt', 'themes', 'sfx.json', 'playlist-recipes.json',
]) assert.equal(duplicateAction(f), 'copy', f);
// library.db goes through better-sqlite3 .backup(), not a file copy
assert.equal(duplicateAction('library.db'), 'backup');
// skip: runtime + listener history + everything unknown (allowlist default)
for (const f of [
  'session.json', 'sessions', 'logs', 'archive', 'queue.json',
  'recent-plays.json', 'now-playing.json', 'jingle-playing.json',
  'bed-playing.json', 'listeners.jsonl', 'audience.json', 'likes.json',
  'seen-curiosity.json', 'next.txt', 'say.txt', 'intro.txt', 'sfx.txt',
  'auto.m3u', 'library.db-wal', 'library.db-shm', 'station.json',
  'settings.json.bak-pre-ollama', 'some-future-file.xyz',
]) assert.equal(duplicateAction(f), 'skip', f);

// --- conversion classification (spec §6) --------------------------------------
for (const f of ['stations', 'icecast-secrets.env', 'hf-cache', 'analyze-tmp', 'lost+found'])
  assert.equal(conversionAction(f), 'keep', f);
for (const f of ['settings.json', 'library.db', 'jingles', 'logs', 'archive', 'session.json'])
  assert.equal(conversionAction(f), 'move', f);

console.log('stations-pure.test: OK');

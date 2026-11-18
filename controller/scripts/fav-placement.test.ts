// Pins WHERE listener favourites (#991) render in the DJ agent's prompts.
//
// The invariant (established alongside the prompt-cache work): favourites ride
// the pick EVENT turn via likes.favouritesClause(), and pickSystem() renders
// NONE of them — the system+tools prefix must stay byte-stable across picks so
// automatic prompt caching (DeepSeek/OpenAI/OpenRouter) can key on it. A
// future edit that moves the list "back where it was" (into the system prompt)
// silently defeats the cache on every pick; this test is what fails instead.
//
// Three properties pinned:
//  - favouritesClause renders the list when the operator opted in, and returns
//    '' (never undefined/garbage) when likes are off, influenceDj is off, or
//    nothing is liked — so a likes-free station's event turn is byte-identical.
//  - pickSystem() contains no favourites, even with likes enabled AND records
//    present in the store.
//  - runTrackEvent is actually wired to favouritesClause (source-level check,
//    same spirit as the theme-token drift check) — without it the first two
//    could pass while the clause renders nowhere at all.
//
// STATE_DIR is redirected at a throwaway dir BEFORE the first import, so
// settings.load() and the likes store touch nothing real — hence the dynamic
// imports. node:assert-via-tsx style, matching scripts/voice-policy.test.ts.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeTempDir } from './test-utils/temp-dir.js';

const root = mkdtempSync(join(tmpdir(), 'subwave-favs-'));
process.env.STATE_DIR = root;

writeFileSync(
  join(root, 'settings.json'),
  JSON.stringify({ likes: { enabled: true, influenceDj: true, windowDays: 30, maxTracks: 5 } }),
);
// Two likes for one song, one for another — exercises count aggregation and
// the "by unknown" artist fallback in one pass.
const likedAt = new Date().toISOString();
writeFileSync(
  join(root, 'likes.json'),
  JSON.stringify({
    secret: 'test-secret',
    likes: [
      { songId: 's1', track: { id: 's1', title: 'Neon Rain', artist: 'The Wires' }, airingKey: 's1|a', listenerKey: 'k1', likedAt },
      { songId: 's1', track: { id: 's1', title: 'Neon Rain', artist: 'The Wires' }, airingKey: 's1|b', listenerKey: 'k2', likedAt },
      { songId: 's2', track: { id: 's2', title: 'Static Bloom' }, airingKey: 's2|a', listenerKey: 'k1', likedAt },
    ],
  }),
);

const settings = await import('../src/settings.js');
await settings.load();
const likes = await import('../src/broadcast/likes.js');
await likes.load();
const { pickSystem } = await import('../src/broadcast/dj-agent/schemas.js');

try {
  console.log('listener-favourites placement (#991 / prompt-cache stability):');

  {
    const clause = likes.favouritesClause(settings.get()?.likes);
    assert.match(clause, /^ Listener favourites — /,
      'opted-in clause renders, leading space intact (it is appended mid-suffix)');
    assert.match(clause, /"Neon Rain" by The Wires \(2\)/, 'counts aggregate per song');
    assert.match(clause, /"Static Bloom" by unknown \(1\)/, 'missing artist falls back to "unknown"');
    assert.match(clause, /keep variety/, 'the lean-never-lock rider survives');
    console.log('  ✓ favouritesClause renders the leaderboard when opted in');
  }

  {
    assert.equal(likes.favouritesClause({ enabled: true, influenceDj: false }), '',
      'influenceDj off → empty');
    assert.equal(likes.favouritesClause({ enabled: false, influenceDj: true }), '',
      'likes off → empty');
    assert.equal(likes.favouritesClause(undefined), '', 'absent config → empty');
    console.log('  ✓ returns the empty string whenever the operator has not opted in');
  }

  {
    const sys = pickSystem();
    assert.ok(!sys.includes('Listener favourites'),
      'pickSystem must NOT render favourites — they ride the pick event turn');
    assert.ok(!sys.includes('Neon Rain'),
      'no liked track leaks into the system prompt');
    console.log('  ✓ pickSystem stays favourites-free (byte-stable cache prefix)');
  }

  {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '../src/broadcast/dj-agent.ts'), 'utf8');
    assert.ok(src.includes('likes.favouritesClause('),
      'runTrackEvent must render favourites via likes.favouritesClause on the event turn');
    console.log('  ✓ dj-agent event turn is wired to favouritesClause');
  }

  console.log('all listener-favourites placement tests passed');
} finally {
  await removeTempDir(root);
}

// albumKeyFor — the album cooldown's key resolved against the library
// (#1485 FR 3).
//
// Why this exists at all: the compilation exemption reads flags that most
// candidates in a real pick do NOT carry. A raw Subsonic child has no
// compilation field (OpenSubsonic puts it on the ALBUM, not the song) and most
// of the pool picker's seven sources return raw children; the agent path's
// `seen` map holds the model-facing projection, which drops them deliberately
// because those values are serialised straight into a re-pick prompt. Resolve
// them here or the exemption is dead exactly where it matters — which is the
// regression this file exists to catch.
//
// Against a REAL library.db, because the whole point is the round trip through
// the two era columns and their composition.
//
// Run: npm test -- album-facts

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-album-facts-'));

const db = await import('../src/music/library-db.js');
const library = await import('../src/music/library.js');
const { albumKey } = await import('../src/music/recency.js');
const { albumKeyFor } = await import('../src/music/album-facts.js');

await library.load();

// A flagged compilation, an anthology the WALK flagged (Navidrome's own flag
// empty — the #1418 shape), and an ordinary record.
db.upsertTrackMeta('comp-1', {
  title: 'Opener', artist: 'First Act', album: 'Sunshine Sampler', isCompilation: true,
});
db.upsertTrackMeta('anth-1', {
  title: 'Get Out of My Life', artist: 'Allen Toussaint',
  album: 'The Atco Singles 1968-1974', isCompilation: false, eraUntrusted: true,
});
db.upsertTrackMeta('ok-1', {
  title: 'Idioteque', artist: 'Radiohead', album: 'Kid A', isCompilation: false,
});

// A raw Subsonic child: album and artist, no era fields at all. This is what
// most pool candidates and every `seen` entry actually look like.
const subsonicChild = (id: string, title: string, artist: string, album: string) =>
  ({ id, title, artist, album });

test('a raw candidate keys as an ordinary record when the library says so', () => {
  const s = subsonicChild('ok-1', 'Idioteque', 'Radiohead', 'Kid A');
  assert.equal(albumKeyFor(s), 'kid a|radiohead');
  assert.equal(albumKeyFor(s), albumKey({ ...s, isCompilation: false }));
});

test('a raw compilation candidate IS exempt once the flags are filled in', () => {
  // The regression: the pure key alone cannot see the flag, so the sampler
  // would key normally and go on cooldown.
  const s = subsonicChild('comp-1', 'Opener', 'First Act', 'Sunshine Sampler');
  assert.notEqual(albumKey(s), '', 'the pure key cannot know — that is the point');
  assert.equal(albumKeyFor(s), '', 'resolved against the library, it is exempt');
});

test('an anthology the WALK flagged is exempt too, not just a tagged compilation', () => {
  // isCompilation false, era_untrusted true — the #1418 case the composed
  // yearUntrusted exists for. Reading the raw flag alone would miss it.
  const s = subsonicChild('anth-1', 'Get Out of My Life', 'Allen Toussaint', 'The Atco Singles 1968-1974');
  assert.equal(albumKeyFor(s), '');
});

test('a candidate that states its own flags is trusted without a lookup', () => {
  // A library-sourced row (slimTrack) carries these already, and its value must
  // win — the lookup could only return the same columns it came from.
  assert.equal(albumKeyFor({ id: 'ok-1', artist: 'Radiohead', album: 'Kid A', isCompilation: true }), '');
  assert.equal(
    albumKeyFor({ id: 'comp-1', artist: 'First Act', album: 'Sunshine Sampler', yearUntrusted: false }),
    'sunshine sampler|first act',
  );
});

test('a track with no library row keys normally — a miss is not evidence', () => {
  const s = subsonicChild('not-in-db', 'Ghost', 'Someone', 'Some Record');
  assert.equal(albumKeyFor(s), 'some record|someone');
});

test('nothing to key on short-circuits before any lookup', () => {
  assert.equal(albumKeyFor(null), '');
  assert.equal(albumKeyFor(undefined), '');
  assert.equal(albumKeyFor({}), '');
  assert.equal(albumKeyFor({ artist: 'Radiohead' }), '', 'no album');
  assert.equal(albumKeyFor({ album: 'Kid A', artist: 'Radiohead' }), 'kid a|radiohead', 'no id to look up');
});

test('getAlbumFacts composes the two era columns the way every other reader does', () => {
  assert.deepEqual(library.getAlbumFacts('comp-1'), { isCompilation: true, yearUntrusted: true });
  // OR, not COALESCE: either column alone is enough (#1418).
  assert.deepEqual(library.getAlbumFacts('anth-1'), { isCompilation: false, yearUntrusted: true });
  assert.deepEqual(library.getAlbumFacts('ok-1'), { isCompilation: false, yearUntrusted: false });
  assert.equal(library.getAlbumFacts('not-in-db'), null);
});

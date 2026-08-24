// Issue #1418: the surfaces a LISTENER perceives must read the resolved era
// year, never the raw `year`. A reissue anthology carries the reissue's date
// (a 1964 Stax single on a 2012 Light in the Attic comp is tagged 2012), so
// every surface that read `year` directly announced, displayed, or reasoned
// about the wrong decade even when the era pipeline had resolved the track
// correctly.
//
// Pins the two surfaces that resolve without a loaded library DB: the
// Liquidsoap annotation (music/subsonic.getAnnotatedUri) and the picker's slim
// projection (llm/internal/tools/picker/slim). Both take the era fields off
// the candidate when it carries them, which is the library-sourced path — with
// no DB loaded the lookup arm returns null and the fallback is the plain year,
// exactly the pre-#1418 behaviour for off-library tracks.
//
// The other two surfaces (the DJ intro line in llm/internal/prompts/scripts.ts
// and /now-playing in routes/public.ts) go through the same resolveEraYear /
// trackEraYear pair and are not re-pinned here — show-filter's own precedence
// is covered by the era tests.
//
// Run: npm test -- era-year-surfaces

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.STATE_DIR ||= '/tmp/subwave-era-year-surfaces';

const { getAnnotatedUri } = await import('../src/music/subsonic.js');
const { slim } = await import('../src/llm/internal/tools/picker/slim.js');

// A library-sourced candidate: carries the era columns, so neither surface
// needs the DB to resolve it.
const track = (over: Record<string, unknown> = {}) => ({
  id: 'trk',
  title: 'After Laughter (Comes Tears)',
  artist: 'Wendy Rene',
  album: 'After Laughter Comes Tears',
  year: 2012,
  originalYear: null,
  isCompilation: false,
  ...over,
});

// Read the annotate: URI's `year="…"` field, or null when it emitted none.
function annotatedYear(song: Record<string, unknown>): string | null {
  const uri = getAnnotatedUri(song);
  return /,?year="([^"]*)"/.exec(uri)?.[1] ?? null;
}

test('annotation: a resolved original year beats the reissue year', () => {
  assert.equal(annotatedYear(track({ originalYear: 1964 })), '1964');
});

test('annotation: an unresolved compilation emits NO year rather than the reissue date', () => {
  // #842's "leave it out rather than assert the wrong decade", reaching the
  // metadata. Before #1418 this annotated year="2012".
  assert.equal(annotatedYear(track({ originalYear: null, isCompilation: true })), null);
});

test('annotation: a plain non-compilation keeps its own year', () => {
  assert.equal(annotatedYear(track()), '2012');
});

test('annotation: a track with no era fields at all falls back to the plain year', () => {
  // Off-library / raw Subsonic child — unchanged from pre-#1418.
  const bare = { id: 'trk', title: 'T', artist: 'A', album: 'B', year: 1999 };
  assert.equal(annotatedYear(bare), '1999');
});

test('annotation: a junk year is still dropped', () => {
  // TYER=0000 → a literal 0, which must not sail into an open-lower-bound era
  // window. resolveEraYear's junk guard, inherited here.
  assert.equal(annotatedYear(track({ year: 0, originalYear: null })), null);
});

test('picker: slim() shows the agent the original year, not the reissue', () => {
  assert.equal(slim(track({ originalYear: 1964 })).year, 1964);
});

test('picker: slim() reports an unresolved compilation as unknown', () => {
  assert.equal(slim(track({ originalYear: null, isCompilation: true })).year, null);
});

test('picker: slim() keeps a plain non-compilation year', () => {
  assert.equal(slim(track()).year, 2012);
});

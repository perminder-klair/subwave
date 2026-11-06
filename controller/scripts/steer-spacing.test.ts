// Artist spacing among a steer's opening tracks (music/steer.ts
// spaceOpeningList). One model call lays out the whole list, so this is the
// point of choice for each track after the first: a repeat is held back while
// the pool offered something else, and let through, said out loud, only when
// it did not. The route-level cases over a real pool are in steer-preview.
// Run: npm test -- steer-spacing
import assert from 'node:assert/strict';
import test from 'node:test';

const { openingArtistSpan, spaceOpeningList } = await import('../src/music/steer.js');

const track = (id: string, artist: string) => ({ id, title: `Track ${id}`, artist });
const ids = (list: { id?: string | null }[]) => list.map(t => t.id);

test('the span is the station\'s variety window, and never less than back to back', () => {
  assert.equal(openingArtistSpan(5), 5);
  assert.equal(openingArtistSpan(2.7), 2);
  for (const off of [0, 1, -3, null, undefined, Number.NaN]) assert.equal(openingArtistSpan(off), 1, String(off));
});

test('a track by the artist just before it is held while the pool has another artist', () => {
  const a1 = track('a1', 'Radiohead'), a2 = track('a2', 'Radiohead'), b1 = track('b1', 'Portishead');
  const out = spaceOpeningList([a1, a2, b1], [a1, a2, b1], 1);
  assert.deepEqual(ids(out.picks), ['a1', 'b1']);
  assert.deepEqual(ids(out.held), ['a2']);
  assert.equal(out.relaxed, false);
});

test('the window reaches back past the track before, and lets the artist in once it has passed', () => {
  const list = [track('a1', 'Air'), track('b1', 'Bjork'), track('a2', 'Air'), track('c1', 'Can'), track('d1', 'Dido'), track('a3', 'Air')];
  const out = spaceOpeningList(list, list, 3);
  assert.deepEqual(ids(out.picks), ['a1', 'b1', 'c1', 'd1', 'a3'], 'a2 sits two places after a1; a3 four');
  assert.deepEqual(ids(out.held), ['a2']);
  assert.equal(out.relaxed, false);
});

test('acts match as the live guard matches them, article and all', () => {
  const list = [track('x', 'The Beatles'), track('y', 'Beatles'), track('z', 'Kinks')];
  assert.deepEqual(ids(spaceOpeningList(list, list, 1).picks), ['x', 'z']);
});

test('a held track is not replaced by one the model did not choose', () => {
  const a1 = track('a1', 'Air'), a2 = track('a2', 'Air'), b1 = track('b1', 'Bjork');
  const out = spaceOpeningList([a1, a2], [a1, a2, b1], 1);
  assert.deepEqual(ids(out.picks), ['a1'], 'b1 was offered, so a2 is held, and the list is only shorter');
});

test('when every eligible track is by one artist, the list keeps them and says spacing gave way', () => {
  const list = [track('a1', 'Air'), track('a2', 'Air'), track('a3', 'Air')];
  const out = spaceOpeningList(list, list, 5);
  assert.deepEqual(ids(out.picks), ['a1', 'a2', 'a3']);
  assert.deepEqual(out.held, []);
  assert.equal(out.relaxed, true);
});

test('with too few artists for the window, it narrows to back to back before letting a repeat through', () => {
  const list = [track('a1', 'Air'), track('a2', 'Air'), track('b1', 'Bjork'), track('b2', 'Bjork'), track('a3', 'Air')];
  const out = spaceOpeningList(list, list, 5);
  assert.deepEqual(ids(out.picks), ['a1', 'b1', 'a3'], 'no artist twice in a row');
  assert.deepEqual(ids(out.held), ['a2', 'b2']);
  assert.equal(out.relaxed, true, 'Air returned inside the window of five, which the operator is told');
});

test('an untagged track is never held, and the first track always stays', () => {
  const list = [track('u1', ''), track('u2', ''), track('a1', 'Air')];
  assert.deepEqual(ids(spaceOpeningList(list, list, 5).picks), ['u1', 'u2', 'a1']);
  assert.deepEqual(ids(spaceOpeningList([track('a1', 'Air')], [], 5).picks), ['a1']);
  assert.deepEqual(spaceOpeningList([], [], 5), { picks: [], held: [], relaxed: false });
});

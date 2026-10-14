// The Track Shortlist leaves the pick-anchor artist out of the list the model
// reads, so the artist guard no longer has to reject that artist after the
// fact with a second model call. Never-starve: a list that is nothing but the
// anchor artist is offered whole, and the guard's pool rescue answers it.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

// The shortlist module reaches config at import, so it needs a state dir of
// its own rather than whatever STATE_DIR the shell carries.
const stateRoot = mkdtempSync(join(tmpdir(), 'subwave-shortlist-anchor-'));
process.env.STATE_DIR = stateRoot;
process.env.NAVIDROME_URL = 'http://shortlist-anchor.invalid';
const { executeShortlistPlan, shortlistAvoidArtist, withoutArtist } = await import('../src/music/shortlist.js');
const { pickerScope } = await import('../src/llm/tools.js');
const { artistRootKey, setKnownActsProvider } = await import('../src/music/recency.js');
after(() => rmSync(stateRoot, { recursive: true, force: true }));

const pass = { inputSchema: { safeParse: (value: unknown) => ({ success: true, data: value }) } };

function source(seen: Map<string, any>, tracks: Array<{ id: string; artist: string }>) {
  return {
    ...pass,
    execute: async () => {
      for (const track of tracks) seen.set(track.id, { ...track, title: track.id });
      return tracks;
    },
  };
}

test('the anchor artist is left out of the offered shortlist, order kept', async () => {
  const seen = new Map<string, any>();
  const tools = {
    similar: source(seen, [
      { id: 'a1', artist: 'Nipsey Hussle' },
      { id: 'b1', artist: 'SiR' },
      { id: 'a2', artist: 'Nipsey Hussle feat. James Fauntleroy' },
      { id: 'c1', artist: 'TroyBoi' },
      { id: 'd1', artist: 'Daft Punk' },
      { id: 'e1', artist: 'Steel Banglez' },
    ]),
  };
  const result = await executeShortlistPlan(tools, seen, [
    { source: 'similar', args: {}, family: 'continuity' },
  ], { avoidArtist: 'Nipsey Hussle' });
  assert.deepEqual(result.candidates.map(c => c.id), ['b1', 'c1', 'd1', 'e1'],
    'a featured credit naming the anchor is left out too');
  assert.equal(result.uniqueCandidates, 4);
});

test('top-ups are judged on the list left after the exclusion', async () => {
  const seen = new Map<string, any>();
  let toppedUp = false;
  const tools = {
    similar: source(seen, [
      { id: 'a1', artist: 'Anchor' }, { id: 'a2', artist: 'Anchor' }, { id: 'a3', artist: 'Anchor' },
      { id: 'b1', artist: 'Other One' }, { id: 'c1', artist: 'Other Two' },
    ]),
    randomSongs: {
      ...pass,
      execute: async () => {
        toppedUp = true;
        for (const id of ['r1', 'r2']) seen.set(id, { id, title: id, artist: `Random ${id}` });
        return [];
      },
    },
  };
  const result = await executeShortlistPlan(tools, seen, [
    { source: 'similar', args: {}, family: 'continuity' },
  ], {
    avoidArtist: 'Anchor', minimumCandidates: 4,
    topUps: [{ source: 'randomSongs', args: {}, family: 'diversity' }],
  });
  assert.ok(toppedUp, 'five candidates, but only two the pick may take');
  assert.deepEqual(result.candidates.map(c => c.id), ['b1', 'c1', 'r1', 'r2']);
});

test('never-starve: an all-anchor list is offered whole for the guard to answer', async () => {
  const seen = new Map<string, any>();
  const tools = {
    similar: source(seen, [{ id: 'a1', artist: 'Anchor' }, { id: 'a2', artist: 'Anchor' }]),
  };
  const result = await executeShortlistPlan(tools, seen, [
    { source: 'similar', args: {}, family: 'continuity' },
  ], { avoidArtist: 'Anchor' });
  assert.deepEqual(result.candidates.map(c => c.id), ['a1', 'a2']);
});

test('no avoided artist leaves the list untouched; an untagged track is never dropped', () => {
  const list = [{ id: 'x', artist: 'Anchor' }, { id: 'y' }, { id: 'z', artist: 'Other' }];
  assert.deepEqual(withoutArtist(list, '').other, list);
  assert.deepEqual(withoutArtist(list, artistRootKey('Anchor')).other.map(c => c.id), ['y', 'z']);
  // A band whose name merely contains the anchor's is a different act.
  assert.deepEqual(
    withoutArtist([{ id: 'p', artist: 'Anchorage' }], artistRootKey('Anchor')).other.map(c => c.id), ['p'],
  );
});

test('a prepared episode keeps its artist; every other pick avoids the anchor', () => {
  assert.equal(shortlistAvoidArtist({ scope: pickerScope(), currentArtist: 'Anchor' }), 'Anchor');
  assert.equal(shortlistAvoidArtist({ scope: pickerScope(), currentArtist: null }), null);
  assert.equal(
    shortlistAvoidArtist({ scope: pickerScope({ episodeSource: { artist: 'Anchor' } as any }), currentArtist: 'Anchor' }),
    null, 'an artist episode is that artist by design, as the guard already exempts it',
  );
});

// The guard's spacing window, applied before the model reads the list (seen
// live at 3 re-picks in 17 Shortlist picks): acts just played are left out
// when anything fresher was found, and offered whole when nothing was.
test('artists in the spacing window are left out when a fresher one exists', async () => {
  const seen = new Map<string, any>();
  const tools = {
    similar: source(seen, [
      { id: 'r1', artist: 'Arjan Dhillon' },
      { id: 'f1', artist: 'Deep Kalsi' },
      { id: 'r2', artist: 'Jazzy B & Amrinder Gill' },
      { id: 'u1', artist: '' },
      { id: 'f2', artist: 'Ne-Yo' },
    ]),
  };
  const recent = new Set([artistRootKey('Arjan Dhillon'), artistRootKey('Amrinder Gill')]);
  setKnownActsProvider(() => new Set(['Amrinder Gill', 'Jazzy B'].map(a => artistRootKey(a))));
  const result = await executeShortlistPlan(tools, seen, [
    { source: 'similar', args: {}, family: 'continuity' },
  ], { recentArtistRoots: recent, minimumCandidates: 0 }).finally(() => setKnownActsProvider(null));
  assert.deepEqual(result.candidates.map(c => c.id), ['f1', 'u1', 'f2'],
    'a tail act in the window counts, as it does for the guard; an untagged track stays');
  assert.equal(result.spacingSkipped, 2);
});

test('top-ups are judged on the list left after spacing', async () => {
  const seen = new Map<string, any>();
  let toppedUp = false;
  const tools = {
    similar: source(seen, [
      { id: 'r1', artist: 'Recent One' }, { id: 'r2', artist: 'Recent Two' },
      { id: 'r3', artist: 'Recent Three' }, { id: 'f1', artist: 'Fresh' },
    ]),
    randomSongs: {
      ...pass,
      execute: async () => {
        toppedUp = true;
        for (const id of ['x1', 'x2', 'x3']) seen.set(id, { id, title: id, artist: `Random ${id}` });
        return [];
      },
    },
  };
  const recent = new Set(['Recent One', 'Recent Two', 'Recent Three'].map(a => artistRootKey(a)));
  const result = await executeShortlistPlan(tools, seen, [
    { source: 'similar', args: {}, family: 'continuity' },
  ], { recentArtistRoots: recent, minimumCandidates: 4, topUps: [{ source: 'randomSongs', args: {}, family: 'diversity' }] });
  assert.ok(toppedUp, 'four candidates, but only one outside the window');
  assert.deepEqual(result.candidates.map(c => c.id), ['f1', 'x1', 'x2', 'x3']);
});

test('spacing yields: an all-recent list is offered whole, the anchor still left out', async () => {
  const seen = new Map<string, any>();
  const tools = {
    similar: source(seen, [
      { id: 'a1', artist: 'Anchor' }, { id: 'r1', artist: 'Recent' }, { id: 'r2', artist: 'Recent' },
    ]),
  };
  const result = await executeShortlistPlan(tools, seen, [
    { source: 'similar', args: {}, family: 'continuity' },
  ], { avoidArtist: 'Anchor', recentArtistRoots: new Set([artistRootKey('Recent'), artistRootKey('Anchor')]), minimumCandidates: 0 });
  assert.deepEqual(result.candidates.map(c => c.id), ['r1', 'r2']);
  assert.equal(result.spacingSkipped, 0);
});

// runAlbumGuard — the album cooldown at the agent path's point of choice
// (#1485 FR 3).
//
// The cost guarantee IS the point of this file, and it is asserted by counting
// the injected calls: the guard may spend AT MOST one re-pick and must never
// reach for a pool rescue, because the pool applies the same cooldown itself
// and a second model round trip on a transition buys nothing. A preference must
// never cost the station a slot.
//
// The key itself, the compilation exemption and the pool-path filter are pinned
// in album-recency.test.ts. No model, no queue and no settings here — every
// expensive call is injected, which is what makes the wiring testable.
//
// Run: npm test -- album-guard-run

import assert from 'node:assert/strict';
import test from 'node:test';
import { alternativeAlbumCandidates, runAlbumGuard } from '../src/broadcast/dj-agent/album-guard.js';
import { albumKey, artistRootKey } from '../src/music/recency.js';

type Cand = {
  id: string; title: string; artist: string;
  album?: string; albumArtist?: string; isCompilation?: boolean | null;
};

const kidA1: Cand = { id: 'k1', title: 'Idioteque', artist: 'Radiohead', album: 'Kid A' };
const kidA2: Cand = { id: 'k2', title: 'The National Anthem', artist: 'Radiohead', album: 'Kid A' };
const bends: Cand = { id: 'b1', title: 'Fake Plastic Trees', artist: 'Radiohead', album: 'The Bends' };
const clash: Cand = { id: 'c1', title: 'Clampdown', artist: 'The Clash', album: 'London Calling' };
const sly: Cand = { id: 's1', title: 'Fun', artist: 'Sly & the Family Stone', album: 'Life' };
const untagged: Cand = { id: 'u1', title: 'Unknown', artist: 'Nobody' };
const sampler: Cand = { id: 'n1', title: 'A Track', artist: 'Act One', album: 'Now 47', isCompilation: true };

const seenOf = (...songs: Cand[]) => new Map(songs.map((s) => [s.id, s]));
const albumsOf = (...songs: Cand[]) => new Set(songs.map((s) => albumKey(s)).filter(Boolean));
const rootsOf = (...names: string[]) => new Set(names.map((n) => artistRootKey(n)));

// Records everything the guard SPENT as well as what it decided.
function harness(opts: { repick?: (alt: Map<string, Cand>) => Cand | null } = {}) {
  const calls = { repick: 0 };
  const reasons: string[] = [];
  const lines: string[] = [];
  const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
  return {
    calls, reasons, lines, events,
    deps: {
      repick: async (alt: Map<string, Cand>, reason: string) => {
        calls.repick += 1;
        reasons.push(reason);
        const picked = opts.repick ? opts.repick(alt) : null;
        return picked ? { id: picked.id } : null;
      },
      log: (line: string) => { lines.push(line); },
      logEvent: (name: string, payload: Record<string, unknown>) => { events.push({ name, payload }); },
    },
  };
}

// ── alternativeAlbumCandidates ─────────────────────────────────────────────

test('alternatives drop the recent albums and keep everything else', () => {
  const { alt } = alternativeAlbumCandidates(
    seenOf(kidA2, bends, clash), albumsOf(kidA1), albumKey,
  );
  assert.deepEqual([...alt.keys()], ['b1', 'c1']);
});

test('a candidate with no album key is never dropped', () => {
  // Untagged and exempt both key as '' — absence of a record is not evidence
  // of a repeat, the same rule the artist guard applies to an untagged artist.
  const { alt } = alternativeAlbumCandidates(
    seenOf(kidA2, untagged, sampler), albumsOf(kidA1), albumKey,
  );
  assert.deepEqual([...alt.keys()], ['u1', 'n1']);
});

test('alternatives also step around the artist guard\'s own window', () => {
  // Without this the album re-pick could hand back the very artist the guard
  // immediately before it just stepped around.
  const { alt, dropped, starved } = alternativeAlbumCandidates(
    seenOf(bends, clash, sly), albumsOf(kidA1), albumKey, rootsOf('Radiohead'),
  );
  assert.deepEqual([...alt.keys()], ['c1', 's1']);
  assert.equal(dropped, 1);
  assert.equal(starved, false);
});

test('when every fresh album is also a recent artist, the artist exclusion is waived', () => {
  // A preference, not a second artist guard: the artist guard has already had
  // its say on this pick, and re-litigating it here would empty the pool.
  const { alt, dropped, starved } = alternativeAlbumCandidates(
    seenOf(bends), albumsOf(kidA1), albumKey, rootsOf('Radiohead'),
  );
  assert.deepEqual([...alt.keys()], ['b1']);
  assert.equal(dropped, 0);
  assert.equal(starved, true, 'overruled, not a no-op');
});

// ── the guard ──────────────────────────────────────────────────────────────

test('a fresh album is not guarded, and costs nothing', async () => {
  const h = harness();
  const out = await runAlbumGuard<Cand>({
    song: clash, object: { id: clash.id }, seen: seenOf(clash, bends),
    recentAlbums: albumsOf(kidA1), avoidArtistRoots: new Set(), albumKeyOf: albumKey, hours: 6, ...h.deps,
  });
  assert.equal(out.kind, 'none');
  assert.equal(h.calls.repick, 0);
  assert.equal(h.lines.length, 0, 'a guard that did not fire is not an event');
});

test('a compilation pick is never guarded', async () => {
  // Even with the sampler itself in the recent set — it keys as '' on both
  // sides, so there is nothing to match.
  const h = harness();
  const out = await runAlbumGuard<Cand>({
    song: sampler, object: { id: sampler.id }, seen: seenOf(sampler, clash),
    recentAlbums: albumsOf(sampler, kidA1), avoidArtistRoots: new Set(), albumKeyOf: albumKey, hours: 6, ...h.deps,
  });
  assert.equal(out.kind, 'none');
  assert.equal(h.calls.repick, 0);
});

test('a recent album is re-picked from the run\'s other-album candidates', async () => {
  const h = harness({ repick: (alt) => alt.get('c1') ?? null });
  const out = await runAlbumGuard<Cand>({
    song: kidA2, object: { id: kidA2.id, say: 'hello' }, seen: seenOf(kidA2, clash),
    recentAlbums: albumsOf(kidA1), avoidArtistRoots: new Set(), albumKeyOf: albumKey, hours: 6, ...h.deps,
  });
  assert.equal(out.kind, 'repicked');
  assert.equal(out.kind === 'repicked' && out.song.id, 'c1');
  assert.equal(h.calls.repick, 1, 'exactly one call, never two');
  assert.match(h.reasons[0], /different album/i);
  assert.equal(h.events[0].payload.relaxed, false);
});

test('a re-pick that answers with an id it was not offered is refused', async () => {
  // The re-pick resolves out of `alt`, not the full `seen` — an id outside the
  // set it was handed is a failed re-pick, not a licence to play kidA2's twin.
  const h = harness({ repick: () => kidA2 });
  const out = await runAlbumGuard<Cand>({
    song: kidA2, object: { id: kidA2.id }, seen: seenOf(kidA2, clash),
    recentAlbums: albumsOf(kidA1), avoidArtistRoots: new Set(), albumKeyOf: albumKey, hours: 6, ...h.deps,
  });
  assert.equal(out.kind, 'kept');
  assert.equal(h.calls.repick, 1);
});

test('a failed re-pick keeps the pick — one call, and it is logged', async () => {
  const h = harness({ repick: () => null });
  const out = await runAlbumGuard<Cand>({
    song: kidA2, object: { id: kidA2.id }, seen: seenOf(kidA2, clash),
    recentAlbums: albumsOf(kidA1), avoidArtistRoots: new Set(), albumKeyOf: albumKey, hours: 6, ...h.deps,
  });
  assert.equal(out.kind, 'kept', 'a preference never costs the slot');
  assert.equal(h.calls.repick, 1, 'and never escalates to a second model call');
  assert.equal(h.events[0].payload.reason, 'repick-failed');
  assert.equal(h.events[0].payload.relaxed, true);
  assert.equal(h.lines.length, 1, 'a repeat on air is never silent');
});

test('a run that is entirely one album keeps the pick without calling the model', async () => {
  const h = harness();
  const out = await runAlbumGuard<Cand>({
    song: kidA2, object: { id: kidA2.id }, seen: seenOf(kidA1, kidA2),
    recentAlbums: albumsOf(kidA1), avoidArtistRoots: new Set(), albumKeyOf: albumKey, hours: 6, ...h.deps,
  });
  assert.equal(out.kind, 'kept');
  assert.equal(h.calls.repick, 0, 'no alternative exists — do not pay to discover that');
  assert.equal(h.events[0].payload.reason, 'no-other-album');
  assert.match(h.lines[0], /album cooldown 6h/);
});

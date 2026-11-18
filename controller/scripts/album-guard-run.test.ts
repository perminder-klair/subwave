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
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { albumGuardAnchorRoot, alternativeAlbumCandidates, runAlbumGuard } from '../src/broadcast/dj-agent/album-guard.js';
import { runArtistGuard } from '../src/broadcast/dj-agent/artist-guard.js';
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

for (const window of [0, 5]) {
  test(`album recency rescue preserves a successful artist re-pick's anchor at window ${window}`, async () => {
    const repeat: Cand = { id: 'p', title: 'Mr. Grieves', artist: 'Pixies • Kim Deal', album: 'Doolittle' };
    const recentRoots = window ? rootsOf('Pixies', clash.artist) : new Set<string>();
    const { alt, starved } = alternativeAlbumCandidates(
      seenOf(repeat, clash), albumsOf(kidA1), albumKey, recentRoots, artistRootKey('Pixies'),
    );
    assert.deepEqual([...alt.keys()], [clash.id]);
    assert.equal(starved, window > 0, 'the unrelated recent artist can still be restored');

    const h = harness();
    const out = await runAlbumGuard({
      song: kidA2, object: { id: kidA2.id }, seen: seenOf(kidA2, repeat),
      recentAlbums: albumsOf(kidA1), avoidArtistRoots: recentRoots,
      avoidAnchorRoot: artistRootKey('Pixies'), albumKeyOf: albumKey, hours: 6, ...h.deps,
    });
    assert.equal(out.kind, 'kept', 'keep the artist-safe pick when only the anchor has another album');
    assert.equal(h.calls.repick, 0);
  });
}

// ── the anchor, whatever the artist guard decided (L2) ─────────────────────

// Production, 8 Oct (trace 412fbc72), replayed: "Jesse James Bolero" by Prefab
// Sprout on air (the pick anchor). The run's only discovery call returned the
// on-air track's neighbours; the agent picked Cocosuma off "Reindeer Show The
// Way", an album aired 10 min earlier. The artist guard KEPT it (Cocosuma was
// a recent artist, every alternative too: spacing yielded). The album guard
// then had one other-album candidate — Prefab Sprout — starved on the recent
// window, waived the artist exclusion and aired Prefab Sprout twice in a row.
const onAir: Cand = { id: 'p0', title: 'Jesse James Bolero', artist: 'Prefab Sprout', album: 'Jordan: The Comeback' };
const cocosuma: Cand = { id: 'c0', title: 'Sparks', artist: 'Cocosuma', album: 'Reindeer Show The Way' };
const cocosumaPick: Cand = { id: 'c2', title: 'Mocking Stars', artist: 'Cocosuma', album: 'Reindeer Show The Way' };
const prefab: Cand = { id: 'p2', title: 'Earth, the Story So Far', artist: 'Prefab Sprout', album: 'Crimson/Red' };

function replay(avoidAnchorRoot: string) {
  const h = harness({ repick: (alt) => alt.get(prefab.id) ?? null });
  return {
    h,
    out: runAlbumGuard<Cand>({
      song: cocosumaPick, object: { id: cocosumaPick.id },
      seen: seenOf(cocosumaPick, prefab),
      recentAlbums: albumsOf(cocosuma),
      avoidArtistRoots: rootsOf('Prefab Sprout', 'Cocosuma'),
      avoidAnchorRoot, albumKeyOf: albumKey, hours: 12, ...h.deps,
    }),
  };
}

test('the old call-site rule reproduces the repeat: no artist re-pick, no anchor', async () => {
  const { h, out } = replay('');
  const r = await out;
  assert.equal(r.kind, 'repicked');
  assert.equal(r.kind === 'repicked' && r.song.artist, 'Prefab Sprout', 'the on-air artist again');
  assert.equal(h.calls.repick, 1);
});

test('with the anchor always passed, the on-air artist is never the album re-pick', async () => {
  const { h, out } = replay(albumGuardAnchorRoot(onAir, cocosumaPick, false));
  const r = await out;
  assert.equal(r.kind, 'kept', 'an album repeat beats the same artist twice in a row');
  assert.equal(h.calls.repick, 0, 'and it costs no model call');
});

test('a pick kept because only the anchor artist had another record says so, not "one album"', async () => {
  // The run surfaced Crimson/Red; the booth must not claim every candidate
  // came off the recent record, or the operator diagnosing the repeat is told
  // the run was single-album.
  const { h, out } = replay(albumGuardAnchorRoot(onAir, cocosumaPick, false));
  await out;
  assert.equal(h.events[0].payload.reason, 'only-anchor-artist');
  assert.equal(h.events[0].payload.anchorSkipped, 1);
  assert.match(h.lines[0], /only other-album candidate\(s\) were by the pick-anchor artist/);
  assert.doesNotMatch(h.lines[0], /every candidate in the run came off it/);
});

test('alternatives count what the anchor exclusion removed', () => {
  const { alt, anchorSkipped } = alternativeAlbumCandidates(
    seenOf(cocosumaPick, prefab, clash), albumsOf(cocosuma), albumKey, new Set(), artistRootKey('Prefab Sprout'),
  );
  assert.deepEqual([...alt.keys()], [clash.id]);
  assert.equal(anchorSkipped, 1);
  assert.equal(
    alternativeAlbumCandidates(seenOf(kidA2, clash), albumsOf(kidA1), albumKey).anchorSkipped, 0,
    'no anchor, nothing skipped',
  );
});

test('albumGuardAnchorRoot: the anchor artist on every agent pick, nothing for an episode or a conceded repeat', () => {
  assert.equal(albumGuardAnchorRoot(onAir, cocosumaPick, false), artistRootKey('Prefab Sprout'));
  assert.equal(albumGuardAnchorRoot(onAir, cocosumaPick, true), '', 'an episode runs no artist guard, by design');
  assert.equal(albumGuardAnchorRoot(null, cocosumaPick, false), '', 'no anchor, no exclusion');
  assert.equal(albumGuardAnchorRoot({ artist: 'The Clash' }, cocosumaPick, false), artistRootKey('Clash'));
  assert.equal(albumGuardAnchorRoot(onAir, prefab, false), '', 'the pick already IS the anchor artist');
  assert.equal(
    albumGuardAnchorRoot(onAir, { artist: 'Prefab Sprout • Thomas Dolby' }, false), '',
    'a credit overlapping the anchor is the same conceded repeat',
  );
});

test('the agent path wires the album guard through albumGuardAnchorRoot, with the surviving pick', () => {
  // The bug lived at the call site, not in the guard, so pin the call site.
  const src = readFileSync(new URL('../src/broadcast/dj-agent.ts', import.meta.url), 'utf8');
  assert.match(src, /avoidAnchorRoot:\s*albumGuardAnchorRoot\(pickAnchor,\s*song,\s*!!episodeSource\)/);
  assert.doesNotMatch(src, /avoidAnchorRoot:\s*guarded\.kind === 'repicked'/, 'the old re-pick-only rule is gone');
});

// ── both guards, composed as pickViaSelectionRoute composes them ───────────

// The real artist guard, then the real album guard on whatever pick it left
// standing, with the anchor root resolved through the same helper the call
// site uses. The album guard alone cannot show the conceded case below: it
// only arises when the artist guard hands back an anchor-artist pick as kept.
async function composeGuards(o: {
  song: Cand; pickAnchor: Cand; seen: Map<string, Cand>;
  neighbourRoots: Set<string>; recentAlbums: Set<string>;
  rescue: 'queued' | 'empty' | 'collision';
  repick?: (alt: Map<string, Cand>) => Cand | null;
}) {
  const h = harness({ repick: o.repick });
  const guarded = await runArtistGuard<Cand>({
    song: o.song, object: { id: o.song.id }, pickAnchor: o.pickAnchor, seen: o.seen,
    recentRoots: o.neighbourRoots, window: 5, poolRescue: async () => o.rescue, ...h.deps,
  });
  const song = guarded.kind === 'repicked' ? guarded.song : o.song;
  const album = guarded.kind === 'rescued' ? null : await runAlbumGuard<Cand>({
    song, object: { id: song.id }, seen: o.seen, recentAlbums: o.recentAlbums,
    avoidArtistRoots: o.neighbourRoots,
    avoidAnchorRoot: albumGuardAnchorRoot(o.pickAnchor, song, false),
    albumKeyOf: albumKey, hours: 6, ...h.deps,
  });
  return { h, guarded, album };
}

for (const rescue of ['empty', 'collision'] as const) {
  test(`a conceded anchor repeat (pool rescue ${rescue}) still moves off the on-air record`, async () => {
    // A discography-style run: the agent picked another track off the record
    // on air, and every other candidate is by that same artist. The artist
    // guard fires on the anchor, the pool has nothing else, and it concedes
    // the repeat. Excluding the anchor in the album guard now could not stop
    // that repeat — it would only strip Steve McQueen and air the same record
    // back to back as well.
    const langley: Cand = { id: 'l0', title: 'Cars and Girls', artist: 'Prefab Sprout', album: 'From Langley Park to Memphis' };
    const langleyPick: Cand = { id: 'l1', title: 'The King of Rock n Roll', artist: 'Prefab Sprout', album: 'From Langley Park to Memphis' };
    const mcqueen: Cand = { id: 'm1', title: 'Appetite', artist: 'Prefab Sprout', album: 'Steve McQueen' };
    const { h, guarded, album } = await composeGuards({
      song: langleyPick, pickAnchor: langley, seen: seenOf(langleyPick, mcqueen),
      neighbourRoots: rootsOf('Prefab Sprout'), recentAlbums: albumsOf(langley),
      rescue, repick: (alt) => alt.get(mcqueen.id) ?? null,
    });
    assert.equal(guarded.kind, 'kept', 'the artist guard conceded the anchor repeat');
    assert.equal(album?.kind, 'repicked', 'the album cooldown still does its job');
    assert.equal(album?.kind === 'repicked' && album.song.album, 'Steve McQueen');
    assert.equal(h.calls.repick, 1, 'one album re-pick, nothing more');
  });
}

test('a conceded anchor repeat still prefers another artist\'s record when the run has one', async () => {
  // The artist guard offered The Clash and the model declined; the pool had
  // nothing. The album guard's neighbour preference (the anchor is in the
  // window) still steers its re-pick away from the anchor artist.
  const langley: Cand = { id: 'l0', title: 'Cars and Girls', artist: 'Prefab Sprout', album: 'From Langley Park to Memphis' };
  const langleyPick: Cand = { id: 'l1', title: 'The King of Rock n Roll', artist: 'Prefab Sprout', album: 'From Langley Park to Memphis' };
  const mcqueen: Cand = { id: 'm1', title: 'Appetite', artist: 'Prefab Sprout', album: 'Steve McQueen' };
  let call = 0;
  const { guarded, album } = await composeGuards({
    song: langleyPick, pickAnchor: langley, seen: seenOf(langleyPick, mcqueen, clash),
    neighbourRoots: rootsOf('Prefab Sprout'), recentAlbums: albumsOf(langley), rescue: 'empty',
    repick: (alt) => {
      call += 1;
      if (call === 1) return null;
      assert.deepEqual([...alt.keys()], [clash.id], 'the anchor artist only as a starved fallback');
      return clash;
    },
  });
  assert.equal(guarded.kind, 'kept');
  assert.equal(album?.kind === 'repicked' && album.song.artist, 'The Clash');
});

test('composed: the trace\'s kept spacing pick never re-picks onto the anchor artist', async () => {
  const { h, guarded, album } = await composeGuards({
    song: cocosumaPick, pickAnchor: onAir, seen: seenOf(cocosumaPick, prefab),
    neighbourRoots: rootsOf('Prefab Sprout', 'Cocosuma'), recentAlbums: albumsOf(cocosuma),
    rescue: 'empty', repick: (alt) => alt.get(prefab.id) ?? null,
  });
  assert.equal(guarded.kind, 'kept', 'spacing yielded: every alternative was a recent artist');
  assert.equal(album?.kind, 'kept', 'no Prefab Sprout straight after Prefab Sprout');
  assert.equal(h.calls.repick, 0);
});

test('composed: a successful artist re-pick keeps its anchor exclusion', async () => {
  // The re-pick is never by the anchor, so the helper still passes it, and the
  // album guard cannot walk the slot back onto the artist just avoided.
  const doolittle: Cand = { id: 'd0', title: 'Debaser', artist: 'Pixies', album: 'Doolittle' };
  const doolittlePick: Cand = { id: 'd1', title: 'Hey', artist: 'Pixies', album: 'Doolittle' };
  const surfer: Cand = { id: 'd2', title: 'Where Is My Mind?', artist: 'Pixies', album: 'Surfer Rosa' };
  const { h, guarded, album } = await composeGuards({
    song: doolittlePick, pickAnchor: doolittle, seen: seenOf(doolittlePick, kidA2, surfer),
    neighbourRoots: new Set(), recentAlbums: albumsOf(doolittle, kidA1), rescue: 'empty',
    repick: (alt) => alt.get(kidA2.id) ?? alt.get(surfer.id) ?? null,
  });
  assert.equal(guarded.kind === 'repicked' && guarded.song.id, kidA2.id);
  assert.equal(album?.kind, 'kept', 'Surfer Rosa is the anchor artist: the artist-safe pick stands');
  assert.equal(h.calls.repick, 1, 'the artist re-pick only');
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

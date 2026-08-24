// Integration pins for the operator's manual era override (#1418) — the
// precedence rules that decide whose answer survives.
//
// The automatic pipeline has two writers: the library WALK (album tag →
// 'album-tag') and the MusicBrainz phase (→ 'musicbrainz'). The override adds a
// third, 'manual', which must outrank both. That is not a preference, it is a
// correctness requirement: every walk re-visits every track, so an override the
// walk can clobber would be silently undone by the next rescan — the operator
// would fix a record, and the station would forget by morning.
//
// Real better-sqlite3 against a temp STATE_DIR, because all three writers are
// SQL CASE expressions. A pure test over the intent would pass on every
// possible bug here.
//
// Run: npm test -- manual-original-year

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stateDir = mkdtempSync(join(tmpdir(), 'subwave-manual-era-'));
process.env.STATE_DIR = stateDir;

const db = await import('../src/music/library-db.js');
const library = await import('../src/music/library.js');
const { needsOriginalYearLookup } = await import('../src/music/musicbrainz.js');
const { resolveEraYear } = await import('../src/music/show-filter.js');
await db.open({ embeddingDim: 768, adoptStoredDim: true });
await library.load();

after(() => {
  db.close?.();
  rmSync(stateDir, { recursive: true, force: true });
});

// One reissue-anthology track, shaped like the report: a 1964 Stax single on a
// 2012 comp that Navidrome does NOT flag as a compilation, so the walk copies
// the album's originalReleaseDate (2012) straight in as the "original" year.
// Post-#1418: the walk no longer records an uninformative album-tag year, and
// stamps the derived era verdict instead. `eraUntrusted: true` is what
// era-suspect.albumEraSuspect returns for this album (Various Artists, 8
// credited artists, a 1964-65 range in the title).
function seedAnthologyTrack(id: string) {
  db.upsertTrackMeta(id, {
    title: 'After Laughter (Comes Tears)',
    artist: 'Wendy Rene',
    album: 'After Laughter Comes Tears',
    year: 2012,
    originalYear: null,   // suspect album → the album tag is not recorded
    isCompilation: false, // Navidrome does not flag these
    eraUntrusted: true,   // ...but era-suspect.ts does
  });
}

// The pre-#1418 shape, for the tests that need to show what changed.
function seedAsBefore(id: string) {
  db.upsertTrackMeta(id, {
    title: 'After Laughter (Comes Tears)',
    artist: 'Wendy Rene',
    album: 'After Laughter Comes Tears',
    year: 2012,
    originalYear: 2012,   // the album tag, which is just the reissue again
    isCompilation: false,
  });
}

test('the reported defect, as it behaved before the fix', () => {
  seedAsBefore('t0');
  const t = db.getTrack('t0')!;
  assert.equal(t.originalYear, 2012);
  assert.equal(t.originalYearSource, 'album-tag');
  // The reissue year read as resolved, so era filtering put a 1964 recording
  // in the 2010s...
  assert.equal(resolveEraYear(t.year, t.originalYear, t.yearUntrusted), 2012);
  // ...and the lookup that could have fixed it skipped the track twice over:
  // the album is not flagged, and the year already looks answered.
  assert.equal(needsOriginalYearLookup(t), false);
});

test('after the fix the same album is suspect, unresolved, and queued for a lookup', () => {
  seedAnthologyTrack('t1');
  const t = db.getTrack('t1')!;
  assert.equal(t.originalYear, null, 'an uninformative album tag is not recorded as resolved');
  assert.equal(t.originalYearSource, null);
  assert.equal(t.isCompilation, false, 'the raw Navidrome fact is preserved as-is');
  assert.equal(t.eraUntrusted, true);
  assert.equal(t.yearUntrusted, true, 'composed from either signal');
  // The #842 rule finally fires: unknown, rather than confidently 2012.
  assert.equal(resolveEraYear(t.year, t.originalYear, t.yearUntrusted), null);
  // And there is now a way in.
  assert.equal(needsOriginalYearLookup(t), true);
  assert.ok(db.idsNeedingOriginalYear().includes('t1'));
});

test('a later suspect walk clears a stale album-tag year and queues a lookup', () => {
  // The trust verdict is album-wide and can change as a walk sees more tracks.
  // This row was first visited while the album still looked ordinary, so it
  // already holds a plausible-looking album tag that differs from the file
  // year. Once the completed album is suspect, that stale answer must not keep
  // the track out of the MusicBrainz backfill.
  db.upsertTrackMeta('late-suspect', {
    title: 'Old Recording', artist: 'Singer A', album: 'Greatest Hits',
    year: 2015, originalYear: 1990, isCompilation: false, eraUntrusted: false,
  });
  assert.equal(db.getTrack('late-suspect')!.originalYearSource, 'album-tag');

  db.upsertTrackMeta('late-suspect', {
    title: 'Old Recording', artist: 'Singer A', album: 'Greatest Hits',
    year: 2015, originalYear: null, isCompilation: false, eraUntrusted: true,
  });

  const t = db.getTrack('late-suspect')!;
  assert.equal(t.originalYear, null, 'the now-untrusted album tag must be discarded');
  assert.equal(t.originalYearSource, null);
  assert.equal(t.eraUntrusted, true);
  assert.ok(db.idsNeedingOriginalYear().includes('late-suspect'));
});

test('an ordinary album is untouched by any of this', () => {
  // The regression that matters: the widened gate must not sweep in normal
  // records, which would cost a MusicBrainz request each and drop them out of
  // era shows if the lookup missed.
  db.upsertTrackMeta('ord', {
    title: 'Nude', artist: 'Radiohead', album: 'In Rainbows',
    year: 2007, originalYear: null, isCompilation: false, eraUntrusted: false,
  });
  const t = db.getTrack('ord')!;
  assert.equal(t.yearUntrusted, false);
  assert.equal(resolveEraYear(t.year, t.originalYear, t.yearUntrusted), 2007);
  assert.equal(needsOriginalYearLookup(t), false);
  assert.ok(!db.idsNeedingOriginalYear().includes('ord'));
});

test('a row never re-walked since the migration behaves exactly as it did', () => {
  // era_untrusted NULL and is_compilation NULL — the upgrade must be
  // byte-identical until a walk has run.
  db.upsertTrackMeta('legacy', {
    title: 'Old Row', artist: 'Someone', album: 'Some Album', year: 1994,
  });
  const t = db.getTrack('legacy')!;
  assert.equal(t.eraUntrusted, null);
  assert.equal(t.yearUntrusted, null);
  assert.equal(resolveEraYear(t.year, t.originalYear, t.yearUntrusted), 1994);
});

test('the override writes the operator answer and stamps the source', () => {
  db.setManualOriginalYear('t1', 1964);
  const t = db.getTrack('t1')!;
  assert.equal(t.originalYear, 1964);
  assert.equal(t.originalYearSource, 'manual');
  assert.equal(resolveEraYear(t.year, t.originalYear, t.yearUntrusted), 1964);

  // Search/recent rows are shaped from library.get(), not the browse record.
  // If this projection drops either field, the shared editor claims the file
  // year is authoritative and offers no way to clear a persisted override.
  const admin = library.get('t1');
  assert.equal(admin.originalYearSource, 'manual');
  assert.equal(admin.eraUntrusted, true);
});

test('a later library walk does NOT clobber the override', () => {
  // The load-bearing case. Every walk re-upserts every track with the album
  // tag's year; without the IN ('musicbrainz','manual') guard this write puts
  // 2012 back and the operator's correction lasts until the next rescan.
  seedAnthologyTrack('t1');
  const t = db.getTrack('t1')!;
  assert.equal(t.originalYear, 1964);
  assert.equal(t.originalYearSource, 'manual');
});

test('the MusicBrainz writer does NOT clobber the override either', () => {
  db.setOriginalYear('t1', 1971);
  const t = db.getTrack('t1')!;
  assert.equal(t.originalYear, 1964);
  assert.equal(t.originalYearSource, 'manual');
});

test('an overridden track is not owed a lookup, and is not in the backfill set', () => {
  const t = db.getTrack('t1')!;
  assert.equal(needsOriginalYearLookup(t), false);
  assert.equal(needsOriginalYearLookup(t, true), false, 're-enrich must not re-open a manual answer');
  assert.ok(!db.idsNeedingOriginalYear(true).includes('t1'));
});

test('clearing REMOVES the override rather than pinning "unknown"', () => {
  db.setManualOriginalYear('t1', null);
  const t = db.getTrack('t1')!;
  assert.equal(t.originalYear, null);
  assert.equal(t.originalYearSource, null);
  assert.equal(t.originalYearCheckedAt, null, 'a cleared row must look un-asked, not asked-and-missed');
});

test('after clearing, the automatic pipeline owns the track again', () => {
  // The point of clearing being a REMOVE: "I was wrong about this one" has to
  // be recoverable without a library reset. The track goes back to unresolved
  // and era-suspect, i.e. queued for a lookup — not back to the wrong 2012.
  seedAnthologyTrack('t1');
  const t = db.getTrack('t1')!;
  assert.equal(t.originalYear, null);
  assert.equal(t.originalYearSource, null);
  assert.equal(needsOriginalYearLookup(t), true);
  assert.equal(db.resolvedEraYearForTrack('t1'), null,
    'an API response must read the stored suspect verdict instead of trusting the request body');
});

test('clearing only removes an actual override — a resolved sibling is untouched', () => {
  // The album-wide clear (applyToAlbum) runs setManualOriginalYear(null) over
  // EVERY album track. A sibling holding a 'musicbrainz' or informative
  // 'album-tag' year was RESOLVED, not overridden — nulling it would read as
  // unknown-year everywhere until a manual enrichment pass.
  db.upsertTrackMeta('sib-mb', {
    title: 'Sibling A', artist: 'Wendy Rene', album: 'After Laughter Comes Tears',
    year: 2012, originalYear: null, isCompilation: true,
  });
  db.setOriginalYear('sib-mb', 1964);
  db.upsertTrackMeta('sib-tag', {
    title: 'Sibling B', artist: 'Wendy Rene', album: 'After Laughter Comes Tears',
    year: 2015, originalYear: 1973, isCompilation: false,
  });

  db.setManualOriginalYear('sib-mb', null);
  db.setManualOriginalYear('sib-tag', null);

  const mb = db.getTrack('sib-mb')!;
  assert.equal(mb.originalYear, 1964);
  assert.equal(mb.originalYearSource, 'musicbrainz');
  assert.ok(mb.originalYearCheckedAt, 'the MB stamp survives so passes still skip it');
  const tag = db.getTrack('sib-tag')!;
  assert.equal(tag.originalYear, 1973);
  assert.equal(tag.originalYearSource, 'album-tag');
});

test('a genuine compilation still reaches MusicBrainz, and MB still wins over the tag', () => {
  // Guard against fixing #1418 by breaking #842: the existing path is
  // untouched for albums Navidrome DOES flag.
  db.upsertTrackMeta('t2', {
    title: 'Le Freak', artist: 'Chic', album: '100 Hits: 70s Chartbusters',
    year: 2013, originalYear: null, isCompilation: true,
  });
  const before = db.getTrack('t2')!;
  assert.equal(needsOriginalYearLookup(before), true);
  assert.equal(resolveEraYear(before.year, before.originalYear, before.yearUntrusted), null,
    'an unresolved compilation reads as unknown, not 2013');

  db.setOriginalYear('t2', 1978);
  const after2 = db.getTrack('t2')!;
  assert.equal(after2.originalYear, 1978);
  assert.equal(after2.originalYearSource, 'musicbrainz');

  // ...and the walk cannot undo that either.
  db.upsertTrackMeta('t2', {
    title: 'Le Freak', artist: 'Chic', album: '100 Hits: 70s Chartbusters',
    year: 2013, originalYear: 2013, isCompilation: true,
  });
  assert.equal(db.getTrack('t2')!.originalYear, 1978);
});

test('a manual override outranks an existing MusicBrainz answer', () => {
  // MB reads a recording's first-release-date, which is right far more often
  // than not — but the operator is holding the sleeve.
  db.setManualOriginalYear('t2', 1977);
  const t = db.getTrack('t2')!;
  assert.equal(t.originalYear, 1977);
  assert.equal(t.originalYearSource, 'manual');
});

test('a checked-but-missed row is still reachable by the override', () => {
  // The path an operator actually hits after a re-enrich pass came back empty.
  db.upsertTrackMeta('t3', {
    title: 'Unknown Cut', artist: 'V/A', album: 'Rarities',
    year: 2015, originalYear: null, isCompilation: true,
  });
  db.setOriginalYear('t3', null); // MB asked, found nothing, stamped the miss
  const missed = db.getTrack('t3')!;
  assert.equal(missed.originalYear, null);
  assert.ok(missed.originalYearCheckedAt, 'the miss is stamped so passes skip it');
  assert.equal(needsOriginalYearLookup(missed), false);

  db.setManualOriginalYear('t3', 1969);
  assert.equal(db.getTrack('t3')!.originalYear, 1969);
  assert.equal(db.getTrack('t3')!.originalYearSource, 'manual');
});

// ── migration 21's data change ───────────────────────────────────────────────
// The one statement in #1418 that deletes something an operator already has.
// What it SPARES matters as much as what it clears, so both directions are
// pinned. Called directly rather than by re-running the migration: the test DB
// is already at the current version, and the helper exists precisely so this
// SQL is reachable.

test('the migration clears an album-tag year that only echoes the release year', () => {
  db.upsertTrackMeta('m1', { title: 'Echo', artist: 'A', album: 'Ordinary', year: 2007, originalYear: 2007 });
  assert.equal(db.getTrack('m1')!.originalYearSource, 'album-tag');

  db.clearEchoedAlbumTagYears(db.requireDb());

  const t = db.getTrack('m1')!;
  assert.equal(t.originalYear, null);
  assert.equal(t.originalYearSource, null, 'no provenance left claiming a value that is gone');
  // Behaviour-neutral: a trusted album falls through to the identical year.
  assert.equal(resolveEraYear(t.year, t.originalYear, t.yearUntrusted), 2007);
});

test('the migration SPARES an album-tag year that carries real reissue information', () => {
  // The 995-row case on the reported library — the tag genuinely knew better
  // than the file. Throwing these away would be a regression, not a cleanup.
  db.upsertTrackMeta('m2', { title: 'Reissued', artist: 'B', album: 'Remaster', year: 2015, originalYear: 1973 });
  db.clearEchoedAlbumTagYears(db.requireDb());
  assert.equal(db.getTrack('m2')!.originalYear, 1973);
  assert.equal(db.getTrack('m2')!.originalYearSource, 'album-tag');
});

test('the migration SPARES a musicbrainz answer that happens to equal the file year', () => {
  db.upsertTrackMeta('m3', { title: 'Resolved', artist: 'C', album: 'Comp', year: 1978, isCompilation: true });
  db.setOriginalYear('m3', 1978); // MB agreed with the file — resolved, not echoed
  db.clearEchoedAlbumTagYears(db.requireDb());
  assert.equal(db.getTrack('m3')!.originalYear, 1978);
  assert.equal(db.getTrack('m3')!.originalYearSource, 'musicbrainz');
});

test('the migration SPARES a manual override that equals the file year', () => {
  db.upsertTrackMeta('m4', { title: 'Hand-set', artist: 'D', album: 'Odd', year: 1969 });
  db.setManualOriginalYear('m4', 1969);
  db.clearEchoedAlbumTagYears(db.requireDb());
  assert.equal(db.getTrack('m4')!.originalYear, 1969);
  assert.equal(db.getTrack('m4')!.originalYearSource, 'manual');
});

test('an era change keeps the old vector usable but schedules a text-vector refresh', () => {
  db.upsertTrackMeta('dirty-era', {
    title: 'Old Recording', artist: 'Someone', album: 'Later Anthology',
    year: 2012, isCompilation: false, eraUntrusted: false,
  });
  db.upsertTrackVector('dirty-era', new Array(768).fill(0.01), 2012);

  // A later walk discovers that the release year is not a trustworthy
  // recording year. The old vector must remain searchable until the embed pass
  // replaces it, but that pass must no longer mistake "has a vector" for
  // "this vector reflects the current era".
  db.upsertTrackMeta('dirty-era', {
    title: 'Old Recording', artist: 'Someone', album: 'Later Anthology',
    year: 2012, isCompilation: false, eraUntrusted: true,
  });

  assert.equal(db.hasVector('dirty-era'), true, 'the last usable vector stays in the KNN index');
  assert.ok(db.textVectorDirtyIds().includes('dirty-era'), 'the next embed pass is told to replace the stale vector');

  db.upsertTrackVector('dirty-era', new Array(768).fill(0.02), null);
  assert.ok(!db.textVectorDirtyIds().includes('dirty-era'), 'a successful replacement clears the marker');
});

test('an embed built before an era change cannot clear the newer refresh marker', () => {
  db.upsertTrackMeta('embed-race', {
    title: 'Old Recording', artist: 'Someone', album: 'Later Anthology',
    year: 2012, isCompilation: false, eraUntrusted: false,
  });
  db.upsertTrackVector('embed-race', new Array(768).fill(0.01), 2012);

  // phaseEmbed snapshots the row before awaiting the external embedding
  // service. The operator changes the era while that await is in flight.
  const staleEraYear = resolveEraYear(2012, null, false);
  db.setManualOriginalYear('embed-race', 1964);
  assert.ok(db.textVectorDirtyIds().includes('embed-race'));

  // Completion of the stale request may replace the vector, but it must leave
  // the marker set so the next pass repairs it. Unconditionally clearing here
  // loses the only durable record that the vector still describes 2012.
  db.upsertTrackVector('embed-race', new Array(768).fill(0.02), staleEraYear);
  assert.ok(db.textVectorDirtyIds().includes('embed-race'));
});

test('seed decade bucketing uses the same unresolved-era rule as show filtering', () => {
  db.upsertTrackMeta('unresolved-decade', {
    title: 'Old Recording', artist: 'Someone', album: '2012 Anthology',
    year: 2012, originalYear: null, isCompilation: false, eraUntrusted: true,
  });

  const buckets = db.trackIdsByGenreDecade();
  assert.ok(buckets.get('|0')?.includes('unresolved-decade'), 'unknown era belongs in the unknown bucket');
  assert.ok(!buckets.get('|2010')?.includes('unresolved-decade'), 'the reissue year must not become the recording decade');
});

test('migration 22 backfills the refresh marker ONLY where the era text changed', async () => {
  // The text an embed carries has resolved through resolveEraYear(year,
  // originalYear, isCompilation) since before #1418, and original_year wins
  // before any flag is consulted — so the only vectors #1418 made stale are
  // UNRESOLVED rows the new era_untrusted verdict flipped to unknown-era.
  // Marking a resolved row schedules a re-embed of byte-identical text; on a
  // real library that was every originalYear/compilation row at once.
  // Embedded while trusted, then a walk stamps the era verdict — the #1418
  // sequence that happened on v21 DBs before the marker column existed.
  db.upsertTrackMeta('pre-v22-stale', {
    title: 'Unresolved Anthology Cut', artist: 'Someone', album: 'Singles 1968-1974',
    year: 2015, originalYear: null, isCompilation: false, eraUntrusted: false,
  });
  db.upsertTrackVector('pre-v22-stale', new Array(768).fill(0.04), 2015);
  db.upsertTrackMeta('pre-v22-stale', {
    title: 'Unresolved Anthology Cut', artist: 'Someone', album: 'Singles 1968-1974',
    year: 2015, originalYear: null, isCompilation: false, eraUntrusted: true,
  });
  db.upsertTrackMeta('pre-v22-vector', {
    title: 'Resolved Recording', artist: 'Someone', album: 'Later Reissue',
    year: 2012, originalYear: 1964, isCompilation: false,
  });
  db.upsertTrackVector('pre-v22-vector', new Array(768).fill(0.03), 1964);
  assert.ok(!db.textVectorDirtyIds().includes('pre-v22-vector'));

  // Recreate the on-disk shape an installation already running PR #1431 can
  // have: schema 21, a populated vec index, and no dirty-marker column yet.
  const d = db.requireDb();
  d.prepare(`ALTER TABLE tracks DROP COLUMN text_vector_dirty`).run();
  d.pragma('user_version = 21');
  db.close();
  await db.open({ embeddingDim: 768, adoptStoredDim: true });

  assert.ok(db.textVectorDirtyIds().includes('pre-v22-stale'),
    'upgrade schedules a replacement instead of permanently accepting the old era text');
  assert.ok(!db.textVectorDirtyIds().includes('pre-v22-vector'),
    'a resolved row embeds the same Era: text before and after — marking it is a pointless mass re-embed');
  assert.equal(db.hasVector('pre-v22-stale'), true, 'the upgrade does not create a KNN hole');
});

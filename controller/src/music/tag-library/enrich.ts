// Phase 0 - enrichment: Last.fm tags (artist-level, plus the opt-in track-level
// lookups), lyric excerpts, and MusicBrainz original-year resolution for
// compilation tracks. See ../tag-library.ts for main().

import * as subsonic from '../subsonic.js';
import * as lastfm from '../lastfm.js';
import * as musicbrainz from '../musicbrainz.js';
import * as db from '../library-db.js';
import * as settings from '../../settings.js';
import { createLastfmPacer, type LastfmPacer } from '../lastfm-pacer.js';
import { selectTrackTagIds } from '../enrich-scope.js';
import { listAfterArtistLookup } from '../lastfm-tag-policy.js';
import { reportProgress } from '../tagger-progress.js';
import { mapPool, memoizeByKey } from '../../util/async-pool.js';
import { logEvent } from './log.js';

export async function phaseEnrich(
  ids: string[],
  reEnrich: boolean,
  limit: number = Infinity,
): Promise<void> {
  const enrichCfg = (settings.get() as any).embedding?.enrichment ?? {};
  // With a Last.fm api_key we hit the API directly (it returns tags); the
  // tri-state gate keeps keyless installs off the tag-less getArtistInfo2 path.
  const hasKey = lastfm.hasLastfmKey();
  const lastfmEnabled = lastfm.lastfmEnrichEnabled(enrichCfg.lastfmTags, hasKey);
  const trackTagsOn = lastfm.lastfmTrackTagsEnabled(enrichCfg, hasKey);
  const lyricsEnabled = enrichCfg.lyrics !== false;
  // Scoped in SQL, not by the tagger's untagged/enriched id set: gating on the
  // enrich scope would never backfill an already-tagged library.
  const yearIds = pendingOriginalYearIds(reEnrich);
  const trackTagIds = trackTagsOn
    ? selectTrackTagIds({ reEnrich, limit, ids, owed: db.idsNeedingLastfmTrackTags() })
    : [];
  if (ids.length === 0 && yearIds.length === 0 && trackTagIds.length === 0) return;
  if (!lastfmEnabled && !lyricsEnabled && yearIds.length === 0) {
    console.log('[tag] phase-0 skipped: lastfmTags and lyrics disabled, no original-year lookups pending');
    return;
  }
  if (lastfmEnabled) {
    const methods = trackTagsOn ? 'track.getTopTags + artist.getTopTags' : 'artist.getTopTags';
    console.log(
      `[tag] phase-0 Last.fm tags via ${hasKey ? `direct API (${methods})` : 'Navidrome getArtistInfo2 (no api_key — likely empty)'}`,
    );
  }
  reportProgress({ phase: 'enrich', label: 'Enriching metadata', done: 0, total: ids.length });
  // Memoize on the in-flight PROMISE, not the value, so the pool below shares one
  // API call per artist.
  const artistTags = memoizeByKey<string[]>(artist =>
    lastfm.getArtistTags(artist, { count: 10 }).then(t => t ?? []).catch(() => []),
  );

  let enrichedTracks = 0;
  let enrichedLyrics = 0;
  let enrichedTags = 0;
  let enrichedYears = 0;

  // I/O-bound, so drain with a bounded pool. DB writes are synchronous
  // (better-sqlite3) and so serialise on the event loop without locking.
  const concurrency = Math.max(
    1,
    Math.min(32, parseInt(process.env.TAG_ENRICH_CONCURRENCY || '', 10) || 6),
  );

  // Skip the loop when both are disabled: running it would stamp enrichedAt on
  // empty rows and mask a later re-enable.
  const metaIds = lastfmEnabled || lyricsEnabled ? ids : [];
  await mapPool(metaIds, concurrency, async (id) => {
    const t = db.getTrack(id);
    if (!t) return;
    if (!reEnrich && t.enrichedAt) return;

    // The track pass below owns a stored list on this path. It must find the row
    // as it stands: an artist-only rewrite here would read as a change to every
    // row it re-merged, and an outage would lose the merged list. A row with no
    // list still gets the artist's, as it would with track tags off. The pass can
    // end short of it, this write marks it enriched so no later run fills it, and
    // a never-play rule on the act would miss it. The pass adds to what it finds.
    // With track tags off the artist is asked every time the row is visited, and only tags replace
    // the list (listAfterArtistLookup, Retag's rule too): an outage, an empty
    // answer or Last.fm tags off leave it as it was (#2295).
    let lastfmTags: string[] | null = t.lastfmTags;
    let fetchedTags = false;
    if (lastfmEnabled && t.artist && (!trackTagsOn || !lastfmTags?.length)) {
      const tags = await artistTags(t.artist);
      fetchedTags = tags.length > 0;
      lastfmTags = listAfterArtistLookup(lastfmTags, tags);
    }

    let lyricExcerpt: string | null = null;
    if (lyricsEnabled) {
      try {
        const raw = await subsonic.getLyrics(id);
        if (typeof raw === 'string' && raw.trim()) {
          lyricExcerpt = raw.trim();
        }
      } catch { /* ignore */ }
    }

    db.upsertTrackEnrichment(id, { lastfmTags, lyricExcerpt });
    enrichedTracks += 1;
    if (!trackTagsOn && fetchedTags) enrichedTags += 1;
    if (lyricExcerpt) enrichedLyrics += 1;
    if (enrichedTracks % 100 === 0) {
      console.log(
        `[tag] enriched ${enrichedTracks}/${metaIds.length} (lastfm: ${enrichedTags}, lyrics: ${enrichedLyrics})`,
      );
      reportProgress({ phase: 'enrich', label: 'Enriching metadata', done: enrichedTracks, total: metaIds.length });
    }
  });

  enrichedTags += await backfillLastfmTrackTags(trackTagIds, concurrency);
  enrichedYears = await backfillOriginalYears(yearIds, reEnrich, concurrency);

  logEvent(
    'info',
    `Metadata fetched for ${enrichedTracks.toLocaleString('en-GB')} tracks ` +
      `(${enrichedTags} Last.fm, ${enrichedLyrics} lyrics, ${enrichedYears} original years)`,
  );
}

// Track-level Last.fm tags, opt-in (embedding.enrichment.lastfmTrackTags). One
// call per song, so unlike the memoised artist call this is a pass of its own:
// paced across the pool (lastfm-pacer.ts) and resumable. Every row it answers is
// stamped, hit or miss, and a failure stamps nothing, so a stopped or failed pass
// picks up where it left off (lastfm_track_tags_at). Runs over the whole of its
// scope rather than inside the loop above, since most of a backfill is rows that
// loop never sees. Returns the rows that ended up with a list.
export async function backfillLastfmTrackTags(
  ids: string[],
  concurrency: number,
  pacer: LastfmPacer = createLastfmPacer(),
): Promise<number> {
  if (!ids.length) return 0;
  console.log(`[tag] track tags: ${ids.length} tracks to look up via Last.fm (~4/s)`);
  reportProgress({ phase: 'enrich', label: 'Fetching track tags', done: 0, total: ids.length });
  const source = lastfm.pacedTagSource(pacer);
  let checked = 0;
  let answered = 0;
  let ownTags = 0;
  let listed = 0;
  let unaskable = 0;
  await mapPool(ids, Math.min(concurrency, 4), async (id) => {
    if (pacer.gaveUp) return;
    const t = db.getTrack(id);
    if (!t?.artist || !t.title) {
      unaskable += 1;
      return;
    }
    const merged = await lastfm.getMergedTags(t.artist, t.title, { count: 10, source });
    const stored = db.recordLastfmTrackTags(id, merged);
    checked += 1;
    if (merged.answered) answered += 1;
    if (merged.answered && merged.trackTagCount > 0) ownTags += 1;
    if (stored) listed += 1;
    if (checked % 100 === 0) {
      console.log(`[tag] track tags ${checked}/${ids.length} (${ownTags} with their own tags)`);
      reportProgress({ phase: 'enrich', label: 'Fetching track tags', done: checked, total: ids.length });
    }
  });
  const left = ids.length - answered - unaskable;
  logEvent(
    pacer.gaveUp ? 'warning' : 'info',
    `Last.fm track tags: ${answered.toLocaleString('en-GB')} tracks answered, ` +
      `${ownTags.toLocaleString('en-GB')} with tags of their own` +
      (pacer.gaveUp
        ? ` — Last.fm stopped answering, ${left.toLocaleString('en-GB')} left for the next run`
        : left > 0 ? `, ${left.toLocaleString('en-GB')} left for the next run` : ''),
  );
  return listed;
}

// Ids still owed a MusicBrainz original-year lookup (#842). Keyless, so default-on;
// [] when settings.embedding.enrichment.originalYear is false.
export function pendingOriginalYearIds(retryMisses: boolean): string[] {
  const enrichCfg = (settings.get() as any).embedding?.enrichment ?? {};
  if (enrichCfg.originalYear === false) return [];
  return db.idsNeedingOriginalYear(retryMisses);
}

// Original-year backfill (#842) for era-suspect tracks whose `year` is the
// reissue's release date. Effectively serial whatever the pool width (MusicBrainz
// throttles to 1 req/s), so every track gets a checked_at stamp on hit OR miss to
// keep later passes cheap. Also run by --reconcile-only: that walk stamps
// era_untrusted and clears stale album-tag years, so it must re-answer them
// (#1418). Returns the number of years resolved.
export async function backfillOriginalYears(
  yearIds: string[],
  retryMisses: boolean,
  concurrency: number,
): Promise<number> {
  if (!yearIds.length) return 0;
  let resolvedYears = 0;
  console.log(`[tag] original years: ${yearIds.length} era-suspect tracks to resolve via MusicBrainz (~1/s)`);
  reportProgress({ phase: 'enrich', label: 'Resolving original years', done: 0, total: yearIds.length });
  let checkedYears = 0;
  await mapPool(yearIds, Math.min(concurrency, 4), async (id) => {
    const t = db.getTrack(id);
    if (!t || !musicbrainz.needsOriginalYearLookup(t, retryMisses)) return;
    let mbid: string | null = null;
    try {
      mbid = (await subsonic.getSong(id))?.musicBrainzId || null;
    } catch { /* MBID is optional — the search path covers it */ }
    const year = await musicbrainz.lookupOriginalYear({ title: t.title, artist: t.artist, mbid, year: t.year });
    db.setOriginalYear(id, year);
    if (year != null) resolvedYears += 1;
    checkedYears += 1;
    if (checkedYears % 25 === 0) {
      console.log(`[tag] original years ${checkedYears}/${yearIds.length} (${resolvedYears} resolved)`);
      reportProgress({ phase: 'enrich', label: 'Resolving original years', done: checkedYears, total: yearIds.length });
    }
  });
  return resolvedYears;
}


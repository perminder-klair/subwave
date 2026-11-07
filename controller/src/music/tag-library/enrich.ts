// Phase 0 - enrichment: Last.fm tags (artist-level, plus the opt-in track-level
// lookups), lyric excerpts, and MusicBrainz original-year resolution for
// compilation tracks. See ../tag-library.ts for main().

import * as subsonic from '../subsonic.js';
import * as lastfm from '../lastfm.js';
import { runYearLookups } from '../original-year.js';
import * as db from '../library-db.js';
import * as settings from '../../settings.js';
import { createLastfmPacer, type LastfmPacer } from '../lastfm-pacer.js';
import { selectTrackTagIds } from '../enrich-scope.js';
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
  const yearIds = pendingOriginalYearIds(reEnrich, ids);
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
    let lastfmTags: string[] | null = trackTagsOn ? t.lastfmTags : null;
    if (lastfmEnabled && t.artist && !lastfmTags?.length) {
      const tags = await artistTags(t.artist);
      if (tags.length) lastfmTags = tags;
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
    if (!trackTagsOn && lastfmTags && lastfmTags.length) enrichedTags += 1;
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

// Ids owed a MusicBrainz original-year lookup (#842). Keyless, so default-on;
// [] when settings.embedding.enrichment.originalYear is false.
//
// Always the year facet's due set: tracks never asked, and failed lookups past
// their retry delay (original-year-policy.ts), library-wide. An answered "not
// found" is settled and is re-asked only by `--facets year --where
// unmeasurable` — or, with `retryMisses` (--re-enrich), for the misses inside
// `scope`, the run's own tracks. Never every miss in the library.
export function pendingOriginalYearIds(retryMisses: boolean, scope: readonly string[] = []): string[] {
  const enrichCfg = (settings.get() as any).embedding?.enrichment ?? {};
  if (enrichCfg.originalYear === false) return [];
  const due = db.yearLookupDueIds(Date.now());
  if (!retryMisses) return due;
  const inScope = new Set(scope);
  const seen = new Set(due);
  const misses = db.idsNeedingOriginalYear(true).filter(id => inScope.has(id) && !seen.has(id));
  return [...due, ...misses];
}

// Original-year backfill (#842) for era-suspect tracks whose `year` is the
// reissue's release date. Also run by --reconcile-only: that walk stamps
// era_untrusted and clears stale album-tag years, so it must answer the tracks
// it has just made suspect (#1418). `retryMisses` lets the run's own misses be
// asked again (see pendingOriginalYearIds). Returns the number resolved.
export async function backfillOriginalYears(
  yearIds: string[],
  retryMisses: boolean,
  concurrency: number,
): Promise<number> {
  const stats = await runYearLookups(yearIds, { force: retryMisses, concurrency });
  return stats.found;
}

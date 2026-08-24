// CLI arg parsing and the pre-flight passes that run before any phase: walking
// Navidrome, reconciling deleted tracks, and folding the wizard's overlay in.
//
// Part of the tag-library/ split - see ../tag-library.ts for main().

import * as subsonic from '../subsonic.js';
import * as db from '../library-db.js';
import * as embeddings from '../embeddings.js';
import { config } from '../../config.js';
import { loadSecretsIntoEnv } from '../../setup/secrets.js';
import { loadSetupConfig } from '../../setup/config.js';
import { reportProgress } from '../tagger-progress.js';
import { logEvent } from './log.js';
import { backfillOriginalYears, pendingOriginalYearIds } from './enrich.js';


// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseIntFlag(args: string[], name: string): number | null {
  const idx = args.indexOf(name);
  if (idx < 0) return null;
  const n = parseInt(args[idx + 1], 10);
  return Number.isFinite(n) ? n : null;
}

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

interface CliFlags {
  limit: number;
  batchSize: number | null;
  seedCount: number | null;
  maxRounds: number | null;
  noPropagate: boolean;
  reseed: boolean;
  reEnrich: boolean;
  skipEnrich: boolean;
  upgrade: boolean;
  skipAnalyze: boolean;
  reAnalyze: boolean;
  reconcileOnly: boolean;
  // Skip embed + mood tagging (phases 1-4). Walk, enrich and analyze still run
  // per their own flags — the admin "Tag moods" step unchecked.
  skipTag: boolean;
  // Walk Navidrome but don't prune orphaned rows — the admin "Reconcile with
  // Navidrome" step unchecked. (A normal run prunes by default.)
  noPrune: boolean;
  // Per-run override of the Demucs vocal-activity backfill in Phase 5. --vocal
  // forces it on, --no-vocal forces it off; neither falls back to the setting
  // (settings.audio.vocalActivity / ANALYZE_VOCAL_ACTIVITY). The admin Run tab's
  // "Vocal activity" sub-checkbox drives these so a run can do bpm/key + CLAP
  // without the slow Demucs pass (or include it) without touching the setting.
  vocal: boolean;
  noVocal: boolean;
  // Re-scan mode (admin Re-scan tab). Fire ONLY the selected re-* passes, each
  // scoped to already-done tracks; the forward seed→propagate→active-learn
  // discovery is suppressed so the untagged remainder is never processed. Raw CLI
  // re-* flags (no --rescan) keep their documented per-flag, full-library meaning.
  rescan: boolean;
}

export function parseFlags(): CliFlags {
  const args = process.argv.slice(2);
  // null = no --batch flag → fall back to settings.embedding.batchSize in main().
  const rawBatch = parseIntFlag(args, '--batch');
  return {
    limit: parseIntFlag(args, '--limit') ?? Infinity,
    batchSize: rawBatch !== null ? Math.max(1, Math.min(50, rawBatch)) : null,
    seedCount: parseIntFlag(args, '--seeds'),
    // null = fall back to settings.embedding.maxActiveLearningRounds
    maxRounds: parseIntFlag(args, '--max-rounds'),
    noPropagate: args.includes('--no-propagate'),
    reseed: args.includes('--reseed'),
    reEnrich: args.includes('--re-enrich'),
    skipEnrich: args.includes('--skip-enrich'),
    // Re-decide moods: re-LLM-tag tagged rows whose prompt/model went stale. Row
    // selection (db.staleTaggedIds) excludes source='manual' — operator-set tags
    // are ground truth and never go stale with prompt/model changes.
    upgrade: args.includes('--upgrade'),
    skipAnalyze: args.includes('--skip-analyze'),
    reAnalyze: args.includes('--re-analyze'),
    // Walk Navidrome and prune library rows for tracks it no longer contains,
    // then exit — no embeddings, no LLM. The admin "Reconcile with Navidrome"
    // button drives this so orphaned entries can be cleared without paying for
    // a full tag/analyze pass (works even at 100% coverage).
    reconcileOnly: args.includes('--reconcile-only'),
    skipTag: args.includes('--skip-tag'),
    noPrune: args.includes('--no-prune'),
    vocal: args.includes('--vocal'),
    noVocal: args.includes('--no-vocal'),
    rescan: args.includes('--rescan'),
  };
}

// Walk the entire Navidrome catalogue, upserting each song's metadata into the
// tracks table and collecting the live id set. Shared by the full tagger run
// (Phase A) and the standalone --reconcile-only path. Cheap: metadata only, no
// embeddings or LLM calls.
// The album tag's year, but only when it actually says something (#1418).
// See the call site for why each half matters.
function informativeAlbumYear(song: {
  albumEraUntrusted?: boolean | null;
  albumOriginalYear?: number | null;
  year?: number | null;
}): number | null {
  if (song.albumEraUntrusted) return null;
  const ord = song.albumOriginalYear ?? null;
  if (ord == null) return null;
  return ord === (song.year ?? null) ? null : ord;
}

export async function walkNavidrome(): Promise<{ walked: number; liveIds: Set<string> }> {
  reportProgress({ phase: 'walk', label: 'Scanning Navidrome library', done: 0 });
  let walked = 0;
  const liveIds = new Set<string>();
  // Blast radius of the widened era gate, reported once at the end. An
  // operator who sees a third of their library go era-suspect should be able
  // to see that from the log rather than from a show that stopped picking —
  // the detector is precision-tuned, and this is the number that says whether
  // it stayed that way on a real catalogue (#1418).
  const eraReasons = new Map<string, number>();
  for await (const song of subsonic.iterateAllSongs()) {
    db.upsertTrackMeta(song.id, {
      title: song.title,
      artist: song.artist,
      album: song.album,
      year: song.year,
      // Album-level era signals (issues #842, #1418). The album's
      // originalReleaseDate is a track's original year only when it is
      // INFORMATIVE, which needs two things to be true:
      //
      //  - the album is not era-suspect. On a reissue anthology the album's
      //    "original" date is the reissue's own (both reported examples read
      //    originalReleaseDate == releaseDate == year), so recording it states
      //    the wrong year with full confidence AND hides the track from the
      //    MusicBrainz pass, which skips anything already resolved.
      //  - it differs from the file's `year`. When the two are equal the tag
      //    has told us nothing — that was 18,492 rows of the reported library,
      //    every one of them looking resolved. Leaving it NULL is
      //    behaviour-neutral (resolveEraYear falls through to the identical
      //    `year` for a trusted album) and makes the track eligible for a
      //    lookup that can actually answer.
      originalYear: informativeAlbumYear(song),
      isCompilation: song.albumIsCompilation ?? null,
      eraUntrusted: song.albumEraUntrusted ?? null,
      genres: subsonic.songGenres(song),
      duration: song.duration,
    });
    liveIds.add(song.id);
    if (song.albumEraUntrusted && song.albumEraReason) {
      eraReasons.set(song.albumEraReason, (eraReasons.get(song.albumEraReason) ?? 0) + 1);
    }
    walked += 1;
    if (walked % 500 === 0) {
      console.log(`[tag] walked ${walked} tracks`);
      reportProgress({ phase: 'walk', label: 'Scanning Navidrome library', done: walked });
    }
  }
  logEvent('info', `Scanned ${walked.toLocaleString('en-GB')} tracks`);
  const suspect = [...eraReasons.values()].reduce((a, b) => a + b, 0);
  if (suspect) {
    const breakdown = [...eraReasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, n]) => `${reason} ${n.toLocaleString('en-GB')}`)
      .join(', ');
    logEvent('info',
      `${suspect.toLocaleString('en-GB')} tracks on era-suspect albums (${breakdown})` +
      ' — their release year is treated as the reissue\'s, and they are queued for an original-year lookup');
  }
  return { walked, liveIds };
}

// Standalone reconcile: diff library-db against the live Navidrome catalogue and
// drop rows (and their vectors) for tracks that are gone. No embedding preflight
// and no LLM — opens the existing DB at its stored dim so vectors are untouched.
//
// The walk it shares with the full run is not read-only: it stamps
// era_untrusted on suspect albums and clears their stale album-tag years
// (#1418), which makes those tracks read as unknown-year until something asks
// MusicBrainz. That something used to be only phase-0 of a full tag pass —
// which nothing schedules — so a reconcile could open an unbounded window of
// unknown-year tracks. Hence the backfill below: keyless, checked_at-stamped
// (incremental — later reconciles skip straight past answered tracks), and
// throttled at MB's 1 req/s, so only the first pass after an upgrade is slow.
export async function reconcileOnly() {
  await db.open({ embeddingDim: embeddings.resolveEmbeddingDim(), adoptStoredDim: true });
  console.log('[tag] reconcile-only: walking Navidrome to prune orphaned rows');
  const { walked, liveIds } = await walkNavidrome();
  let pruned = 0;
  if (walked > 0) {
    pruned = db.pruneMissingTracks(liveIds);
    console.log(`[tag] reconcile pruned ${pruned} orphaned tracks no longer in Navidrome`);
    const resolved = await backfillOriginalYears(pendingOriginalYearIds(false), false, 4);
    if (resolved) console.log(`[tag] reconcile resolved ${resolved} original years via MusicBrainz`);
  } else {
    // A transient empty Navidrome response must never wipe the DB.
    console.warn('[tag] reconcile: Navidrome returned 0 tracks — skipping prune');
  }
  reportProgress({
    phase: 'done',
    label: pruned > 0
      ? `Removed ${pruned} track${pruned === 1 ? '' : 's'} no longer in Navidrome`
      : 'Library is in sync with Navidrome',
    done: pruned,
  });
  console.log(`[tag] reconcile complete (walked ${walked}, pruned ${pruned})`);
  process.exit(0);
}

// Mirrors server.ts boot: cloud API keys from secrets.env, Navidrome creds
// from setup-config.json. Standalone CLIs skip server.ts, so without this
// they fall back to the hardcoded `http://navidrome:4533` and ENOTFOUND on
// any install with a custom Navidrome host.
export async function applyWizardOverlay() {
  try {
    await loadSecretsIntoEnv();
  } catch (err: any) {
    console.error('[secrets] load failed:', err.message);
  }
  try {
    const sc = await loadSetupConfig();
    if (sc.navidrome) {
      if (!process.env.NAVIDROME_URL && sc.navidrome.url) config.navidrome.url = sc.navidrome.url;
      if (!process.env.NAVIDROME_USER && sc.navidrome.user) config.navidrome.user = sc.navidrome.user;
      if (!process.env.NAVIDROME_PASS && sc.navidrome.pass)
        config.navidrome.password = sc.navidrome.pass;
    }
  } catch (err: any) {
    console.error('[setup-config] load failed:', err.message);
  }
}


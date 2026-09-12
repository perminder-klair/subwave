// CLI arg parsing and the pre-flight passes that run before any phase: walking
// Navidrome, reconciling deleted tracks, and folding the wizard's overlay in.
// See ../tag-library.ts for main().

import * as subsonic from '../source.js';
import * as db from '../library-db.js';
import * as embeddings from '../embeddings.js';
import { config } from '../../config.js';
import { loadSecretsIntoEnv } from '../../setup/secrets.js';
import { loadSetupConfig } from '../../setup/config.js';
import { reportProgress } from '../tagger-progress.js';
import { logEvent } from './log.js';
import { prunePermitted, pruneSkippedLine } from '../prune-policy.js';
import { backfillOriginalYears, pendingOriginalYearIds } from './enrich.js';

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
  // Skip embed + mood tagging (phases 1-4); walk, enrich and analyze still run
  // per their own flags.
  skipTag: boolean;
  // Walk Navidrome but don't prune orphaned rows (a normal run prunes).
  noPrune: boolean;
  // Per-run override of the Phase 5 Demucs vocal-activity backfill. Neither
  // flag falls back to settings.audio.vocalActivity / ANALYZE_VOCAL_ACTIVITY.
  vocal: boolean;
  noVocal: boolean;
  // Re-scan mode: fire ONLY the selected re-* passes, each scoped to
  // already-done tracks, suppressing the forward seed→propagate→active-learn
  // discovery. Raw re-* flags without --rescan keep their full-library meaning.
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
    // Re-decide moods: re-LLM-tag rows whose prompt/model went stale.
    // db.staleTaggedIds excludes source='manual' — operator tags are ground
    // truth and never go stale.
    upgrade: args.includes('--upgrade'),
    skipAnalyze: args.includes('--skip-analyze'),
    reAnalyze: args.includes('--re-analyze'),
    // Walk Navidrome, prune rows for tracks it no longer contains, then exit —
    // no embeddings, no LLM.
    reconcileOnly: args.includes('--reconcile-only'),
    skipTag: args.includes('--skip-tag'),
    noPrune: args.includes('--no-prune'),
    vocal: args.includes('--vocal'),
    noVocal: args.includes('--no-vocal'),
    rescan: args.includes('--rescan'),
  };
}

// The album tag's year, but only when it actually says something (#1418).
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

// Walk the whole Navidrome catalogue, upserting each song's metadata and
// collecting the live id set. Shared by the full tagger run and
// --reconcile-only. Metadata only: no embeddings, no LLM.
export async function walkNavidrome(): Promise<{ walked: number; liveIds: Set<string> }> {
  reportProgress({ phase: 'walk', label: 'Scanning Navidrome library', done: 0 });
  let walked = 0;
  const liveIds = new Set<string>();
  // Blast radius of the era gate, reported once at the end so an operator sees
  // it in the log rather than as a show that stopped picking (#1418).
  const eraReasons = new Map<string, number>();
  for await (const song of subsonic.iterateAllSongs()) {
    db.upsertTrackMeta(song.id, {
      title: song.title,
      artist: song.artist,
      album: song.album,
      // Subsonic ids. The walk is the only writer that has them, and they let
      // an ALBUM/ARTIST blocklist entry match by id rather than by name.
      albumId: song.albumId ?? null,
      artistId: song.artistId ?? null,
      year: song.year,
      // Album-level era signals (#842, #1418). The album's originalReleaseDate
      // is a track's original year only when informative, which needs both:
      //  - the album is not era-suspect (on a reissue anthology that date is
      //    the reissue's own, so recording it states the wrong year AND hides
      //    the track from the MusicBrainz pass, which skips resolved rows);
      //  - it differs from the file's `year` (equal tells us nothing). NULL is
      //    behaviour-neutral — resolveEraYear falls through to `year` for a
      //    trusted album — and keeps the track eligible for a lookup.
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
// The shared walk is not read-only: it stamps era_untrusted on suspect albums
// and clears their stale album-tag years (#1418), leaving those tracks
// unknown-year until MusicBrainz is asked. Hence the backfill below — keyless,
// checked_at-stamped so later reconciles skip answered tracks, and throttled at
// MB's 1 req/s.
export async function reconcileOnly() {
  await db.open({ embeddingDim: embeddings.resolveEmbeddingDim(), adoptStoredDim: true });
  console.log('[tag] reconcile-only: walking Navidrome to prune orphaned rows');
  const { walked, liveIds } = await walkNavidrome();
  let pruned = 0;
  let skipped: string | null = null;
  const decision = prunePermitted({ walked, health: await subsonic.catalogHealth() });
  if (decision.ok) {
    pruned = db.pruneMissingTracks(liveIds);
    console.log(`[tag] reconcile pruned ${pruned} orphaned tracks no longer in the library`);
    const resolved = await backfillOriginalYears(pendingOriginalYearIds(false), false, 4);
    if (resolved) console.log(`[tag] reconcile resolved ${resolved} original years via MusicBrainz`);
  } else {
    // The walk could not be trusted as the complete live set — a transient empty
    // response, or (on a partially-degrading source) a short one. Either way,
    // deleting against it would throw away live tags.
    skipped = pruneSkippedLine(decision.reason);
    console.warn(`[tag] reconcile: ${skipped}`);
  }
  reportProgress({
    phase: 'done',
    // A skipped prune must NOT read as "in sync" — that is the one wording an
    // operator would take as confirmation that nothing needed removing.
    label: skipped
      ? 'Reconcile skipped — the library walk was incomplete, so nothing was removed'
      : pruned > 0
        ? `Removed ${pruned} track${pruned === 1 ? '' : 's'} no longer in the library`
        : 'Library is in sync',
    done: pruned,
  });
  console.log(`[tag] reconcile complete (walked ${walked}, pruned ${pruned})`);
  process.exit(0);
}

// Mirrors server.ts boot: cloud API keys from secrets.env, Navidrome creds from
// setup-config.json. Standalone CLIs skip server.ts, so without this they fall
// back to the hardcoded `http://navidrome:4533`.
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


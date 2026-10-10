// Standalone acoustic-analysis CLI — `npm run analyze`. Runs the analysis pass
// (bpm / key / intro) alone; the same pass is the final phase of `npm run tag`.
// With no analyzer backend the pass is a no-op.
//
//   --limit N      cap tracks analysed this run
//   --re-analyze   drop existing analysis and redo everything
//   --walk         force a Navidrome metadata refresh first
//   --skip-walk    never walk, even on an empty catalogue (wins over --walk)
//   --confirm-prune  allow a walk to remove more missing tracks than
//                  music/prune-policy.ts lets it remove on its own
//   --audio        backfill CLAP vectors on analysed tracks (implied by ANALYZE_AUDIO_EMBEDDING)
//   --vocal        backfill Demucs vocal ranges (implied by ANALYZE_VOCAL_ACTIVITY)
//
// The walk otherwise runs only on an empty catalogue (first-run bootstrap).
//
// Facet mode — scope read from track_facet_status instead of the legacy
// queries (music/acoustics-plan.ts). Never walks; --re-analyze/--audio/--vocal
// are ignored.
//   --facets F[,F]       head, loudness, tail, clap, vocal, stems
//   --where W            needs (default) | missing | unmeasurable[:reason] |
//                        failed | outdated | all
//   --ids a,b,c          restrict to these track ids
//   --ids-file PATH      …or to the ids in a file (one per line, # comments)
//   --limit N            cap the number of tracks planned
//   --dry-run            print the plan and exit: no lock and no analysis. Opening
//                        the DB may still create, seed or re-derive the facet
//                        status table, as any open does.
//
//   e.g. npm run analyze -- --facets clap --where failed --dry-run
//        npm run analyze -- --facets tail --where unmeasurable:capped --limit 200

import * as subsonic from './subsonic.js';
import * as db from './library-db.js';
import * as settings from '../settings.js';
import * as embeddings from './embeddings.js';
import { loadSecretsIntoEnv } from '../setup/secrets.js';
import { loadNavidromeConfig } from '../setup/config.js';
import { runAnalysisPass } from './analyze.js';
import { adoptAndPrune } from './id-rotation.js';
import * as analyzer from './analyzer.js';
import { reportProgress, makeEventLogger } from './tagger-progress.js';
import { readFileSync } from 'node:fs';
import { formatPlan, parseFacets, parseWhere, planAcoustics, type AcousticsPlan } from './acoustics-plan.js';
import { acquireStandaloneLock, installPidfileCleanup } from './tagger-lock.js';

const logEvent = makeEventLogger('analyze');

// TRUNCATE-checkpoint the library DB on every exit path, else this bulk writer
// leaves a huge WAL sidecar (#786). db.close() is synchronous, so 'exit' is safe.
process.on('exit', () => {
  try { if (db.isOpen()) db.close(); } catch { /* best-effort */ }
});

function parseIntFlag(args: string[], name: string): number | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  const n = parseInt(args[idx + 1], 10);
  return Number.isFinite(n) ? n : undefined;
}

// Both maintenance workers use the same connection policy as the controller.
async function applyWizardOverlay() {
  try {
    await loadSecretsIntoEnv();
  } catch (err: any) {
    console.error('[secrets] load failed:', err.message);
  }
  try {
    await loadNavidromeConfig();
  } catch (err: any) {
    console.error('[setup-config] load failed:', err.message);
  }
}

function stringFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  const v = args[idx + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
  return v;
}

// --ids / --ids-file → explicit scope; neither → null (whole catalogue).
function explicitIds(args: string[]): string[] | null {
  const list = stringFlag(args, '--ids');
  const file = stringFlag(args, '--ids-file');
  if (!list && !file) return null;
  const raw = [
    ...(list ? list.split(',') : []),
    ...(file ? readFileSync(file, 'utf8').split(/\r?\n/).map(l => l.replace(/#.*/, '')) : []),
  ];
  return [...new Set(raw.map(s => s.trim()).filter(Boolean))];
}

// Build the facet plan from the DB + whatever the analyzer says it can do.
async function buildFacetPlan(args: string[], limit: number | undefined): Promise<AcousticsPlan> {
  const facets = parseFacets(stringFlag(args, '--facets') ?? '');
  const where = parseWhere(stringFlag(args, '--where'));
  const known = db.allTrackIdsOrdered();
  let ids = known;
  const wanted = explicitIds(args);
  if (wanted) {
    const knownSet = new Set(known);
    ids = wanted.filter(id => knownSet.has(id));
    const unknown = wanted.length - ids.length;
    if (unknown > 0) console.log(`[analyze] ${unknown} of the given ids are not in the library — ignored`);
  }
  // Probe so capabilities are real; an unreachable analyzer leaves them unknown.
  const available = await analyzer.isAvailable().catch(() => false);
  if (!available) console.log('[analyze] analyzer not reachable — capabilities unknown');
  return planAcoustics({
    ids,
    facets,
    where,
    state: db.loadFacetState(facets),
    capabilities: {
      clap: available ? analyzer.audioEmbeddingAvailable() : null,
      demucs: available ? analyzer.vocalActivityAvailable() : null,
    },
    limit,
  });
}

async function main() {
  const args = process.argv.slice(2);
  const facetMode = args.includes('--facets');
  const dryRun = args.includes('--dry-run');
  if (dryRun && !facetMode) {
    console.error('[analyze] --dry-run needs --facets');
    process.exit(1);
  }

  // Single-flight: a controller-spawned run already holds the pidfile, so this
  // is a no-op there; a manual run claims the lock or refuses. A dry run reads
  // only, so it never takes (or waits for) the lock.
  let ownsLock = false;
  if (!dryRun) {
    try {
      ownsLock = acquireStandaloneLock('analyze', args);
    } catch (err: any) {
      console.error(`[analyze] ${err.message}`);
      process.exit(1);
    }
  }
  if (ownsLock) installPidfileCleanup();

  const limit = parseIntFlag(args, '--limit');
  const reAnalyze = args.includes('--re-analyze');
  const forceWalk = args.includes('--walk');
  const skipWalk = args.includes('--skip-walk');
  // undefined → runAnalysisPass falls back to the ANALYZE_AUDIO_EMBEDDING env.
  const audioBackfill = args.includes('--audio') ? true : undefined;
  // undefined → falls back to ANALYZE_VOCAL_ACTIVITY / settings.audio.vocalActivity.
  const vocalBackfill = args.includes('--vocal') ? true : undefined;

  await applyWizardOverlay();
  await settings.load();
  const embeddingDim = embeddings.resolveEmbeddingDim();
  // adoptStoredDim so an embedding dim swap can't block analysis, which never
  // touches vectors (#319).
  await db.open({ embeddingDim, adoptStoredDim: true });

  if (facetMode) {
    let plan: AcousticsPlan;
    try {
      plan = await buildFacetPlan(args, limit);
    } catch (err: any) {
      console.error(`[analyze] ${err.message}`);
      process.exit(1);
    }
    for (const line of formatPlan(plan)) console.log(line);
    if (dryRun) {
      analyzer.shutdown();
      console.log('[analyze] dry run — nothing analysed');
      process.exit(0);
    }
    if (plan.items.length === 0) {
      analyzer.shutdown();
      console.log('[analyze] nothing planned');
      process.exit(0);
    }
    const stats = await runAnalysisPass({ plan });
    analyzer.shutdown();
    console.log('[analyze] stats:', JSON.stringify(stats));
    process.exit(0);
  }

  // Walk only when forced, or when the catalogue is empty (bootstrap).
  // --skip-walk hard-disables either way.
  const count = db.trackCount();
  const shouldWalk = !skipWalk && (forceWalk || count === 0);
  if (skipWalk) {
    console.log('[analyze] --skip-walk: not refreshing track metadata');
  } else if (shouldWalk) {
    console.log(
      forceWalk
        ? '[analyze] --walk: refreshing track metadata...'
        : '[analyze] empty catalogue — walking Navidrome...',
    );
  } else {
    console.log(
      `[analyze] catalogue has ${count} tracks — skipping metadata walk (use --walk to refresh)`,
    );
  }

  if (shouldWalk) {
    reportProgress({ phase: 'walk', label: 'Scanning Navidrome library', done: 0 });
    let walked = 0;
    const liveIds = new Set<string>();
    // A walk that prunes must be complete (same rule as the tagger's walk):
    // with the best-effort walk, an album whose getAlbum failed was skipped
    // and its tracks then deleted as "no longer in Navidrome", with every
    // tag, analysis and vector on them. An incomplete walk keeps the metadata
    // it refreshed, prunes nothing and lets the analysis pass run.
    let walkComplete = true;
    try {
      for await (const song of subsonic.iterateAllSongs({ requireComplete: true })) {
        db.upsertTrackMeta(song.id, {
          title: song.title,
          artist: song.artist,
          album: song.album,
          // Same ids the tagger's walk records; must not be NULL on an
          // analyzer-only catalogue.
          albumId: song.albumId ?? null,
          artistId: song.artistId ?? null,
          year: song.year,
          genres: subsonic.songGenres(song),
          duration: song.duration,
        });
        liveIds.add(song.id);
        walked += 1;
        if (walked % 500 === 0) {
          console.log(`[analyze] walked ${walked} tracks`);
          reportProgress({ phase: 'walk', label: 'Scanning Navidrome library', done: walked });
        }
      }
    } catch (err) {
      walkComplete = false;
      const why = err instanceof Error ? err.message : String(err);
      logEvent('warning', `Library walk incomplete after ${walked.toLocaleString('en-GB')} tracks (${why}); nothing pruned this run`);
    }
    if (walkComplete) logEvent('info', `Scanned ${walked.toLocaleString('en-GB')} tracks`);

    // Reconcile: adopt rows whose id was rotated by Navidrome's canonical-id
    // migration (music/id-rotation.ts — analysis carries over instead of being
    // recomputed), then drop rows for tracks genuinely no longer in Navidrome
    // so the analysis scope reflects the live catalogue, not orphans from past
    // full rescans. Guarded on a non-empty walk (a complete, authoritative pass).
    //
    // Note this is NOT a recovery path an operator can reach from the admin UI:
    // `shouldWalk` is false on a populated catalogue and startAnalyzer passes no
    // --walk, so after a rotation (where the catalogue is full of stale rows)
    // only a host-side `--walk` run gets here. The two real recovery paths are
    // the tagger run and Library → Reconcile with Navidrome. Adoption is wired
    // here anyway so the CLI can't be the one path that prunes what the others
    // adopt.
    if (walkComplete && walked > 0) {
      const { pruned, held } = await adoptAndPrune(liveIds, { confirmMassPrune: args.includes('--confirm-prune') });
      if (held) logEvent('warning', held.message);
      if (pruned > 0) {
        console.log(`[analyze] pruned ${pruned} orphaned tracks no longer in Navidrome`);
      }
    }
  }

  const stats = await runAnalysisPass({ limit, reAnalyze, audioBackfill, vocalBackfill });
  analyzer.shutdown();
  console.log('[analyze] stats:', JSON.stringify(stats));
  process.exit(stats.available ? 0 : 0);
}

main().catch((err) => {
  console.error('[analyze] fatal:', err);
  process.exit(1);
});

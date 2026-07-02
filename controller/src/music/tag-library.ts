// Library tagger orchestrator (embedding-propagated).
//
// Pipeline (each phase short-circuits cleanly so partial runs make progress):
//   Phase 0  — ENRICH        fetch Last.fm tags + lyric excerpts, cache in DB
//   Phase 1  — EMBED         text-embed every track that needs it
//   Phase 2  — SEED          LLM-tag a small, well-chosen seed set
//   Phase 3  — PROPAGATE     KNN-vote moods/energy onto every untagged track
//   Phase 4  — ACTIVE-LEARN  LLM-tag the residual uncertain set; re-propagate
//
// Run:  docker exec sub-wave-controller npx tsx src/music/tag-library.ts
// Flags:
//   --limit N             cap NEW tracks considered this run (default: all)
//   --batch N             LLM batch size (default 25)
//   --seeds N             override seed budget (default max(200, ceil(sqrt(library))))
//   --max-rounds N        cap active-learning rounds (default 3)
//   --no-propagate        only embed + seed, skip phases 3-4 (debug)
//   --reseed              drop + rebuild track_vectors; re-embed from scratch
//   --re-enrich           null out enrichment cache and re-fetch from Navidrome
//   --skip-enrich         embed using metadata only (debug; verifies enrichment helps)
//   --skip-analyze        skip the acoustic bpm/key pass (Phase 5)
//   --skip-tag            skip embed + mood tagging (phases 1-4); walk/enrich/
//                         analyze still run per their flags (admin "Tag moods" off)
//   --no-prune            walk Navidrome but don't drop orphaned rows (admin
//                         "Reconcile with Navidrome" step deselected)
//   --vocal / --no-vocal  force the Phase-5 Demucs vocal pass on / off for this
//                         run (else defers to settings.audio.vocalActivity)
//   --upgrade             re-LLM-tag only tagged rows with stale promptHash/model
//                         (never source='manual'). The "Re-decide moods" pass.
//   --rescan              re-scan mode: fire ONLY the selected re-* passes, each
//                         scoped to already-done tracks; never forward-process the
//                         untagged remainder (set by the admin Re-scan tab)
//
// On boot the library-db auto-migrates any state/moods.json into the SQLite
// tracks table as legacy v1 entries (see library-db.ts).

import * as subsonic from './subsonic.js';
import * as lastfm from './lastfm.js';
import * as db from './library-db.js';
import * as settings from '../settings.js';
import * as embeddings from './embeddings.js';
import { selectSeeds } from './seed-selector.js';
import { selectEnrichIds } from './enrich-scope.js';
import { vote } from './tag-propagator.js';
import { config } from '../config.js';
import { loadSecretsIntoEnv } from '../setup/secrets.js';
import { loadSetupConfig } from '../setup/config.js';
import { activeModelLabel, primaryLeg, fallbackLeg, probeLegReachable } from '../llm/provider.js';
import { isUnreachable, isQuotaOrAuthError, errReason } from '../llm/sdk.js';
import { setRawDebugStderrMirror } from '../llm/log.js';
import { tagBatch, tagOne, TAGGER_BATCH_SYSTEM, type TagResult } from './tagger-core.js';
import { runAnalysisPass } from './analyze.js';
import { reportProgress, formatPhaseBreakdown, sortedPhaseTimings, makeEventLogger } from './tagger-progress.js';
import { planRun } from './rescan-scope.js';
import { mapPool, memoizeByKey } from '../util/async-pool.js';
import { acquireStandaloneLock, installPidfileCleanup } from './tagger-lock.js';

// Emit the terse `[tag] …` console line AND the structured event sentinel the
// controller relays to the panel — one call site per notable milestone.
const logEvent = makeEventLogger('tag');

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseIntFlag(args: string[], name: string): number | null {
  const idx = args.indexOf(name);
  if (idx < 0) return null;
  const n = parseInt(args[idx + 1], 10);
  return Number.isFinite(n) ? n : null;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

interface CliFlags {
  limit: number;
  batchSize: number;
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

function parseFlags(): CliFlags {
  const args = process.argv.slice(2);
  return {
    limit: parseIntFlag(args, '--limit') ?? Infinity,
    batchSize: Math.max(1, Math.min(50, parseIntFlag(args, '--batch') ?? 25)),
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
async function walkNavidrome(): Promise<{ walked: number; liveIds: Set<string> }> {
  reportProgress({ phase: 'walk', label: 'Scanning Navidrome library', done: 0 });
  let walked = 0;
  const liveIds = new Set<string>();
  for await (const song of subsonic.iterateAllSongs()) {
    db.upsertTrackMeta(song.id, {
      title: song.title,
      artist: song.artist,
      album: song.album,
      year: song.year,
      genre: song.genre,
      duration: song.duration,
    });
    liveIds.add(song.id);
    walked += 1;
    if (walked % 500 === 0) {
      console.log(`[tag] walked ${walked} tracks`);
      reportProgress({ phase: 'walk', label: 'Scanning Navidrome library', done: walked });
    }
  }
  logEvent('info', `Scanned ${walked.toLocaleString('en-GB')} tracks`);
  return { walked, liveIds };
}

// Standalone reconcile: diff library-db against the live Navidrome catalogue and
// drop rows (and their vectors) for tracks that are gone. No embedding preflight
// and no LLM — opens the existing DB at its stored dim so vectors are untouched.
async function reconcileOnly() {
  await db.open({ embeddingDim: embeddings.resolveEmbeddingDim(), adoptStoredDim: true });
  console.log('[tag] reconcile-only: walking Navidrome to prune orphaned rows');
  const { walked, liveIds } = await walkNavidrome();
  let pruned = 0;
  if (walked > 0) {
    pruned = db.pruneMissingTracks(liveIds);
    console.log(`[tag] reconcile pruned ${pruned} orphaned tracks no longer in Navidrome`);
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
async function applyWizardOverlay() {
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

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------

async function main() {
  const flags = parseFlags();
  const startedAt = Date.now();

  // Keep the raw-LLM-request debug capture writing to state/logs/llm-debug.log,
  // but mute its stderr mirror so it doesn't drown the tagger's formatted output
  // (the `[llm-debug-raw] {...}` JSON dumps). The file still captures everything.
  setRawDebugStderrMirror(false);

  // Belt-and-braces single-flight: a controller-spawned run is already covered by
  // the pidfile the controller wrote (MANAGED_ENV set → this is a no-op). A manual
  // `npm run tag` on a host checkout claims the lock itself and refuses if another
  // live run holds it, so it can't become a second writer on the same DB.
  let ownsLock = false;
  try {
    ownsLock = acquireStandaloneLock(flags.reconcileOnly ? 'reconcile' : 'tag', process.argv.slice(2));
  } catch (err: any) {
    console.error(`[tag] ${err.message}`);
    process.exit(1);
  }
  if (ownsLock) installPidfileCleanup();

  // Per-phase wall-clock. `lap(name)` attributes the time since the previous lap
  // to `name`, so the breakdown in finish() shows where a slow run actually went
  // (almost always the chat-model seed/learn phases, not embeddings).
  const timings: Record<string, number> = {};
  let phaseT0 = startedAt;
  const lap = (name: string): void => {
    const now = Date.now();
    timings[name] = (timings[name] || 0) + (now - phaseT0);
    phaseT0 = now;
  };

  await applyWizardOverlay();
  await settings.load();

  // Reconcile is a pure catalogue diff — short-circuit before any embedding /
  // LLM setup so it runs even when embeddings are disabled or unconfigured.
  if (flags.reconcileOnly) {
    await reconcileOnly();
    return;
  }

  if (!embeddings.isAvailable()) {
    logEvent('error', 'Embeddings not available — set settings.embedding.enabled / provider');
    process.exit(1);
  }

  // Preflight FIRST — catch the common misconfigurations (model not pulled,
  // cloud Ollama 401, server unreachable, a chat model that can't embed) BEFORE
  // we open the DB or walk Navidrome and burn through a 28k-track embed loop
  // only to die on the first batch (issues #174, #319). The probe also reports
  // the embedding dimension measured from a real vector — authoritative over the
  // name→dim guess, so an arbitrarily-named embedding model just works.
  const probe = await embeddings.ensureReady();
  if (probe.code !== 'ok') {
    logEvent('error', `Embedding preflight failed (${probe.code}): ${probe.message}`);
    process.exit(1);
  }
  const embeddingDim = probe.dim ?? embeddings.resolveEmbeddingDim();

  // Pass reseed so open() can recover from an embedding model/dim swap instead
  // of throwing the dim-mismatch error before the --reseed logic below ever
  // runs (the bug in #307). On a same-dim run this is a no-op.
  await db.open({ embeddingDim, reseed: flags.reseed });

  // The DB upserts emit when the model changes; record the current one.
  db.setEmbeddingMeta(embeddings.activeModelLabel(), embeddingDim);

  // Tunables from settings.embedding, CLI flags override where present.
  const embedCfg: any = (settings.get() as any).embedding ?? {};
  const maxRounds = flags.maxRounds ?? Math.max(0, embedCfg.maxActiveLearningRounds ?? 3);
  // Fallbacks kept in sync with DEFAULTS.embedding in settings.ts (settings.get()
  // normally supplies these; the ?? only bites if the field is entirely absent).
  const knnK = Math.max(1, embedCfg.knnNeighbours ?? 10);
  const moodVoteThreshold = clamp01(embedCfg.moodVoteThreshold ?? 0.4);
  const confidenceThreshold = clamp01(embedCfg.confidenceThreshold ?? 0.35);
  const seedCountCfg =
    typeof embedCfg.seedCount === 'number' && embedCfg.seedCount > 0
      ? embedCfg.seedCount
      : null;

  logEvent('info', `Starting up — ${db.allTaggedIds().length.toLocaleString('en-GB')} tracks already tagged`);
  logEvent('info', `Tagging model — ${activeModelLabel()}`);
  logEvent('info', `Embedding model — ${embeddings.activeModelLabel()} (dim=${embeddingDim})`);
  console.log(
    `[tag] batch=${flags.batchSize} maxRounds=${maxRounds} knnK=${knnK} ` +
      `moodVote=${moodVoteThreshold} confidence=${confidenceThreshold}`,
  );

  // A re-scan re-embed rebuilds the vector population; a normal --reseed run does
  // it as part of its forward pass and doesn't need the snapshot below.
  let reembedIds: string[] = [];
  if (flags.reseed) {
    // Snapshot the set to rebuild. A SAME-dim reseed still has the old vectors
    // here, so embeddedIds() captures exactly the already-embedded population. A
    // DIM-CHANGE reseed already had track_vectors dropped inside open()/migrate
    // (the old vectors are unusable at the new width), so this comes back empty.
    if (flags.rescan) reembedIds = db.embeddedIds();
    console.log('[tag] --reseed: dropping track_vectors, re-embedding from scratch');
    db.dropVectors();
    // Dim change wiped the vectors before we could snapshot them. The UI pass is
    // "Re-embed all tracks" (its whole purpose is a model change, which usually
    // changes the dim), so rebuild every track that now needs a vector — after
    // the reset that's the whole library. Without this the pass silently rebuilt
    // 0 vectors on exactly the model swap it advertises.
    if (flags.rescan && reembedIds.length === 0) reembedIds = db.unembeddedIds();
  }

  const promptHash = embeddings.promptVocabHash(TAGGER_BATCH_SYSTEM);
  const modelLabel = activeModelLabel();

  // Single- vs dual-LLM tagging. Decided once and shared by the seed + active-
  // learn phases. Probed here (not per phase) so the banner prints once.
  const tagConsumers = await resolveTagConsumers();
  const byLeg: Record<string, number> = {};
  const mergeByLeg = (m: Record<string, number>) => {
    for (const [k, v] of Object.entries(m)) byLeg[k] = (byLeg[k] || 0) + v;
  };

  // ---- Phase A: iterate Navidrome and upsert track metadata into DB ------
  // Cheap; ensures every Navidrome song is in the tracks table so subsequent
  // phases can operate purely off SQL.
  lap('setup');
  console.log('[tag] walking Navidrome library...');
  const { walked, liveIds } = await walkNavidrome();

  // Reconcile against the live catalogue. The walk above is complete and
  // authoritative, so any track row it didn't see is gone from Navidrome
  // (typically after a full rescan that re-mints IDs). Pruning the orphans
  // keeps coverage %, untagged scope and analysis scope honest. Guarded on a
  // non-empty walk so a transient empty Navidrome response can't wipe the DB.
  if (flags.noPrune) {
    console.log('[tag] --no-prune: skipping orphan prune (reconcile step deselected)');
  } else if (walked > 0) {
    const pruned = db.pruneMissingTracks(liveIds);
    if (pruned > 0) {
      console.log(`[tag] pruned ${pruned} orphaned tracks no longer in Navidrome`);
    }
  }
  lap('walk');

  // Which phases run this pass. A re-scan fires only the selected re-* passes and
  // suppresses forward discovery; a normal run is a full forward pass minus any
  // deselected steps (pure decision, unit-pinned in rescan-scope.test.ts).
  const plan = planRun(flags);

  // Forward "Run" scope: the untagged tracks this run discovers + tags. A re-scan
  // redoes already-done work for the EXISTING population, so its forward scope is
  // empty — each re-* pass below redoes only the tracks that already carry that
  // artifact (enriched / embedded / analysed / tagged), never the remainder.
  // Honour --limit on a forward run by capping how many NEW tracks we work on;
  // ones beyond the cap wait for the next run.
  const allUntagged = db.untaggedIds();
  const targetUntagged = flags.rescan
    ? []
    : flags.limit === Infinity
      ? allUntagged
      : allUntagged.slice(0, flags.limit);
  if (flags.rescan) {
    console.log(
      `[tag] re-scan mode: redoing selected passes for already-done tracks ` +
        `(not forward-processing ${allUntagged.length} untagged)`,
    );
  } else {
    logEvent(
      'info',
      `${targetUntagged.length.toLocaleString('en-GB')} new tracks to tag ` +
        `(${allUntagged.length.toLocaleString('en-GB')} still untagged)`,
    );
  }

  // ---- Phase 0: ENRICH ---------------------------------------------------
  // Normal runs enrich only the in-scope untagged tracks. A --re-enrich pass is
  // an explicit "refresh metadata on the whole library" request (e.g. backfill
  // Last.fm tags after upgrading), so selectEnrichIds widens scope to the full
  // walked catalogue — not just untagged tracks, which is empty on a fully-tagged
  // library and made re-enrich a silent no-op (issue #531). The per-track
  // enrichedAt cache is bypassed inside phaseEnrich when reEnrich is set; --limit
  // still caps the count so a partial refresh is possible.
  if (plan.enrich) {
    const enrichIds = selectEnrichIds({
      reEnrich: flags.reEnrich,
      rescan: flags.rescan,
      limit: flags.limit,
      liveIds,
      // Re-scan re-enrich redoes only the already-enriched population.
      enrichedIds: flags.rescan ? db.enrichedIds() : undefined,
      targetUntagged,
    });
    if (flags.reEnrich) {
      const scopeNote = flags.rescan ? 'already-enriched tracks' : 'tracks';
      console.log(`[tag] --re-enrich: refreshing metadata for ${enrichIds.length} ${scopeNote}`);
    }
    await phaseEnrich(enrichIds, flags.reEnrich);
  } else if (flags.skipEnrich) {
    console.log('[tag] --skip-enrich: not fetching Last.fm tags or lyrics');
  }
  lap('enrich');

  // ---- Phases 1-4: TAG MOODS (embed → seed → propagate → active-learn) ----
  // Wrapped as the user-facing "Tag moods" step: --skip-tag skips all four so a
  // run can refresh enrichment and/or acoustics without writing embeddings or
  // moods. A re-scan suppresses these forward-discovery phases entirely
  // (plan.forwardTag === false) and runs the scoped re-embed / re-decide passes
  // below instead. llmCalls/llmTagged are hoisted here so finish() still reports
  // 0 when tagging is skipped.
  let llmCalls = 0;
  let llmTagged = 0;
  if (plan.forwardTag) {
    // ---- Phase 1: EMBED ----------------------------------------------------
    await phaseEmbed(targetUntagged, flags.batchSize);
    lap('embed');

    // ---- Phase 2: SEED -----------------------------------------------------
    // CLI --seeds wins, then settings.embedding.seedCount, then sqrt(N) auto.
    // When --limit is set, also clamp to the in-scope size — a `--limit 10`
    // run can never tag more than 10 untagged tracks even if seedCount=200.
    const rawSeedCount = flags.seedCount ?? seedCountCfg ?? autoSeedCount(walked);
    const limited = flags.limit !== Infinity;
    const seedCount = limited
      ? Math.min(rawSeedCount, targetUntagged.length)
      : rawSeedCount;
    if (limited && seedCount < rawSeedCount) {
      console.log(
        `[tag] seed budget clamped from ${rawSeedCount} to ${seedCount} by --limit`,
      );
    } else {
      console.log(`[tag] seed budget: ${seedCount}`);
    }

    const seedSelection = await selectSeeds({
      seedCount,
      // Honour --limit at the seed layer too: without this, layers 2-4 of the
      // seed selector pull starred/playlist/frequent/stratified/k-means picks
      // from the full untagged pool, so a `--limit 10` run would still tag up
      // to seedCount tracks from outside the window. Bulk runs (no --limit)
      // pass undefined to keep the full library in play.
      untaggedPool: limited ? new Set(targetUntagged) : undefined,
      // NOTE: no embeddingForId here. library-db has no direct vector-read API
      // (only knnById, a full vector scan per call), so passing any function —
      // even one that always returns null — makes the seed selector run one
      // KNN scan per candidate before falling back anyway. On a large library
      // that's hours of wasted scans. Omitting it routes the selector straight
      // to its random-shuffle path, until a cheap bulk vector read exists.
    });
    console.log(
      `[tag] seeds: ${seedSelection.seeds.length} new ` +
        `(layer counts: ${JSON.stringify(seedSelection.layerCounts)})`,
    );

    if (seedSelection.seeds.length > 0) {
      const tagged = await llmTagInBatches(
        seedSelection.seeds, flags.batchSize, promptHash, 'llm', tagConsumers, { phase: 'seed' },
      );
      llmCalls += tagged.callCount;
      llmTagged += tagged.tagged;
      mergeByLeg(tagged.byLeg);
      logEvent('success', `Mood tagging done — ${tagged.tagged}/${seedSelection.seeds.length}`);
    }
    lap('seed');

    if (flags.noPropagate) {
      console.log('[tag] --no-propagate: stopping after seed phase');
      return finish(startedAt, llmCalls, llmTagged, byLeg, timings);
    }

    // ---- Phase 3: PROPAGATE ------------------------------------------------
    // Only operate on tracks that (a) are in this run's scope and (b) have an
    // embedding. Tracks without vectors can't have neighbours; they'd just get
    // marked uncertain and burn LLM budget in phase 4.
    // knnK, moodVoteThreshold, confidenceThreshold all sourced from
    // settings.embedding above.
    let propagated = 0;
    let uncertain: string[] = [];
    let scanned = 0;

    reportProgress({ phase: 'propagate', label: 'Propagating tags to neighbours', done: 0, total: targetUntagged.length });
    for (const id of targetUntagged) {
      scanned += 1;
      // The loop is synchronous — emit sparsely so a 30k-track scan doesn't
      // spam stdout.
      if (scanned % 500 === 0) {
        reportProgress({ phase: 'propagate', label: 'Propagating tags to neighbours', done: scanned, total: targetUntagged.length });
      }
      if (db.hasTags(id)) continue;        // already seeded
      if (!db.hasVector(id)) continue;     // no embedding → can't propagate
      const neighbours = db.knnById(id, knnK);
      const result = vote(
        neighbours,
        (nId) => {
          const t = db.getTrack(nId);
          if (!t || t.moods.length === 0) return null;
          return { moods: t.moods, energy: t.energy };
        },
        { moodVoteThreshold, k: knnK },
      );
      if (
        result.votingNeighbours >= 1 &&
        result.confidence >= confidenceThreshold &&
        result.moods.length > 0
      ) {
        db.upsertTrackTags(id, {
          moods: result.moods,
          energy: result.energy,
          source: 'propagated',
          confidence: result.confidence,
          promptHash,
          model: modelLabel,
        });
        propagated += 1;
      } else {
        uncertain.push(id);
      }
    }
    logEvent('info', `Spread tags to ${propagated.toLocaleString('en-GB')} similar tracks (${uncertain.length} unsure)`);
    reportProgress({ phase: 'propagate', label: 'Propagating tags to neighbours', done: targetUntagged.length, total: targetUntagged.length });
    lap('propagate');

    // ---- Phase 4: ACTIVE-LEARN --------------------------------------------
    for (let round = 1; round <= maxRounds; round++) {
      if (uncertain.length === 0) break;
      logEvent('info', `Round ${round}: re-checking ${uncertain.length} unsure tracks…`);
      const tagged = await llmTagInBatches(
        uncertain,
        flags.batchSize,
        promptHash,
        'uncertain-llm',
        tagConsumers,
        { phase: 'learn', round },
      );
      llmCalls += tagged.callCount;
      llmTagged += tagged.tagged;
      mergeByLeg(tagged.byLeg);

      // Re-propagate over any tracks in scope still untagged after this LLM round.
      let extra = 0;
      const stillUncertain: string[] = [];
      for (const id of targetUntagged) {
        if (db.hasTags(id)) continue;
        if (!db.hasVector(id)) continue;
        const neighbours = db.knnById(id, knnK);
        const result = vote(
          neighbours,
          (nId) => {
            const t = db.getTrack(nId);
            if (!t || t.moods.length === 0) return null;
            return { moods: t.moods, energy: t.energy };
          },
          { moodVoteThreshold, k: knnK },
        );
        if (
          result.votingNeighbours >= 1 &&
          result.confidence >= confidenceThreshold &&
          result.moods.length > 0
        ) {
          db.upsertTrackTags(id, {
            moods: result.moods,
            energy: result.energy,
            source: 'propagated',
            confidence: result.confidence,
            promptHash,
            model: modelLabel,
          });
          extra += 1;
        } else {
          stillUncertain.push(id);
        }
      }
      propagated += extra;
      console.log(
        `[tag] phase-4 round ${round} re-propagated ${extra}; ${stillUncertain.length} still uncertain`,
      );

      // Converged if no new propagation happened this round.
      if (stillUncertain.length === uncertain.length) {
        console.log('[tag] convergence — no further propagation possible');
        break;
      }
      uncertain = stillUncertain;
    }
    lap('learn');
  } else if (flags.skipTag) {
    console.log('[tag] --skip-tag: skipping embed + mood tagging (phases 1-4)');
  } // end forward "Tag moods" step (plan.forwardTag)

  // ---- Re-scan: RE-EMBED (model swap) ------------------------------------
  // Rebuild vectors under the new embedding model. A same-dim swap rebuilds the
  // already-embedded population (snapshotted before the drop above); a dim-change
  // swap rebuilds every track that needs a vector (the whole library) because the
  // old vectors were dropped at open() before they could be snapshotted. Either
  // way the KNN graph the existing tags anchor is fully restored under the new
  // model.
  if (plan.reEmbed) {
    console.log(`[tag] re-embed: rebuilding ${reembedIds.length} vectors from scratch`);
    await phaseEmbed(reembedIds, flags.batchSize);
    lap('embed');
  }

  // ---- Re-scan: RE-DECIDE moods ------------------------------------------
  // Re-LLM-tag tagged rows whose prompt or model went stale (never manual). With
  // no prompt/model change nothing is stale → clean no-op. Scoped to the existing
  // tagged set, so it never reaches into the untagged remainder.
  if (plan.reDecide) {
    const stale = db.staleTaggedIds(
      promptHash,
      modelLabel,
      flags.limit === Infinity ? undefined : flags.limit,
    );
    if (stale.length === 0) {
      console.log('[tag] re-decide: no tagged rows are stale (prompt/model unchanged) — nothing to redo');
    } else {
      console.log(`[tag] re-decide: re-tagging ${stale.length} stale row(s)`);
      const tagged = await llmTagInBatches(
        stale, flags.batchSize, promptHash, 'llm', tagConsumers, { phase: 'seed' },
      );
      llmCalls += tagged.callCount;
      llmTagged += tagged.tagged;
      mergeByLeg(tagged.byLeg);
      console.log(`[tag] re-decide done: ${tagged.tagged}/${stale.length} re-tagged`);
    }
    lap('seed');
  }

  // ---- Phase 5: ANALYZE (acoustic bpm/key/intro) -------------------------
  // Independent of mood tagging — runs the same pass as `npm run analyze`.
  // No-ops cleanly when no analysis backend (tts-heavy sidecar / local
  // librosa venv) is reachable, so it never blocks a tag run. In a re-scan it
  // runs only when "Re-analyse" was selected (plan.analyze), and scopes to the
  // already-analysed set (rescan flag threaded through).
  if (plan.analyze) {
    try {
      await runAnalysisPass({
        limit: flags.limit === Infinity ? undefined : flags.limit,
        reAnalyze: flags.reAnalyze,
        rescan: flags.rescan,
        // Tri-state: --vocal forces the Demucs pass on, --no-vocal forces it off,
        // neither (undefined) defers to settings.audio.vocalActivity / env.
        vocalBackfill: flags.vocal ? true : flags.noVocal ? false : undefined,
      });
    } catch (err: any) {
      logEvent('warning', `Acoustic analysis phase failed (non-fatal): ${err?.message || err}`);
    }
  }
  lap('analyze');

  finish(startedAt, llmCalls, llmTagged, byLeg, timings);
}

function autoSeedCount(librarySize: number): number {
  // MIRROR: web/components/admin/LibraryTaggingModal.tsx `seedBudget` replicates
  // this formula for the Run-tab cost preview — keep the 200 / 2500 / 0.04
  // constants in sync there if they change here.
  // ~4% of the library, floored at 200 (small libraries still get a workable
  // anchor set) and capped at 2500 (a 100k-track library shouldn't pay for 10k
  // LLM seed tags — propagation carries the rest). Denser than the old
  // ceil(sqrt(N)), which flatlined at 200 for everything up to ~40k tracks and
  // left too few anchors for KNN propagation to fire before active-learning.
  // A denser seed set is often net-cheaper: more seeds → higher propagation
  // coverage → a smaller (expensive) active-learning residual.
  return Math.max(200, Math.min(2500, Math.round(librarySize * 0.04)));
}

function finish(
  startedAt: number,
  llmCalls: number,
  llmTagged: number,
  byLeg: Record<string, number>,
  timings: Record<string, number> = {},
) {
  const elapsed = (Date.now() - startedAt) / 1000;
  logEvent(
    'success',
    `Done in ${elapsed.toFixed(0)}s — ${llmTagged.toLocaleString('en-GB')} tracks tagged ` +
      `(${llmCalls.toLocaleString('en-GB')} LLM calls)`,
  );
  // Phase breakdown, slowest first — turns "tagging is slow" into "phase X is
  // 90% of the time" so the operator knows what to actually tune.
  const timed = sortedPhaseTimings(timings);
  const breakdown = formatPhaseBreakdown(timings);
  if (breakdown) logEvent('info', `Time per phase — ${breakdown}`);
  reportProgress({
    phase: 'done',
    label: 'Finished',
    done: llmTagged,
    llm: Object.keys(byLeg).length ? { legs: byLeg } : undefined,
    timings: timed.length ? Object.fromEntries(timed) : undefined,
  });
  const legs = Object.entries(byLeg);
  if (legs.length > 1) {
    console.log(`[tag] per-leg: ${legs.map(([m, n]) => `${m}=${n}`).join(' · ')}`);
  }
  // Compact one-line summary — the full per-genre/per-mood breakdown was far too
  // noisy for the run log + the admin log drawer (it buried the phase breakdown).
  const s: any = db.stats();
  const moods = Object.keys(s.byMood || {}).length;
  const genres = Object.keys(s.byGenre || {}).length;
  const src = Object.entries(s.bySource || {}).map(([k, v]) => `${k}=${v}`).join(' ');
  logEvent(
    'info',
    `Library now: ${(s.total ?? 0).toLocaleString('en-GB')} tagged · ${moods} moods · ${genres} genres · ` +
      `${(s.withEmbedding ?? 0).toLocaleString('en-GB')} embedded${src ? ` · ${src}` : ''}`,
  );
}

// ---------------------------------------------------------------------------
// Phase 0 — Enrichment (Last.fm tags + lyric excerpts)
// ---------------------------------------------------------------------------

async function phaseEnrich(ids: string[], reEnrich: boolean): Promise<void> {
  if (ids.length === 0) return;
  const enrichCfg = (settings.get() as any).embedding?.enrichment ?? {};
  // A configured Last.fm api_key (LASTFM_API_KEY / scrobble.lastfm.apiKey) lets
  // us hit the Last.fm API directly (music/lastfm.ts), which actually returns
  // tag[]. The tri-state gate (shared with the retag route via
  // lastfm.lastfmEnrichEnabled) keeps keyless vanilla-Navidrome installs from
  // wasting a round trip per artist on the tag-less getArtistInfo2 path.
  const hasKey = lastfm.hasLastfmKey();
  const lastfmEnabled = lastfm.lastfmEnrichEnabled(enrichCfg.lastfmTags, hasKey);
  const lyricsEnabled = enrichCfg.lyrics !== false;
  if (!lastfmEnabled && !lyricsEnabled) {
    console.log('[tag] phase-0 skipped: both lastfmTags and lyrics disabled in settings.embedding.enrichment');
    return;
  }
  if (lastfmEnabled) {
    console.log(
      `[tag] phase-0 Last.fm tags via ${hasKey ? 'direct API (artist.getTopTags)' : 'Navidrome getArtistInfo2 (no api_key — likely empty)'}`,
    );
  }
  reportProgress({ phase: 'enrich', label: 'Enriching metadata', done: 0, total: ids.length });
  // Per-artist Last.fm dedup: memoize on the in-flight PROMISE (not the resolved
  // value) so the concurrent pool below shares one API call across every track by
  // the same artist. Direct Last.fm API when a key is present (returns crowd tags
  // on vanilla Navidrome), else Navidrome's getArtistInfo2 — shared with the
  // single-track retag route so the two can't drift (see lastfm.ts).
  const artistTags = memoizeByKey<string[]>(artist =>
    lastfm.getArtistTags(artist, { count: 10 }).then(t => t ?? []).catch(() => []),
  );

  let enrichedTracks = 0;
  let enrichedLyrics = 0;
  let enrichedTags = 0;

  // Enrichment is I/O-bound (Last.fm + Navidrome lyrics fetches), so a serial
  // await-per-track loop spends almost all its time blocked on the network — on a
  // large library that's the difference between minutes and an hour. Drain the id
  // list with a bounded pool instead. DB writes go through better-sqlite3
  // (synchronous), so they're naturally serialised on the single-threaded event
  // loop between awaits — no locking needed. Pool size is gentle by default (6)
  // and tunable via TAG_ENRICH_CONCURRENCY so a small Navidrome / Last.fm budget
  // can dial it down.
  const concurrency = Math.max(
    1,
    Math.min(32, parseInt(process.env.TAG_ENRICH_CONCURRENCY || '', 10) || 6),
  );

  await mapPool(ids, concurrency, async (id) => {
    const t = db.getTrack(id);
    if (!t) return;
    if (!reEnrich && t.enrichedAt) return;

    let lastfmTags: string[] | null = null;
    if (lastfmEnabled && t.artist) {
      const tags = await artistTags(t.artist);
      lastfmTags = tags.length ? tags : null;
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
    if (lastfmTags && lastfmTags.length) enrichedTags += 1;
    if (lyricExcerpt) enrichedLyrics += 1;
    if (enrichedTracks % 100 === 0) {
      console.log(
        `[tag] enriched ${enrichedTracks}/${ids.length} (lastfm: ${enrichedTags}, lyrics: ${enrichedLyrics})`,
      );
      reportProgress({ phase: 'enrich', label: 'Enriching metadata', done: enrichedTracks, total: ids.length });
    }
  });

  logEvent(
    'info',
    `Metadata fetched for ${enrichedTracks.toLocaleString('en-GB')} tracks ` +
      `(${enrichedTags} Last.fm, ${enrichedLyrics} lyrics)`,
  );
}

// ---------------------------------------------------------------------------
// Phase 1 — Embed
// ---------------------------------------------------------------------------

async function phaseEmbed(targetIds: string[], batchSize: number): Promise<void> {
  // Embed any track in scope that doesn't already have a vector. Includes
  // already-tagged tracks (legacy v1) so they can serve as KNN neighbours.
  const needsEmbed: string[] = [];
  for (const id of targetIds) {
    if (!db.hasVector(id)) needsEmbed.push(id);
  }
  // Also embed all already-tagged tracks that don't have vectors yet (legacy
  // v1 imports). Without this they can't anchor the KNN graph.
  for (const id of db.allTaggedIds()) {
    if (!db.hasVector(id)) needsEmbed.push(id);
  }
  // Dedup
  const unique = [...new Set(needsEmbed)];
  if (unique.length === 0) {
    console.log('[tag] phase-1 nothing to embed');
    return;
  }
  logEvent('info', `Building similarity vectors for ${unique.length.toLocaleString('en-GB')} tracks…`);
  reportProgress({ phase: 'embed', label: 'Embedding tracks', done: 0, total: unique.length });

  const embedBatchSize = Math.max(8, Math.min(64, batchSize * 2));
  for (let i = 0; i < unique.length; i += embedBatchSize) {
    const batch = unique.slice(i, i + embedBatchSize);
    const songs = batch.map(id => db.getTrack(id)).filter((t): t is db.TrackRecord => !!t);
    const texts = songs.map(t =>
      embeddings.formatTrackText(
        { title: t.title, artist: t.artist, album: t.album, year: t.year, genre: t.genre },
        { lastfmTags: t.lastfmTags, lyricExcerpt: t.lyricExcerpt },
      ),
    );
    let vecs: number[][];
    try {
      vecs = await embeddings.embedTexts(texts);
    } catch (err: any) {
      console.error(`[tag] embedding batch failed at offset ${i}: ${err.message}`);
      throw err;
    }
    for (let j = 0; j < songs.length; j++) {
      db.upsertTrackVector(songs[j].id, vecs[j]);
    }
    if ((i + batch.length) % 500 === 0 || i + batch.length === unique.length) {
      console.log(`[tag] embedded ${i + batch.length}/${unique.length}`);
      reportProgress({ phase: 'embed', label: 'Embedding tracks', done: i + batch.length, total: unique.length });
    }
  }
}

// ---------------------------------------------------------------------------
// LLM tagging helper (reused by phase 2 + phase 4)
// ---------------------------------------------------------------------------

// A single LLM worker the batch loop pulls through. `pin` selects which leg
// each call targets (undefined → normal primary→fallback failover, used in
// single-LLM mode); `label` is stamped on every track this consumer tags so the
// per-track provenance is honest across two different models (discussion #320).
interface TagConsumer {
  pin?: 'primary' | 'fallback';
  label: string;
}

interface TagState {
  tagged: number;
  callCount: number;
  processed: number;
  // Tracks that came back null from the LLM (batch entry dropped / per-track
  // salvage failed) — surfaced in the progress channel.
  errors: number;
  byLeg: Record<string, number>;
}

// Which pipeline phase a runConsumer() call is tagging for — only used to
// stamp the progress channel ('seed' = phase 2, 'learn' = phase 4 rounds).
interface TagPhaseInfo {
  phase: 'seed' | 'learn';
  round?: number;
}

// Tag one batch with one consumer's leg. Returns the count actually tagged.
// Throws ONLY when a pinned leg's host is unreachable — the caller requeues the
// whole batch and drops the consumer. Upserts happen only after the batch fully
// resolves, so a rethrow mid-batch persists nothing: the requeue is lossless.
// Non-unreachable failures (small models dropping list entries) salvage per
// track exactly as before, so one bad line never sinks 25 tracks.
async function processBatch(
  batch: string[],
  consumer: TagConsumer,
  promptHash: string,
  source: db.TagSource,
  state: TagState,
): Promise<number> {
  const songs = batch.map(id => db.getTrack(id)).filter((t): t is db.TrackRecord => !!t);
  if (songs.length === 0) return 0;
  const input = songs.map(t => ({
    title: t.title ?? undefined,
    artist: t.artist ?? undefined,
    album: t.album ?? undefined,
    year: t.year ?? undefined,
    genre: t.genre ?? undefined,
  }));
  const opts = consumer.pin ? { leg: consumer.pin } : {};

  let results: Array<TagResult | null>;
  try {
    results = await tagBatch(input, opts);
    state.callCount += 1;
  } catch (err: any) {
    // A pinned leg that can't recover this run — host down, OR a
    // quota/usage-limit/auth rejection (#438): rethrow BEFORE the per-track
    // salvage, otherwise we'd grind 25 serial connect-timeouts (or 25 identical
    // 429s) against a leg that won't answer. The surviving consumer redoes the
    // requeued batch.
    if (consumer.pin && (isUnreachable(err) || isQuotaOrAuthError(err))) throw err;
    // A "batch length mismatch" is NOT a failure. Some models (e.g. Mercury, and
    // small local models) don't return one structured-output entry per input
    // track, so we tag each track individually this batch — same seed set, same
    // cost envelope (only the seeds ever hit the LLM), just slower. Log it as an
    // expected degrade, not an error, so it doesn't read as something broken.
    // Genuine batch errors keep the error-level line with their message.
    const perTrackDegrade = /batch length mismatch/i.test(err.message || '');
    if (perTrackDegrade) {
      logEvent(
        'warning',
        `${consumer.label} didn't return one entry per track — tagging ` +
          `${songs.length} tracks individually this batch (expected for some models; just slower)`,
      );
    } else {
      logEvent(
        'error',
        `LLM batch failed (${songs.length} tracks) on ${consumer.label}: ${err.message} — falling back to per-track`,
      );
    }
    results = [];
    for (const song of input) {
      try {
        results.push(await tagOne(song, opts));
        state.callCount += 1;
      } catch (oneErr: any) {
        // Leg unusable mid-salvage (host died, or quota/auth) — bail the whole
        // batch (nothing upserted yet).
        if (consumer.pin && (isUnreachable(oneErr) || isQuotaOrAuthError(oneErr))) throw oneErr;
        console.error(`[tag] per-track tag failed on ${consumer.label}: ${oneErr.message}`);
        results.push(null);
      }
    }
  }

  let tagged = 0;
  for (let j = 0; j < songs.length; j++) {
    const result = results[j];
    if (!result) {
      state.errors += 1;
      continue;
    }
    const { moods, energy } = result;
    db.upsertTrackTags(songs[j].id, {
      moods,
      energy,
      source,
      confidence: null,
      promptHash,
      model: consumer.label,
    });
    tagged += 1;
  }
  return tagged;
}

// Drain the shared `batches` queue with one consumer. `shift()` between awaits
// is atomic (single-threaded event loop), so two consumers never pull the same
// batch. In dual mode a pinned consumer whose host dies requeues its batch and
// returns; `onDrop` reports how many legs remain.
async function runConsumer(
  batches: string[][],
  consumer: TagConsumer,
  promptHash: string,
  source: db.TagSource,
  total: number,
  state: TagState,
  phaseInfo: TagPhaseInfo,
  onDrop: ((err: any) => number) | null,
): Promise<void> {
  for (;;) {
    const batch = batches.shift();
    if (!batch) return;
    try {
      const n = await processBatch(batch, consumer, promptHash, source, state);
      state.tagged += n;
      state.byLeg[consumer.label] = (state.byLeg[consumer.label] || 0) + n;
    } catch (err: any) {
      // processBatch rethrows only when a pinned leg can't recover this run:
      // the host is down (isUnreachable) OR the provider refused the leg with a
      // quota / credit / usage-limit / auth error (isQuotaOrAuthError, #438).
      // Name the real reason — logging every drop as "unreachable" misdirected an
      // operator whose OpenRouter credits had simply run out (Discord).
      batches.unshift(batch);
      const remaining = onDrop ? onDrop(err) : 0;
      const reason = isQuotaOrAuthError(err) ? 'quota/credit/auth rejected' : 'host unreachable';
      logEvent(
        'error',
        `LLM leg ${consumer.label} dropped — ${reason}: ${errReason(err)} (${remaining} leg(s) left)`,
      );
      return;
    }
    state.processed += 1;
    if (state.processed % 4 === 0) {
      console.log(`[tag] LLM-tagged ${state.tagged}/${total}`);
    }
    reportProgress({
      phase: phaseInfo.phase,
      label: 'Tagging with LLM',
      done: state.tagged,
      total,
      round: phaseInfo.round,
      errors: state.errors || undefined,
      llm: { legs: state.byLeg },
    });
  }
}

// Phase 2 + phase 4 LLM tagging. One consumer (single-LLM mode, failover-capable
// calls) or two (dual-LLM mode, one pinned per leg) drain a shared batch queue.
async function llmTagInBatches(
  ids: string[],
  batchSize: number,
  promptHash: string,
  source: db.TagSource,
  consumers: TagConsumer[],
  phaseInfo: TagPhaseInfo,
): Promise<{ tagged: number; callCount: number; byLeg: Record<string, number> }> {
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += batchSize) batches.push(ids.slice(i, i + batchSize));

  const state: TagState = { tagged: 0, callCount: 0, processed: 0, errors: 0, byLeg: {} };
  reportProgress({
    phase: phaseInfo.phase,
    label: 'Tagging with LLM',
    done: 0,
    total: ids.length,
    round: phaseInfo.round,
  });

  if (consumers.length <= 1) {
    // Single consumer — no requeue/drop; the unpinned call already fails over
    // internally, so an error means the batch is genuinely unworkable this run.
    await runConsumer(batches, consumers[0], promptHash, source, ids.length, state, phaseInfo, null);
  } else {
    let alive = consumers.length;
    let quotaOrAuthDrop = false;
    await Promise.all(
      consumers.map(c =>
        runConsumer(batches, c, promptHash, source, ids.length, state, phaseInfo, (err: any) => {
          if (isQuotaOrAuthError(err)) quotaOrAuthDrop = true;
          return --alive;
        })),
    );
    if (batches.length > 0) {
      const abandoned = batches.reduce((n, b) => n + b.length, 0);
      const hint = quotaOrAuthDrop
        ? ' — a leg was refused for quota/credit/auth; check the provider credit balance, spend cap, or API key'
        : '';
      logEvent('warning', `All LLM legs dropped — ${abandoned} tracks left for next run${hint}`);
    }
  }
  return { tagged: state.tagged, callCount: state.callCount, byLeg: state.byLeg };
}

// Decide the LLM consumers for this run. Dual-LLM mode activates automatically
// when a fallback is configured, distinct from the primary, and its host answers
// a cheap probe — then both boxes tag in parallel off a shared queue. Otherwise a
// single failover-capable consumer (discussion #320).
async function resolveTagConsumers(): Promise<TagConsumer[]> {
  const primary = primaryLeg();
  const fb = fallbackLeg();
  if (!fb) return [{ label: primary.label }];

  const sameHost =
    (primary.cfg.ollamaUrl || '') === (fb.cfg.ollamaUrl || '') &&
    (primary.cfg.baseUrl || '') === (fb.cfg.baseUrl || '');
  if (fb.label === primary.label && sameHost) {
    logEvent('info', 'Fallback LLM identical to primary — single-LLM mode');
    return [{ label: primary.label }];
  }

  if (!(await probeLegReachable(fb))) {
    logEvent('info', `Fallback LLM (${fb.label}) unreachable — single-LLM mode`);
    return [{ label: primary.label }];
  }

  logEvent('info', `Dual-LLM mode active: primary=${primary.label} + fallback=${fb.label}`);
  return [
    { pin: 'primary', label: primary.label },
    { pin: 'fallback', label: fb.label },
  ];
}

// Explicitly exit on success. The local analyze backend (analyzer.ts) is a
// persistent stdio child that keeps the event loop alive, so returning from
// main() naturally would hang the CLI indefinitely after a *completed* run.
// Mirrors the --reconcile-only path's process.exit(0).
main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });

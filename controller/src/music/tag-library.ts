// Library tagger orchestrator (embedding-propagated).
//
// Pipeline (each phase short-circuits cleanly so partial runs make progress):
//   Phase 0  — ENRICH        fetch Last.fm tags + lyric excerpts, cache in DB;
//                            resolve compilation tracks' original release
//                            years via MusicBrainz (issue #842)
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
//                         promptHash keys off tagger-core.TAGGER_CONTRACT_VERSION
//                         + the live mood vocabulary, NOT the prompt text (#1548)
//                         — a semantic prompt change needs a manual version bump
//                         or this pass finds nothing stale.
//   --rescan              re-scan mode: fire ONLY the selected re-* passes, each
//                         scoped to already-done tracks; never forward-process the
//                         untagged remainder (set by the admin Re-scan tab)
//
// On boot the library-db auto-migrates any state/moods.json into the SQLite
// tracks table as legacy v1 entries (see library-db.ts).

import * as db from './library-db.js';
import * as settings from '../settings.js';
import * as embeddings from './embeddings.js';
import { selectSeeds } from './seed-selector.js';
import { selectEnrichIds } from './enrich-scope.js';
import { vote, fuseNeighbours } from './tag-propagator.js';
import { summariseEval, formatEvalSummary } from './propagation-eval.js';
import { activeModelLabel } from '../llm/provider.js';
import { setRawDebugStderrMirror } from '../llm/log.js';
import { TAGGER_CONTRACT_VERSION } from './tagger-core.js';
import { runAnalysisPass } from './analyze.js';
import { reportProgress, formatPhaseBreakdown, sortedPhaseTimings } from './tagger-progress.js';
import { planRun } from './rescan-scope.js';
import { acquireStandaloneLock, installPidfileCleanup } from './tagger-lock.js';
import { phaseEmbed } from './tag-library/embed.js';
import { logEvent } from './tag-library/log.js';
import { phaseEnrich } from './tag-library/enrich.js';
import {
  applyWizardOverlay,
  clamp01,
  parseFlags,
  reconcileOnly,
  walkNavidrome,
} from './tag-library/flags.js';
import { llmTagInBatches, resolveTagConsumers } from './tag-library/tag.js';
import { runPropagatedEnergyPass } from './propagated-energy.js';


// Close (and TRUNCATE-checkpoint) the library DB on every exit path — this CLI
// bails via process.exit() from several places, and a bulk run that skips the
// close leaves the WAL sidecar at its high-water mark forever (#786).
// db.close() is fully synchronous, so it's safe inside an 'exit' hook.
process.on('exit', () => {
  try { if (db.isOpen()) db.close(); } catch { /* best-effort */ }
});

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

  // The DB upserts emit when the model changes; record the current one, plus
  // the task-prefix mode this run embeds documents in. A reseed re-embeds
  // everything, so it adopts the active model's preferred mode; otherwise stay
  // consistent with how the existing vectors were embedded — query embeds must
  // match the documents (a legacy meta row with no mode = embedded bare).
  const textMode = flags.reseed
    ? embeddings.preferredTextMode()
    : embeddings.resolveIndexTextMode(db.getEmbeddingMeta()?.textMode, db.vectorCount());
  // The embed-text SHAPE the index carries (#1246), resolved on the same
  // "describe what's actually stored" rule as textMode above: a forward run
  // leaves older vectors untouched, so the index stays at the older format
  // until a reseed rebuilds it.
  const textFormat = embeddings.resolveIndexTextFormat(
    db.getEmbeddingMeta()?.textFormat, db.vectorCount(), flags.reseed,
  );
  db.setEmbeddingMeta(embeddings.activeModelLabel(), embeddingDim, textMode, textFormat);
  if (textMode === 'plain' && embeddings.preferredTextMode() === 'prefixed') {
    logEvent(
      'info',
      `${embeddings.activeModelLabel()} retrieves better with task prefixes — run ` +
        `“Re-embed all tracks” (admin Re-scan tab, or --reseed) once to upgrade the index.`,
    );
  }

  // Tunables from settings.embedding, CLI flags override where present.
  const embedCfg: any = (settings.get() as any).embedding ?? {};
  const maxRounds = flags.maxRounds ?? Math.max(0, embedCfg.maxActiveLearningRounds ?? 3);
  const tagBatchSize = flags.batchSize ?? Math.max(1, Math.min(50, embedCfg.batchSize ?? 25));
  // Fallbacks kept in sync with DEFAULTS.embedding in settings.ts (settings.get()
  // normally supplies these; the ?? only bites if the field is entirely absent).
  const knnK = Math.max(1, embedCfg.knnNeighbours ?? 10);
  const moodVoteThreshold = clamp01(embedCfg.moodVoteThreshold ?? 0.4);
  const confidenceThreshold = clamp01(embedCfg.confidenceThreshold ?? 0.35);
  const seedCountCfg =
    typeof embedCfg.seedCount === 'number' && embedCfg.seedCount > 0
      ? embedCfg.seedCount
      : null;

  // Shared vote plumbing for phase 3, the phase-4 re-propagation rounds and the
  // post-run self-check: KNN → neighbour-tag lookup → similarity-weighted vote.
  //
  // Same-album+artist neighbours vote at HALF weight: a text embedding is
  // dominated by artist/album, so a track's KNN list is mostly its own album
  // mates, and at full weight one mistagged seed swept the whole album while
  // cross-album corroboration never got a say.
  //
  // With a CLAP "sounds-like" vector, audio-KNN neighbours fuse in at
  // audioFusionWeight before the vote — sound is the stronger mood signal for
  // instrumentals and thin-metadata tracks, and CLAP doesn't cluster by album.
  // knnAudioById returns [] for un-analysed tracks, so fusion degrades to
  // text-only per track, not per run.
  const SAME_ALBUM_WEIGHT = 0.5;
  // Same artist, DIFFERENT album — damped too. On a label-only text index (no
  // Last.fm key, no lyrics, no CLAP) "nearest neighbours" is mostly the
  // artist's own catalogue, and album-only damping left the dominant relation
  // voting at full weight: one artist's early tags swept the rest of their
  // catalogue, then — via the propagation rounds — their whole neighbourhood.
  const SAME_ARTIST_WEIGHT = 0.6;
  // A voter whose own moods were themselves PROPAGATED (not decided by the
  // LLM/operator/audio) speaks at reduced weight: phase 4 re-runs the vote up
  // to 3 rounds and round-n labels voting in round n+1 at full weight is a
  // feedback loop with no damping term — the measurement side already refuses
  // propagated rows for exactly this circularity (trustedTaggedIds).
  const PROPAGATED_VOTE_WEIGHT = 0.7;
  const audioFusionWeight = clamp01(embedCfg.audioFusionWeight ?? 0.5);
  const voteForTrack = (id: string) => {
    const target = db.getTrack(id);
    const textNeighbours = db.knnById(id, knnK);
    const neighbours =
      audioFusionWeight > 0
        ? fuseNeighbours(textNeighbours, db.knnAudioById(id, knnK), audioFusionWeight, knnK)
        : textNeighbours;
    return vote(
      neighbours,
      (nId) => {
        const t = db.getTrack(nId);
        if (!t || t.moods.length === 0) return null;
        return { moods: t.moods, energy: t.energy };
      },
      {
        moodVoteThreshold,
        k: knnK,
        weightOf: (nId) => {
          const n = db.getTrack(nId);
          let w = 1;
          if (target?.artist && n?.artist === target.artist) {
            w = target?.album && n?.album === target.album
              ? SAME_ALBUM_WEIGHT
              : SAME_ARTIST_WEIGHT;
          }
          // Multiplied, not min-ed: a same-artist propagated voter is both
          // relations at once and should be doubly damped.
          if (n?.source === 'propagated') w *= PROPAGATED_VOTE_WEIGHT;
          return w;
        },
      },
    );
  };

  logEvent('info', `Starting up — ${db.allTaggedIds().length.toLocaleString('en-GB')} tracks already tagged`);
  logEvent('info', `Tagging model — ${activeModelLabel()}`);
  logEvent('info', `Embedding model — ${embeddings.activeModelLabel()} (dim=${embeddingDim})`);
  console.log(
    `[tag] batch=${tagBatchSize} maxRounds=${maxRounds} knnK=${knnK} ` +
      `moodVote=${moodVoteThreshold} confidence=${confidenceThreshold} ` +
      `audioFusion=${audioFusionWeight}`,
  );
  if (audioFusionWeight > 0) {
    const audioVecs = db.audioVectorCount();
    if (audioVecs > 0) {
      logEvent(
        'info',
        `Audio fusion on — ${audioVecs.toLocaleString('en-GB')} sounds-like vectors ` +
          `join the mood vote (weight ${audioFusionWeight})`,
      );
    }
  }

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

  const promptHash = embeddings.promptVocabHash(TAGGER_CONTRACT_VERSION);
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
    await phaseEmbed(targetUntagged, tagBatchSize, textMode);
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
      // k-means diversity layer. db.getVector is a direct single-row read
      // (SELECT embedding WHERE id = ?) — the per-candidate KNN-scan cost the
      // old note warned about predates getVector()/allAudioVectors() and no
      // longer exists; the selector also bounds its own pool and cluster
      // count (KMEANS_POOL_CAP/KMEANS_MAX_K) with an incremental k-means++
      // init, so this is seconds, not hours, on a large library. Candidates
      // without a vector yet return null and drop out inside the selector;
      // the shortfall tops up randomly (kmeans-topup).
      embeddingForId: (id) => db.getVector(id),
    });
    console.log(
      `[tag] seeds: ${seedSelection.seeds.length} new ` +
        `(layer counts: ${JSON.stringify(seedSelection.layerCounts)})`,
    );

    if (seedSelection.seeds.length > 0) {
      const tagged = await llmTagInBatches(
        seedSelection.seeds, tagBatchSize, promptHash, 'llm', tagConsumers, { phase: 'seed' },
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
      const result = voteForTrack(id);
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
        tagBatchSize,
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
        const result = voteForTrack(id);
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

    // ---- Self-check: held-out propagation agreement ------------------------
    // Re-run the production vote on a sample of directly-decided tracks (KNN
    // excludes self, so a track's own tags never vote for it) and score
    // against the stored truth. A relative signal for judging knob changes
    // (knnK, thresholds, vote weighting) run-over-run — NOT a benchmark; see
    // propagation-eval.ts for the circularity caveat. ~150 KNN scans,
    // negligible next to phases 1-4. Best-effort: never fails the run.
    try {
      const truth = db.trustedTaggedIds();
      if (truth.length >= 20) {
        const SAMPLE = 150;
        // Partial Fisher-Yates — shuffle just the head we sample.
        const pool = [...truth];
        const n = Math.min(SAMPLE, pool.length);
        for (let i = 0; i < n; i++) {
          const j = i + Math.floor(Math.random() * (pool.length - i));
          [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        const cases = pool.slice(0, n).map((id) => {
          const t = db.getTrack(id)!;
          return { actual: { moods: t.moods, energy: t.energy }, result: voteForTrack(id) };
        });
        logEvent('info', formatEvalSummary(summariseEval(cases, confidenceThreshold)));
      }
    } catch (err: any) {
      console.log(`[tag] propagation self-check failed: ${err?.message || err}`);
    }
    lap('eval');

    // ---- Audio-derived energy over the rows phases 3-4 just propagated -----
    // A propagated energy is inherited from neighbours, not judged from this
    // track; where the analyzer's stored mood cosines are decisive about the
    // track's arousal, they overrule it (#1362). Runs here rather than inside
    // the propagation loop so there is ONE correction path shared with the
    // analysis pass — a library can gain audio scores long after it was
    // tagged, and that case has to work too. Best-effort: never fails the run.
    try {
      runPropagatedEnergyPass();
    } catch (err: any) {
      console.log(`[tag] audio energy pass failed: ${err?.message || err}`);
    }
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
    await phaseEmbed(reembedIds, tagBatchSize, textMode);
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
        stale, tagBatchSize, promptHash, 'llm', tagConsumers, { phase: 'seed' },
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

// Explicitly exit on success. The local analyze backend (analyzer.ts) is a
// persistent stdio child that keeps the event loop alive, so returning from
// main() naturally would hang the CLI indefinitely after a *completed* run.
// Mirrors the --reconcile-only path's process.exit(0).
main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });

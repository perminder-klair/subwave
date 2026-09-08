// Library tagger orchestrator. Phases: 0 enrich → 1 embed → 2 seed →
// 3 KNN-propagate → 4 active-learn → 5 acoustic analyze. Each phase
// short-circuits cleanly so partial runs make progress.
//
// Run:  docker exec sub-wave-controller npx tsx src/music/tag-library.ts
// Flags:
//   --limit N             cap NEW tracks considered this run (default: all)
//   --batch N             LLM batch size (default 25)
//   --seeds N             override seed budget
//   --max-rounds N        cap active-learning rounds (default 3)
//   --no-propagate        only embed + seed, skip phases 3-4 (debug)
//   --reseed              drop + rebuild track_vectors; re-embed from scratch
//   --re-enrich           null out enrichment cache and re-fetch from Navidrome
//   --skip-enrich         embed using metadata only (debug)
//   --skip-analyze        skip the acoustic bpm/key pass (Phase 5)
//   --skip-tag            skip embed + mood tagging (phases 1-4); walk/enrich/
//                         analyze still run per their flags
//   --no-prune            walk Navidrome but don't drop orphaned rows
//   --vocal / --no-vocal  force the Phase-5 Demucs vocal pass on / off (else
//                         defers to settings.audio.vocalActivity)
//   --upgrade             re-LLM-tag tagged rows with stale promptHash/model
//                         (never source='manual'). promptHash keys off
//                         TAGGER_CONTRACT_VERSION + the mood vocabulary, not
//                         the prompt text (#1548).
//   --rescan              fire ONLY the selected re-* passes, each scoped to
//                         already-done tracks; never forward-process the
//                         untagged remainder

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


// Close (TRUNCATE-checkpoints the WAL) on every exit path; this CLI bails via
// process.exit() from several places (#786). db.close() is synchronous, so it
// is safe in an 'exit' hook.
process.on('exit', () => {
  try { if (db.isOpen()) db.close(); } catch { /* best-effort */ }
});

async function main() {
  const flags = parseFlags();
  const startedAt = Date.now();

  // Mute the stderr mirror of the raw-LLM debug capture; the file still gets it.
  setRawDebugStderrMirror(false);

  // Single-flight: no-op for a controller-spawned run (already pidfiled). A
  // manual `npm run tag` claims the lock so it can't become a second DB writer.
  let ownsLock = false;
  try {
    ownsLock = acquireStandaloneLock(flags.reconcileOnly ? 'reconcile' : 'tag', process.argv.slice(2));
  } catch (err: any) {
    console.error(`[tag] ${err.message}`);
    process.exit(1);
  }
  if (ownsLock) installPidfileCleanup();

  // Per-phase wall-clock: lap(name) attributes the time since the previous lap.
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

  // Preflight before opening the DB or walking Navidrome (#174, #319). The probe
  // reports the dimension measured from a real vector, which beats the name→dim
  // guess, so an arbitrarily-named embedding model works.
  const probe = await embeddings.ensureReady();
  if (probe.code !== 'ok') {
    logEvent('error', `Embedding preflight failed (${probe.code}): ${probe.message}`);
    process.exit(1);
  }
  const embeddingDim = probe.dim ?? embeddings.resolveEmbeddingDim();

  // reseed lets open() recover from a model/dim swap instead of throwing the
  // dim-mismatch before the --reseed logic below runs (#307). Same-dim: no-op.
  await db.open({ embeddingDim, reseed: flags.reseed });

  // Task-prefix mode this run embeds documents in. A reseed re-embeds
  // everything so it adopts the active model's preferred mode; otherwise stay
  // consistent with the stored vectors, since query embeds must match the
  // documents (a legacy meta row with no mode = embedded bare).
  const textMode = flags.reseed
    ? embeddings.preferredTextMode()
    : embeddings.resolveIndexTextMode(db.getEmbeddingMeta()?.textMode, db.vectorCount());
  // Embed-text shape the index carries (#1246), same "describe what's stored"
  // rule as textMode: stays at the older format until a reseed rebuilds it.
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

  // Tunables from settings.embedding, CLI flags override where present. The ??
  // fallbacks mirror DEFAULTS.embedding in settings.ts.
  const embedCfg: any = (settings.get() as any).embedding ?? {};
  const maxRounds = flags.maxRounds ?? Math.max(0, embedCfg.maxActiveLearningRounds ?? 3);
  const tagBatchSize = flags.batchSize ?? Math.max(1, Math.min(50, embedCfg.batchSize ?? 25));
  const knnK = Math.max(1, embedCfg.knnNeighbours ?? 10);
  const moodVoteThreshold = clamp01(embedCfg.moodVoteThreshold ?? 0.4);
  const confidenceThreshold = clamp01(embedCfg.confidenceThreshold ?? 0.35);
  const seedCountCfg =
    typeof embedCfg.seedCount === 'number' && embedCfg.seedCount > 0
      ? embedCfg.seedCount
      : null;

  // Shared vote plumbing for phase 3, the phase-4 re-propagation rounds and the
  // post-run self-check: KNN → neighbour-tag lookup → similarity-weighted vote.
  // Audio-KNN neighbours fuse in at audioFusionWeight first; knnAudioById
  // returns [] for un-analysed tracks, so fusion degrades to text-only per
  // track, not per run.
  //
  // The three damping weights all exist because a text embedding clusters by
  // artist/album, so an undamped vote lets one mistagged seed sweep a whole
  // album or catalogue, and a propagated voter feeding the next round is an
  // undamped feedback loop.
  const SAME_ALBUM_WEIGHT = 0.5;
  const SAME_ARTIST_WEIGHT = 0.6;
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
          // relations at once.
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

  // Only a re-scan re-embed needs this snapshot; a normal --reseed rebuilds as
  // part of its forward pass.
  let reembedIds: string[] = [];
  if (flags.reseed) {
    // A same-dim reseed still has the old vectors here, so this captures the
    // already-embedded population. A dim-change reseed already had
    // track_vectors dropped inside open(), so it comes back empty.
    if (flags.rescan) reembedIds = db.embeddedIds();
    console.log('[tag] --reseed: dropping track_vectors, re-embedding from scratch');
    db.dropVectors();
    // Dim change wiped the vectors before the snapshot, so rebuild everything
    // that now needs a vector — otherwise the pass rebuilds 0 on exactly the
    // model swap it advertises.
    if (flags.rescan && reembedIds.length === 0) reembedIds = db.unembeddedIds();
  }

  const promptHash = embeddings.promptVocabHash(TAGGER_CONTRACT_VERSION);
  const modelLabel = activeModelLabel();

  // Single- vs dual-LLM tagging: probed once here, not per phase, so the banner
  // prints once.
  const tagConsumers = await resolveTagConsumers();
  const byLeg: Record<string, number> = {};
  const mergeByLeg = (m: Record<string, number>) => {
    for (const [k, v] of Object.entries(m)) byLeg[k] = (byLeg[k] || 0) + v;
  };

  // Walk Navidrome and upsert track metadata, so later phases work purely off SQL.
  lap('setup');
  console.log('[tag] walking Navidrome library...');
  const { walked, liveIds } = await walkNavidrome();

  // The walk is authoritative, so a row it didn't see is gone from Navidrome;
  // pruning keeps coverage/untagged/analysis scope honest. Guarded on a
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

  // Which phases run this pass (pure; pinned by rescan-scope.test.ts).
  const plan = planRun(flags);

  // Forward scope: the untagged tracks this run discovers and tags, capped by
  // --limit. A re-scan's forward scope is empty — each re-* pass below redoes
  // only tracks that already carry that artifact, never the remainder.
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

  // Phase 0: ENRICH. Normal runs enrich only the in-scope untagged tracks;
  // --re-enrich widens scope to the whole walked catalogue, since untagged is
  // empty on a fully-tagged library (#531). phaseEnrich bypasses the per-track
  // enrichedAt cache when reEnrich is set; --limit still caps the count.
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

  // Phases 1-4 (embed → seed → propagate → active-learn), the "Tag moods" step.
  // A re-scan suppresses them and runs the scoped re-embed / re-decide passes
  // below instead. llmCalls/llmTagged are hoisted so finish() still reports 0
  // when tagging is skipped.
  let llmCalls = 0;
  let llmTagged = 0;
  if (plan.forwardTag) {
    await phaseEmbed(targetUntagged, tagBatchSize, textMode);
    lap('embed');

    // Phase 2: SEED. CLI --seeds wins, then settings.embedding.seedCount, then
    // auto. --limit also clamps to the in-scope size.
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
      // --limit must reach the seed layer too, or layers 2-4 pull picks from
      // the full untagged pool. Bulk runs pass undefined.
      untaggedPool: limited ? new Set(targetUntagged) : undefined,
      // k-means diversity layer. Candidates without a vector return null and
      // drop out inside the selector; the shortfall tops up randomly.
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

    // Phase 3: PROPAGATE, over in-scope tracks that have an embedding. Tracks
    // without vectors have no neighbours and would just burn phase-4 budget.
    let propagated = 0;
    let uncertain: string[] = [];
    let scanned = 0;

    reportProgress({ phase: 'propagate', label: 'Propagating tags to neighbours', done: 0, total: targetUntagged.length });
    for (const id of targetUntagged) {
      scanned += 1;
      // Synchronous loop; emit sparsely so a 30k-track scan doesn't spam stdout.
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

    // Phase 4: ACTIVE-LEARN.
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

      // Re-propagate over in-scope tracks still untagged after this LLM round.
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

    // Self-check: re-run the vote on a sample of directly-decided tracks (KNN
    // excludes self) and score against the stored truth. A relative signal for
    // judging knob changes run-over-run, not a benchmark (see
    // propagation-eval.ts). Best-effort: never fails the run.
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

    // Audio-derived energy over the rows phases 3-4 propagated: decisive stored
    // mood cosines overrule an inherited energy (#1362). Runs here, not inside
    // the propagation loop, so it stays ONE correction path shared with the
    // analysis pass (a library can gain audio scores long after tagging).
    // Best-effort: never fails the run.
    try {
      runPropagatedEnergyPass();
    } catch (err: any) {
      console.log(`[tag] audio energy pass failed: ${err?.message || err}`);
    }
  } else if (flags.skipTag) {
    console.log('[tag] --skip-tag: skipping embed + mood tagging (phases 1-4)');
  }

  // Re-scan RE-EMBED: rebuild vectors under the new embedding model, from the
  // scope resolved above, so the KNN graph the existing tags anchor is restored.
  if (plan.reEmbed) {
    console.log(`[tag] re-embed: rebuilding ${reembedIds.length} vectors from scratch`);
    await phaseEmbed(reembedIds, tagBatchSize, textMode);
    lap('embed');
  }

  // Re-scan RE-DECIDE: re-LLM-tag tagged rows whose prompt or model went stale
  // (never manual). Scoped to the tagged set, never the untagged remainder.
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

  // Phase 5: ANALYZE (acoustic bpm/key/intro), the same pass as `npm run
  // analyze`. No-ops when no analysis backend is reachable, so it never blocks
  // a tag run.
  if (plan.analyze) {
    try {
      await runAnalysisPass({
        limit: flags.limit === Infinity ? undefined : flags.limit,
        reAnalyze: flags.reAnalyze,
        rescan: flags.rescan,
        // Tri-state; undefined defers to settings.audio.vocalActivity / env.
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
  // ~4% of the library, floored at 200 and capped at 2500; propagation carries
  // the rest. MIRROR: web/components/admin/LibraryTaggingModal.tsx `seedBudget`
  // replicates this for the Run-tab cost preview — keep the constants in sync.
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
  // Phase breakdown, slowest first.
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
  // One-line summary; a full per-genre/per-mood breakdown buries the phase
  // timings in the run log and the admin log drawer.
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

// Exit explicitly: analyzer.ts's local backend is a persistent stdio child that
// keeps the event loop alive, so a completed run would otherwise hang the CLI.
main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });

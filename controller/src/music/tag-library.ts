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
//   --upgrade             re-tag only rows with stale promptHash or model
//
// On boot the library-db auto-migrates any state/moods.json into the SQLite
// tracks table as legacy v1 entries (see library-db.ts).

import * as subsonic from './subsonic.js';
import * as db from './library-db.js';
import * as settings from '../settings.js';
import * as embeddings from './embeddings.js';
import { selectSeeds } from './seed-selector.js';
import { vote } from './tag-propagator.js';
import { config } from '../config.js';
import { loadSecretsIntoEnv } from '../setup/secrets.js';
import { loadSetupConfig } from '../setup/config.js';
import { activeModelLabel, primaryLeg, fallbackLeg, probeLegReachable } from '../llm/provider.js';
import { isUnreachable } from '../llm/sdk.js';
import { tagBatch, tagOne, TAGGER_BATCH_SYSTEM, type TagResult } from './tagger-core.js';
import { runAnalysisPass } from './analyze.js';

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
    upgrade: args.includes('--upgrade'),
    skipAnalyze: args.includes('--skip-analyze'),
    reAnalyze: args.includes('--re-analyze'),
  };
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

  await applyWizardOverlay();
  await settings.load();

  if (!embeddings.isAvailable()) {
    console.error('[tag] embeddings not available — set settings.embedding.enabled / provider');
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
    console.error(`[tag] embedding preflight failed (${probe.code}):\n${probe.message}`);
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
  const knnK = Math.max(1, embedCfg.knnNeighbours ?? 5);
  const moodVoteThreshold = clamp01(embedCfg.moodVoteThreshold ?? 0.6);
  const confidenceThreshold = clamp01(embedCfg.confidenceThreshold ?? 0.6);
  const seedCountCfg =
    typeof embedCfg.seedCount === 'number' && embedCfg.seedCount > 0
      ? embedCfg.seedCount
      : null;

  console.log(`[tag] starting. ${db.allTaggedIds().length} tracks already tagged.`);
  console.log(`[tag] LLM model: ${activeModelLabel()}`);
  console.log(`[tag] embedding model: ${embeddings.activeModelLabel()} (dim=${embeddingDim})`);
  console.log(
    `[tag] batch=${flags.batchSize} maxRounds=${maxRounds} knnK=${knnK} ` +
      `moodVote=${moodVoteThreshold} confidence=${confidenceThreshold}`,
  );

  if (flags.reseed) {
    console.log('[tag] --reseed: dropping track_vectors, re-embedding from scratch');
    db.dropVectors();
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
  console.log('[tag] walking Navidrome library...');
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
    if (walked % 500 === 0) console.log(`[tag] walked ${walked} tracks`);
  }
  console.log(`[tag] walked ${walked} total tracks`);

  // Reconcile against the live catalogue. The walk above is complete and
  // authoritative, so any track row it didn't see is gone from Navidrome
  // (typically after a full rescan that re-mints IDs). Pruning the orphans
  // keeps coverage %, untagged scope and analysis scope honest. Guarded on a
  // non-empty walk so a transient empty Navidrome response can't wipe the DB.
  if (walked > 0) {
    const pruned = db.pruneMissingTracks(liveIds);
    if (pruned > 0) {
      console.log(`[tag] pruned ${pruned} orphaned tracks no longer in Navidrome`);
    }
  }

  // Honour --limit by capping how many NEW tracks we work on this run.
  // We do this by selecting the first N untagged ids; ones beyond the cap
  // wait for the next run.
  const allUntagged = db.untaggedIds();
  const targetUntagged =
    flags.limit === Infinity ? allUntagged : allUntagged.slice(0, flags.limit);
  console.log(
    `[tag] ${targetUntagged.length} untagged tracks in scope this run (of ${allUntagged.length} total untagged)`,
  );

  // ---- Phase 0: ENRICH ---------------------------------------------------
  if (!flags.skipEnrich) {
    await phaseEnrich(targetUntagged, flags.reEnrich);
  } else {
    console.log('[tag] --skip-enrich: not fetching Last.fm tags or lyrics');
  }

  // ---- Phase 1: EMBED ----------------------------------------------------
  await phaseEmbed(targetUntagged, flags.batchSize);

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

  let llmCalls = 0;
  let llmTagged = 0;
  if (seedSelection.seeds.length > 0) {
    const tagged = await llmTagInBatches(seedSelection.seeds, flags.batchSize, promptHash, 'llm', tagConsumers);
    llmCalls += tagged.callCount;
    llmTagged += tagged.tagged;
    mergeByLeg(tagged.byLeg);
    console.log(`[tag] phase-2 done: ${tagged.tagged}/${seedSelection.seeds.length} seeded`);
  }

  if (flags.noPropagate) {
    console.log('[tag] --no-propagate: stopping after seed phase');
    return finish(startedAt, llmCalls, llmTagged, byLeg);
  }

  // ---- Phase 3: PROPAGATE ------------------------------------------------
  // Only operate on tracks that (a) are in this run's scope and (b) have an
  // embedding. Tracks without vectors can't have neighbours; they'd just get
  // marked uncertain and burn LLM budget in phase 4.
  // knnK, moodVoteThreshold, confidenceThreshold all sourced from
  // settings.embedding above.
  let propagated = 0;
  let uncertain: string[] = [];

  for (const id of targetUntagged) {
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
  console.log(`[tag] phase-3 propagated ${propagated} tracks; ${uncertain.length} uncertain (in scope)`);

  // ---- Phase 4: ACTIVE-LEARN --------------------------------------------
  for (let round = 1; round <= maxRounds; round++) {
    if (uncertain.length === 0) break;
    console.log(`[tag] phase-4 round ${round}: LLM-tagging ${uncertain.length} uncertain`);
    const tagged = await llmTagInBatches(
      uncertain,
      flags.batchSize,
      promptHash,
      'uncertain-llm',
      tagConsumers,
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

  // ---- Phase 5: ANALYZE (acoustic bpm/key/intro) -------------------------
  // Independent of mood tagging — runs the same pass as `npm run analyze`.
  // No-ops cleanly when no analysis backend (tts-heavy sidecar / local
  // librosa venv) is reachable, so it never blocks a tag run.
  if (!flags.skipAnalyze) {
    try {
      await runAnalysisPass({
        limit: flags.limit === Infinity ? undefined : flags.limit,
        reAnalyze: flags.reAnalyze,
      });
    } catch (err: any) {
      console.error(`[tag] analysis phase failed (non-fatal): ${err?.message || err}`);
    }
  }

  finish(startedAt, llmCalls, llmTagged, byLeg);
}

function autoSeedCount(librarySize: number): number {
  return Math.max(200, Math.ceil(Math.sqrt(librarySize)));
}

function finish(startedAt: number, llmCalls: number, llmTagged: number, byLeg: Record<string, number>) {
  const elapsed = (Date.now() - startedAt) / 1000;
  console.log(
    `\n[tag] done in ${elapsed.toFixed(0)}s. llm_calls=${llmCalls} llm_tagged=${llmTagged}`,
  );
  const legs = Object.entries(byLeg);
  if (legs.length > 1) {
    console.log(`[tag] per-leg: ${legs.map(([m, n]) => `${m}=${n}`).join(' · ')}`);
  }
  console.log('[stats]', JSON.stringify(db.stats(), null, 2));
}

// ---------------------------------------------------------------------------
// Phase 0 — Enrichment (Last.fm tags + lyric excerpts)
// ---------------------------------------------------------------------------

async function phaseEnrich(ids: string[], reEnrich: boolean): Promise<void> {
  if (ids.length === 0) return;
  const enrichCfg = (settings.get() as any).embedding?.enrichment ?? {};
  const lastfmEnabled = enrichCfg.lastfmTags !== false;
  const lyricsEnabled = enrichCfg.lyrics !== false;
  if (!lastfmEnabled && !lyricsEnabled) {
    console.log('[tag] phase-0 skipped: both lastfmTags and lyrics disabled in settings.embedding.enrichment');
    return;
  }
  const artistTagCache = new Map<string, string[]>();
  let enrichedTracks = 0;
  let enrichedLyrics = 0;
  let enrichedTags = 0;

  for (const id of ids) {
    const t = db.getTrack(id);
    if (!t) continue;
    if (!reEnrich && t.enrichedAt) continue;

    let lastfmTags: string[] | null = null;
    if (lastfmEnabled && t.artist) {
      const cacheKey = t.artist;
      if (artistTagCache.has(cacheKey)) {
        lastfmTags = artistTagCache.get(cacheKey) ?? null;
      } else {
        try {
          const matches = await subsonic.searchArtists(t.artist, { artistCount: 1 });
          const artistId = matches?.[0]?.id;
          if (artistId) {
            const tags = await subsonic.getArtistLastfmTags(artistId, { count: 10 });
            lastfmTags = tags;
          }
        } catch { /* ignore */ }
        artistTagCache.set(cacheKey, lastfmTags ?? []);
      }
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

    db.upsertTrackEnrichment(id, {
      lastfmTags: lastfmTags && lastfmTags.length ? lastfmTags : null,
      lyricExcerpt,
    });
    enrichedTracks += 1;
    if (lastfmTags && lastfmTags.length) enrichedTags += 1;
    if (lyricExcerpt) enrichedLyrics += 1;
    if (enrichedTracks % 100 === 0) {
      console.log(
        `[tag] enriched ${enrichedTracks}/${ids.length} (lastfm: ${enrichedTags}, lyrics: ${enrichedLyrics})`,
      );
    }
  }
  console.log(
    `[tag] phase-0 done: enriched ${enrichedTracks} tracks (lastfm: ${enrichedTags}, lyrics: ${enrichedLyrics})`,
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
  console.log(`[tag] phase-1 embedding ${unique.length} tracks (batch=${batchSize})`);

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
  byLeg: Record<string, number>;
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
    // A pinned leg whose host went down: rethrow BEFORE the per-track salvage,
    // otherwise we'd grind 25 serial connect-timeouts against a dead box. The
    // surviving consumer redoes the requeued batch.
    if (consumer.pin && isUnreachable(err)) throw err;
    console.error(
      `[tag] LLM batch failed (${songs.length} tracks) on ${consumer.label}: ${err.message} — falling back to per-track`,
    );
    results = [];
    for (const song of input) {
      try {
        results.push(await tagOne(song, opts));
        state.callCount += 1;
      } catch (oneErr: any) {
        // Host died mid-salvage — bail the whole batch (nothing upserted yet).
        if (consumer.pin && isUnreachable(oneErr)) throw oneErr;
        console.error(`[tag] per-track tag failed on ${consumer.label}: ${oneErr.message}`);
        results.push(null);
      }
    }
  }

  let tagged = 0;
  for (let j = 0; j < songs.length; j++) {
    const result = results[j];
    if (!result) continue;
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
  onDrop: (() => number) | null,
): Promise<void> {
  for (;;) {
    const batch = batches.shift();
    if (!batch) return;
    try {
      const n = await processBatch(batch, consumer, promptHash, source, state);
      state.tagged += n;
      state.byLeg[consumer.label] = (state.byLeg[consumer.label] || 0) + n;
    } catch {
      // processBatch only throws on a pinned-leg host outage.
      batches.unshift(batch);
      const remaining = onDrop ? onDrop() : 0;
      console.log(
        `[tag] LLM leg ${consumer.label} unreachable — dropping it (${remaining} leg(s) left)`,
      );
      return;
    }
    state.processed += 1;
    if (state.processed % 4 === 0) {
      console.log(`[tag] LLM-tagged ${state.tagged}/${total}`);
    }
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
): Promise<{ tagged: number; callCount: number; byLeg: Record<string, number> }> {
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += batchSize) batches.push(ids.slice(i, i + batchSize));

  const state: TagState = { tagged: 0, callCount: 0, processed: 0, byLeg: {} };

  if (consumers.length <= 1) {
    // Single consumer — no requeue/drop; the unpinned call already fails over
    // internally, so an error means the batch is genuinely unworkable this run.
    await runConsumer(batches, consumers[0], promptHash, source, ids.length, state, null);
  } else {
    let alive = consumers.length;
    await Promise.all(
      consumers.map(c =>
        runConsumer(batches, c, promptHash, source, ids.length, state, () => --alive)),
    );
    if (batches.length > 0) {
      const abandoned = batches.reduce((n, b) => n + b.length, 0);
      console.log(`[tag] all LLM legs unreachable — ${abandoned} tracks left for next run`);
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
    console.log('[tag] fallback LLM identical to primary — single-LLM mode');
    return [{ label: primary.label }];
  }

  if (!(await probeLegReachable(fb))) {
    console.log(`[tag] fallback LLM (${fb.label}) unreachable — single-LLM mode`);
    return [{ label: primary.label }];
  }

  console.log(`[tag] dual-LLM mode active: primary=${primary.label} + fallback=${fb.label}`);
  return [
    { pin: 'primary', label: primary.label },
    { pin: 'fallback', label: fb.label },
  ];
}

main().catch(err => { console.error(err); process.exit(1); });

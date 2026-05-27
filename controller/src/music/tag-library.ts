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
import { activeModelLabel } from '../llm/provider.js';
import { tagBatch, TAGGER_BATCH_SYSTEM } from './tagger-core.js';

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

  const embeddingDim = embeddings.resolveEmbeddingDim();
  await db.open({ embeddingDim });

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

  if (!embeddings.isAvailable()) {
    console.error('[tag] embeddings not available — set settings.embedding.enabled / provider');
    process.exit(1);
  }

  const promptHash = embeddings.promptVocabHash(TAGGER_BATCH_SYSTEM);
  const modelLabel = activeModelLabel();

  // ---- Phase A: iterate Navidrome and upsert track metadata into DB ------
  // Cheap; ensures every Navidrome song is in the tracks table so subsequent
  // phases can operate purely off SQL.
  console.log('[tag] walking Navidrome library...');
  let walked = 0;
  for await (const song of subsonic.iterateAllSongs()) {
    db.upsertTrackMeta(song.id, {
      title: song.title,
      artist: song.artist,
      album: song.album,
      year: song.year,
      genre: song.genre,
      duration: song.duration,
    });
    walked += 1;
    if (walked % 500 === 0) console.log(`[tag] walked ${walked} tracks`);
  }
  console.log(`[tag] walked ${walked} total tracks`);

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
  const seedCount = flags.seedCount ?? seedCountCfg ?? autoSeedCount(walked);
  console.log(`[tag] seed budget: ${seedCount}`);

  const seedSelection = await selectSeeds({
    seedCount,
    embeddingForId: (id) => {
      // For k-means clustering, hand a Float32Array if we have it (we may
      // not in the very first run; that's fine — the selector falls back
      // to random sampling within the unembedded pool).
      const hits = db.knnById(id, 1);
      if (hits.length === 0) return null;
      // We don't have a direct vector-read API on library-db today; in v1
      // the k-means fallback is good enough and we can add one later. For
      // now: returning null routes seed-selector to its non-k-means path.
      return null;
    },
  });
  console.log(
    `[tag] seeds: ${seedSelection.seeds.length} new ` +
      `(layer counts: ${JSON.stringify(seedSelection.layerCounts)})`,
  );

  let llmCalls = 0;
  let llmTagged = 0;
  if (seedSelection.seeds.length > 0) {
    const tagged = await llmTagInBatches(seedSelection.seeds, flags.batchSize, promptHash, modelLabel, 'llm');
    llmCalls += tagged.callCount;
    llmTagged += tagged.tagged;
    console.log(`[tag] phase-2 done: ${tagged.tagged}/${seedSelection.seeds.length} seeded`);
  }

  if (flags.noPropagate) {
    console.log('[tag] --no-propagate: stopping after seed phase');
    return finish(startedAt, llmCalls, llmTagged);
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
      modelLabel,
      'uncertain-llm',
    );
    llmCalls += tagged.callCount;
    llmTagged += tagged.tagged;

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

  finish(startedAt, llmCalls, llmTagged);
}

function autoSeedCount(librarySize: number): number {
  return Math.max(200, Math.ceil(Math.sqrt(librarySize)));
}

function finish(startedAt: number, llmCalls: number, llmTagged: number) {
  const elapsed = (Date.now() - startedAt) / 1000;
  console.log(
    `\n[tag] done in ${elapsed.toFixed(0)}s. llm_calls=${llmCalls} llm_tagged=${llmTagged}`,
  );
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

async function llmTagInBatches(
  ids: string[],
  batchSize: number,
  promptHash: string,
  modelLabel: string,
  source: db.TagSource,
): Promise<{ tagged: number; callCount: number }> {
  let tagged = 0;
  let callCount = 0;
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const songs = batch.map(id => db.getTrack(id)).filter((t): t is db.TrackRecord => !!t);
    if (songs.length === 0) continue;
    const input = songs.map(t => ({
      title: t.title ?? undefined,
      artist: t.artist ?? undefined,
      album: t.album ?? undefined,
      year: t.year ?? undefined,
      genre: t.genre ?? undefined,
    }));
    let results;
    try {
      results = await tagBatch(input);
      callCount += 1;
    } catch (err: any) {
      console.error(`[tag] LLM batch failed (${songs.length} tracks): ${err.message}`);
      continue;
    }
    for (let j = 0; j < songs.length; j++) {
      const { moods, energy } = results[j];
      db.upsertTrackTags(songs[j].id, {
        moods,
        energy,
        source,
        confidence: null,
        promptHash,
        model: modelLabel,
      });
      tagged += 1;
    }
    if (i % (batchSize * 4) === 0) {
      console.log(`[tag] LLM-tagged ${tagged}/${ids.length}`);
    }
  }
  return { tagged, callCount };
}

main().catch(err => { console.error(err); process.exit(1); });

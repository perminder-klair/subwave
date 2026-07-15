// The magical playlist builder engine (spec:
// docs/superpowers/specs/2026-07-15-magical-playlist-builder-design.md).
//
// Two stages, both fed by machinery that already exists:
//   1. buildCandidatePool — merge candidates from vector (searchBySound /
//      searchByLyrics), mood/genre, seed-similarity, recently-added and starred
//      sources into one normalised, filtered, capped pool.
//   2. curatePlaylist — ONE djObject call selects + orders the final set,
//      honouring the energy arc / artist spacing / instrumental ask. Falls back
//      to the deterministic arranger (playlist-gen-pure) when the model call
//      fails, so a non-empty pool never yields an empty playlist.
//
// This is an explicit operator action (like the manual /dj/segment runners), so
// it is deliberately NOT daily-token-budget gated.

import { z } from 'zod';
import * as subsonic from './subsonic.js';
import * as library from './library.js';
import * as embeddings from './embeddings.js';
import * as analyzer from './analyzer.js';
import { djObject } from '../llm/sdk.js';
import {
  mergePools,
  capPool,
  capPerArtist,
  orderByIds,
  fitToCount,
  pickDeterministic,
  ARC_SHAPES,
  type ArcShape,
  type PoolTrack,
  type DraftTrack,
} from './playlist-gen-pure.js';

export type { DraftTrack } from './playlist-gen-pure.js';

export interface EraWindow {
  fromYear?: number | null;
  toYear?: number | null;
}

export interface Knobs {
  targetCount?: number;
  targetMinutes?: number;
  energyArc?: ArcShape;
  eras?: EraWindow[];
  genres?: string[];
  moods?: string[];
  energies?: string[];
  artistSpacing?: number;
  excludeRecentlyPlayed?: boolean;
  instrumentalOnly?: boolean;
}

export interface Sources {
  recentlyAdded?: boolean;
}

export interface GenerateInput {
  prompt?: string;
  seedTrackIds?: string[];
  seedArtist?: string;
  knobs?: Knobs;
  sources?: Sources;
  excludeTrackIds?: string[];
  recentPlayIds?: string[];
}

export interface GenerateResult {
  tracks: DraftTrack[];
  name?: string;
  description?: string;
  degraded: boolean;
  reasons: string[];
  poolSize: number;
  usedFallback: boolean;
}

const POOL_CAP = 120;              // candidates kept after merge/filter
const LLM_CANDIDATE_CAP = 90;      // candidates shown to the model (token budget)
const DEFAULT_COUNT = 25;
const MIN_COUNT = 5;
const MAX_COUNT = 60;
const AVG_TRACK_MIN = 3.5;         // for targetMinutes → count estimate

function clampCount(n: number): number {
  return Math.min(MAX_COUNT, Math.max(MIN_COUNT, Math.round(n)));
}

// Normalise any source row (Subsonic Child, library slim-track, or FilteredRow)
// into a PoolTrack. Reads whichever fields the source happens to carry.
function norm(r: any, source: string, baseScore: number): PoolTrack {
  const instrumental =
    typeof r.instrumental === 'boolean' ? r.instrumental
      : Array.isArray(r.vocalRanges) ? r.vocalRanges.length === 0
        : r.vocalRanges === null ? null
          : null;
  const yearNum = typeof r.year === 'number' ? r.year : parseInt(String(r.year ?? ''), 10);
  return {
    id: String(r.id),
    title: r.title ?? null,
    artist: r.artist ?? null,
    album: r.album ?? null,
    albumId: r.albumId ?? null,
    durationSec: r.durationSec ?? r.duration ?? null,
    year: Number.isFinite(yearNum) ? yearNum : null,
    genre: r.genre ?? null,
    moods: Array.isArray(r.moods) ? r.moods : [],
    energy: r.energy ?? null,
    instrumental,
    score: typeof r._similarity === 'number' ? r._similarity : baseScore,
    sources: [source],
  };
}

function normMany(rows: any[] | null | undefined, source: string, baseScore: number): PoolTrack[] {
  return (Array.isArray(rows) ? rows : []).filter((r) => r && r.id).map((r) => norm(r, source, baseScore));
}

// Expand recently-added albums into their tracks (Subsonic returns albums, not
// songs for the "newest" list). Bounded so a huge library doesn't fan out.
async function recentlyAddedTracks(): Promise<any[]> {
  const albums = await subsonic.getRecentlyAddedAlbums({ size: 20 }).catch(() => []);
  const out: any[] = [];
  for (const album of albums.slice(0, 20)) {
    if (!album?.id) continue;
    const songs = await subsonic.getAlbum(album.id).catch(() => []);
    out.push(...songs);
    if (out.length >= 200) break;
  }
  return out;
}

// ── Stage 1: candidate pool ──────────────────────────────────────────────────

export async function buildCandidatePool(
  input: GenerateInput,
): Promise<{ pool: PoolTrack[]; reasons: string[] }> {
  await library.load();
  const knobs = input.knobs || {};
  const sources = input.sources || {};
  const prompt = (input.prompt || '').trim();
  const reasons: string[] = [];
  const pools: PoolTrack[][] = [];

  const stats = library.stats();
  const hasTextIndex = (stats.withEmbedding ?? 0) > 0;
  const hasAudioIndex = (stats.withAudioEmbedding ?? 0) > 0;

  // Prompt → semantic sources.
  if (prompt) {
    // Theme / lyric embeddings.
    if (hasTextIndex && embeddings.isAvailable()) {
      try {
        const vec = await embeddings.embedQueryText(prompt, library.embeddingIndexTextMode());
        if (vec) pools.push(normMany(library.tracksByVector(vec, 60), 'theme', 0.7));
        else reasons.push('theme (lyric) search returned no vector');
      } catch (err: any) {
        reasons.push(`theme search failed: ${err?.message || err}`);
      }
    } else {
      reasons.push('theme (lyric) search unavailable — no text-embedding index/provider');
    }
    // CLAP timbre (sound) search.
    if (hasAudioIndex && analyzer.textEmbeddingAvailable() !== false) {
      try {
        const vecs = await analyzer.embedTexts([prompt], { timeoutMs: 20_000 });
        if (vecs && vecs[0]) pools.push(normMany(library.tracksByAudioVector(vecs[0], 60), 'sound', 0.72));
        else reasons.push('sound (timbre) search unavailable right now');
      } catch (err: any) {
        reasons.push(`sound search failed: ${err?.message || err}`);
      }
    } else if (!hasAudioIndex) {
      reasons.push('sound (timbre) search unavailable — no audio index');
    }
  }

  // Seed tracks → similar songs (+ the seeds themselves).
  for (const seedId of (input.seedTrackIds || []).slice(0, 5)) {
    try {
      const seed = await subsonic.getSong(seedId).catch(() => null);
      if (seed) pools.push(normMany([seed], 'seed', 0.8));
      pools.push(normMany(await subsonic.getSimilarSongs(seedId, { count: 25 }), 'seed-similar', 0.65));
    } catch { /* a bad seed id shouldn't sink the whole build */ }
  }

  // Seed artist → their top songs.
  if (input.seedArtist?.trim()) {
    try {
      const artists = await subsonic.searchArtists(input.seedArtist.trim(), { artistCount: 1 });
      const name = artists?.[0]?.name;
      if (name) pools.push(normMany(await subsonic.getTopSongs(name, { count: 20 }), 'seed-artist', 0.6));
    } catch { /* ignore */ }
  }

  // Knob moods.
  for (const mood of (knobs.moods || []).slice(0, 6)) {
    pools.push(normMany(library.songsByMood(mood), `mood:${mood}`, 0.55));
  }

  // Knob genres → Subsonic genre lists (resolve free text to the real tag).
  for (const genre of (knobs.genres || []).slice(0, 6)) {
    try {
      const tag = (await subsonic.resolveGenreName(genre)) || genre;
      pools.push(normMany(await subsonic.getSongsByGenre(tag, { count: 40 }), `genre:${genre}`, 0.5));
    } catch { /* ignore */ }
  }

  // Local library filter — the strongest source for instrumental + energy/era,
  // and it carries the instrumental flag the semantic rows don't.
  {
    const era = eraSpan(knobs.eras);
    const filtered = library.filter({
      moods: knobs.moods,
      energy: knobs.energies?.length === 1 ? knobs.energies[0] : null,
      genre: null,
      vocal: knobs.instrumentalOnly ? 'instrumental' : null,
      yearFrom: era.fromYear,
      yearTo: era.toYear,
      limit: 120,
    });
    pools.push(normMany(filtered.rows, 'library', 0.5));
  }

  // Recently-added source (Kate #2a). When toggled, weight it high so a
  // prompt-less build is dominated by new arrivals.
  if (sources.recentlyAdded) {
    pools.push(normMany(await recentlyAddedTracks(), 'recently-added', 0.72));
  }

  // Fillers when the pool is thin — keeps a small/under-tagged library usable.
  let pool = mergePools(pools);
  if (pool.length < 30) {
    pools.push(normMany(await subsonic.getStarred().catch(() => []), 'starred', 0.4));
    const era = eraSpan(knobs.eras);
    pools.push(normMany(
      await subsonic.getRandomSongs({
        size: 60,
        fromYear: era.fromYear ?? undefined,
        toYear: era.toYear ?? undefined,
      }).catch(() => []),
      'random',
      0.2,
    ));
    pool = mergePools(pools);
  }

  // ── Hard/soft filters ──
  const excluded = new Set([...(input.excludeTrackIds || []), ...(knobs.excludeRecentlyPlayed ? (input.recentPlayIds || []) : [])]);
  if (excluded.size) pool = pool.filter((t) => !excluded.has(t.id));

  // Instrumental-only (Kate #3): drop known-vocal; keep instrumental + unknown.
  if (knobs.instrumentalOnly) {
    const before = pool.length;
    pool = pool.filter((t) => t.instrumental !== false);
    const known = pool.filter((t) => t.instrumental === true).length;
    if (known < Math.min(clampCount(knobs.targetCount ?? DEFAULT_COUNT), 12)) {
      reasons.push('instrumental filter is best-effort — few tracks have vocal analysis, so some may not be truly instrumental');
    }
    if (pool.length < before) { /* dropped known-vocal tracks */ }
  }

  // Era window (soft): drop known years outside the window, keep unknown years.
  const era = eraSpan(knobs.eras);
  if (era.fromYear != null || era.toYear != null) {
    const filteredEra = pool.filter((t) => {
      const y = typeof t.year === 'number' ? t.year : null;
      if (y == null) return true;
      if (era.fromYear != null && y < era.fromYear) return false;
      if (era.toYear != null && y > era.toYear) return false;
      return true;
    });
    pool = revertIfStarved(filteredEra, pool, knobs, reasons, 'era');
  }

  // Energy (soft): boost matches, keep unknown, drop other known energies — but
  // only if it doesn't starve the pool.
  if (knobs.energies?.length) {
    const want = new Set(knobs.energies);
    for (const t of pool) if (t.energy && want.has(t.energy)) t.score = (t.score ?? 0) + 0.15;
    const filteredEnergy = pool.filter((t) => !t.energy || want.has(t.energy));
    pool = revertIfStarved(filteredEnergy, pool, knobs, reasons, 'energy');
  }

  // Artist-diversity cap: keep the candidate list varied so one prolific artist
  // / a freshly-imported album can't dominate what the model (and the fallback)
  // sees. Skipped when the operator INTENTIONALLY narrows to an artist or seed
  // tracks — that focus is the point.
  const artistSeeded = Boolean(input.seedArtist?.trim() || input.seedTrackIds?.length);
  if (!artistSeeded) {
    const target = clampCount(knobs.targetCount ?? DEFAULT_COUNT);
    // Allow a few per artist but never let one artist exceed ~a third of a
    // target-sized set.
    pool = capPerArtist(pool, Math.max(4, Math.ceil(target / 3)));
  }

  return { pool: capPool(pool, POOL_CAP), reasons };
}

// If a soft filter would leave fewer than the floor, keep the unfiltered pool
// and note the relaxation instead of returning a starved result.
function revertIfStarved(
  filtered: PoolTrack[],
  original: PoolTrack[],
  knobs: Knobs,
  reasons: string[],
  label: string,
): PoolTrack[] {
  const floor = Math.min(clampCount(knobs.targetCount ?? DEFAULT_COUNT), 12);
  if (filtered.length >= floor) return filtered;
  reasons.push(`${label} filter relaxed — not enough matching tracks in the library`);
  return original;
}

function eraSpan(eras?: EraWindow[] | null): { fromYear: number | null; toYear: number | null } {
  let fromYear: number | null = null;
  let toYear: number | null = null;
  for (const e of eras || []) {
    if (e?.fromYear != null) fromYear = fromYear == null ? e.fromYear : Math.min(fromYear, e.fromYear);
    if (e?.toYear != null) toYear = toYear == null ? e.toYear : Math.max(toYear, e.toYear);
  }
  return { fromYear, toYear };
}

// ── Stage 2: curation ─────────────────────────────────────────────────────────

const CURATE_SCHEMA = z.object({
  name: z.string().max(80).optional().describe('a short, evocative playlist name'),
  description: z.string().max(200).optional().describe('one sentence describing the set'),
  ids: z.array(z.string()).min(1).describe('candidate ids in play order'),
});

function curatorSystem(input: GenerateInput, targetCount: number): string {
  const knobs = input.knobs || {};
  const arc = knobs.energyArc || 'flat';
  const arcNote: Record<ArcShape, string> = {
    'flat': 'keep the energy roughly even throughout',
    'build': 'start calm and build energy toward the end',
    'peak-then-cool': 'rise to an energetic peak in the middle, then cool down',
    'wind-down': 'start high-energy and wind down toward the end',
  };
  const lines = [
    'You are a world-class radio music curator assembling a playlist for a single broadcast station.',
    `Select about ${targetCount} tracks from the CANDIDATES and return their ids in the exact order they should play.`,
    `Energy arc: ${arcNote[arc]}.`,
    `Keep the same artist at least ${knobs.artistSpacing ?? 2} tracks apart; never repeat a track.`,
    'Prefer a coherent, flowing set over cramming in every candidate. Only use ids present in CANDIDATES.',
  ];
  if (input.prompt?.trim()) lines.push(`The listener asked for: "${input.prompt.trim()}". Honour that vibe above all.`);
  if (knobs.instrumentalOnly) lines.push('Instrumental only — avoid tracks with prominent vocals.');
  if (knobs.moods?.length) lines.push(`Lean into these moods: ${knobs.moods.join(', ')}.`);
  if (knobs.genres?.length) lines.push(`Favour these genres: ${knobs.genres.join(', ')}.`);
  lines.push('Also propose a short evocative name and a one-sentence description.');
  return lines.join('\n');
}

// Compact candidate projection — dense JSON keeps the token bill down.
function projectForLlm(pool: PoolTrack[]): any[] {
  return capPool(pool, LLM_CANDIDATE_CAP).map((t) => ({
    id: t.id,
    t: t.title || '',
    a: t.artist || '',
    e: t.energy || undefined,
    m: t.moods && t.moods.length ? t.moods.slice(0, 3) : undefined,
    i: t.instrumental === true ? 1 : undefined,
    y: typeof t.year === 'number' ? t.year : undefined,
  }));
}

export async function curatePlaylist(
  pool: PoolTrack[],
  input: GenerateInput,
): Promise<{ tracks: PoolTrack[]; name?: string; description?: string; usedFallback: boolean }> {
  const knobs = input.knobs || {};
  const arc: ArcShape = ARC_SHAPES.includes(knobs.energyArc as ArcShape) ? (knobs.energyArc as ArcShape) : 'flat';
  const targetCount = clampCount(
    knobs.targetCount ?? (knobs.targetMinutes ? knobs.targetMinutes / AVG_TRACK_MIN : DEFAULT_COUNT),
  );
  const artistSpacing = Math.max(0, Math.min(5, knobs.artistSpacing ?? 2));

  if (pool.length === 0) return { tracks: [], usedFallback: false };

  const fallback = () => ({
    tracks: pickDeterministic(pool, { targetCount, energyArc: arc, artistSpacing }),
    usedFallback: true as const,
  });

  try {
    const out = await djObject({
      system: curatorSystem(input, targetCount),
      prompt: JSON.stringify({ target: targetCount, candidates: projectForLlm(pool) }),
      schema: CURATE_SCHEMA,
      temperature: 0.6,
      kind: 'playlistCurate',
    });
    const value = out?.value;
    const chosen = orderByIds(Array.isArray(value?.ids) ? value.ids : [], pool);
    if (chosen.length < 2) return { ...fallback(), name: value?.name, description: value?.description };
    const fitted = fitToCount(chosen, pool, targetCount);
    return { tracks: fitted, name: value?.name, description: value?.description, usedFallback: false };
  } catch {
    return fallback();
  }
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

function toDraft(t: PoolTrack): DraftTrack {
  return {
    id: t.id,
    title: t.title || '',
    artist: t.artist || '',
    album: t.album || '',
    durationSec: t.durationSec ?? 0,
    year: typeof t.year === 'number' ? t.year : null,
    genre: t.genre ?? null,
    energy: t.energy ?? null,
    moods: t.moods || [],
    instrumental: t.instrumental ?? null,
  };
}

// Trim a track list to a target minutes budget (keeps leading order).
function trimToMinutes(tracks: PoolTrack[], minutes: number): PoolTrack[] {
  const budget = minutes * 60;
  const out: PoolTrack[] = [];
  let acc = 0;
  for (const t of tracks) {
    if (out.length && acc >= budget) break;
    out.push(t);
    acc += t.durationSec ?? 0;
  }
  return out;
}

export async function generatePlaylist(input: GenerateInput): Promise<GenerateResult> {
  const { pool, reasons } = await buildCandidatePool(input);
  const curated = await curatePlaylist(pool, input);
  let tracks = curated.tracks;
  if (input.knobs?.targetMinutes && tracks.length) {
    tracks = trimToMinutes(tracks, input.knobs.targetMinutes);
  }
  return {
    tracks: tracks.map(toDraft),
    name: curated.name,
    description: curated.description,
    degraded: reasons.length > 0,
    reasons,
    poolSize: pool.length,
    usedFallback: curated.usedFallback,
  };
}

/* Library Observatory -- data + layout. Tracks lay out by genre cluster +
   gaussian spread, so no embedding projection is needed. Continuous `energyVal`
   is derived deterministically from the discrete `energy` band. */

// seeded RNG (mulberry32)
export function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(rng: () => number): number {
  // Box-Muller
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Stable string → uint32 seed (FNV-1a), so per-track positions and energy
// jitter are identical across reloads.
export function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ink → vermilion heat ramp by t∈[0,1]  (ink #4a443d → vermilion #d94b2a)
export function heat(t: number): string {
  t = Math.max(0, Math.min(1, t));
  const a = [74, 68, 61] as const;
  const b = [217, 75, 42] as const;
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

function dist2(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

// Spatial nearest neighbours for synapse links and the mix-next fallback.
// Single-pass top-k insertion: the pool can be the whole node set and k is tiny.
export function nearest(track: ObsTrack, list: ObsTrack[], k: number): ObsTrack[] {
  if (k <= 0) return [];
  const best: { t: ObsTrack; d: number }[] = [];
  for (const t of list) {
    if (t.idx === track.idx) continue;
    const d = dist2(track, t);
    if (best.length === k && d >= best[best.length - 1]!.d) continue;
    let i = best.length;
    while (i > 0 && best[i - 1]!.d > d) i--;
    best.splice(i, 0, { t, d });
    if (best.length > k) best.pop();
  }
  return best.map((p) => p.t);
}

// Count occurrences (single value or array per item), sorted desc
export function tally<T>(list: T[], fn: (t: T) => string | string[] | null | undefined): [string, number][] {
  const m = new Map<string, number>();
  list.forEach((t) => {
    const v = fn(t);
    (Array.isArray(v) ? v : [v]).forEach((k) => {
      if (k == null) return;
      m.set(k, (m.get(k) || 0) + 1);
    });
  });
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

// SVG ring-segment path for the Camelot key wheel
export function arcPath(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const p = (r: number, a: number): [number, number] => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0o, y0o] = p(r1, a0);
  const [x1o, y1o] = p(r1, a1);
  const [x1i, y1i] = p(r0, a1);
  const [x0i, y0i] = p(r0, a0);
  return `M${x0o} ${y0o} A${r1} ${r1} 0 ${large} 1 ${x1o} ${y1o} L${x1i} ${y1i} A${r0} ${r0} 0 ${large} 0 ${x0i} ${y0i} Z`;
}

// Deterministic pseudo-embedding for the dossier fingerprint, when a track has
// no stored vector.
export function embeddingVector(seed: number, dim: number): number[] {
  const rng = mulberry32(seed);
  const out = new Array(dim);
  const f1 = rng() * 6.28;
  const f2 = rng() * 6.28;
  const f3 = rng() * 6.28;
  for (let i = 0; i < dim; i++) {
    const t = i / dim;
    let v = 0.55 * Math.sin(t * 9 + f1) + 0.3 * Math.sin(t * 23 + f2) + 0.2 * Math.cos(t * 51 + f3);
    v += (rng() - 0.5) * 0.5;
    out[i] = Math.max(-1, Math.min(1, v));
  }
  return out;
}

// Scale a real embedding to [-1,1] by peak magnitude; raw cosine-normalised
// vectors cluster near 0 and show no contrast.
export function normaliseFingerprint(vec: number[]): number[] {
  let max = 0;
  for (const v of vec) max = Math.max(max, Math.abs(v));
  if (max === 0) return vec;
  return vec.map((v) => Math.max(-1, Math.min(1, v / max)));
}

// Chromatic tonic -> hue for the SONG SHAPE key bands; major lighter, minor
// darker, so colour conveys tonic and mode at once.
const TONIC_ORDER = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_TO_SHARP: Record<string, string> = {
  Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#',
};
export function keyRangeColor(tonic: string, mode: 'major' | 'minor'): string {
  const t = FLAT_TO_SHARP[tonic] ?? tonic;
  const idx = TONIC_ORDER.indexOf(t);
  const hue = idx < 0 ? 0 : Math.round((idx / 12) * 360);
  return mode === 'major' ? `hsl(${hue} 62% 56%)` : `hsl(${hue} 40% 40%)`;
}

export const CAMELOT_KEYS: string[] = [];
for (let n = 1; n <= 12; n++) {
  CAMELOT_KEYS.push(n + 'A');
  CAMELOT_KEYS.push(n + 'B');
}

export type Energy = 'low' | 'medium' | 'high' | null;
export type Vocal = 'vocal' | 'instrumental' | null;

// Acoustic timeline spans, mirrored from the controller's library-db types
// (TrackSection / TrackPaceSpan / TrackKeyRange). Times in milliseconds.
export interface Section {
  startMs: number;
  endMs: number;
  kind?: string;
}
export interface PaceSpan {
  startMs: number;
  endMs: number;
  value: number; // 0..1 perceptual energy
}
export interface KeyRange {
  startMs: number;
  endMs: number;
  tonic: string; // sharps, e.g. 'C', 'C#'
  mode: 'major' | 'minor';
}

// From GET /library/observatory.
export interface RawTrack {
  id: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  year: number | null;
  genres: string[];
  genre: string | null;
  durationSec: number | null;
  moods: string[];
  energy: Energy;
  source: string | null;
  confidence: number | null;
  bpm: number | null;
  musicalKey: string | null;
  analysisConfidence: number | null;
  loudnessLufs: number | null;
  paceMean: number | null;
  vocal: Vocal;
  // Server-side UMAP of the CLAP audio vector, normalised to [0,1] per axis.
  // null = not projected; layout falls back to genre-cluster placement.
  mapX: number | null;
  mapY: number | null;
}

export interface ObsTrack extends RawTrack {
  idx: number;
  energyVal: number; // continuous 0..1, derived from the energy band
  analysed: boolean; // bpm != null
  x: number;
  y: number;
  _eseed: number; // seed for the fallback fingerprint
  searchText: string; // precomputed lowercase haystack for the rail search
}

export interface ObservatoryStats {
  total: number;
  distinctArtists: number;
  byMood: Record<string, number>;
  byEnergy: Record<string, number>;
  byGenre: Record<string, number>;
  bySource: Record<string, number>;
  withEmbedding: number;
  withAudioEmbedding: number;
  updatedAt: string | null;
}

// Mirrors the controller's map-projection.ts ProjectionStatus.
export interface MapProjectionStatus {
  running: boolean;
  startedAt: string | null;
  lastLog: string[];
  meta: { algo: string; space: string; count: number; setAt: string } | null;
  audioVectors: number;
  stale: boolean;
}

export interface LibraryData {
  tracks: ObsTrack[];
  genres: string[];
  centers: Record<string, { x: number; y: number; angle: number }>;
  soundMap: boolean; // true → nodes sit by UMAP sound coordinates, not genre clusters
  stats: ObservatoryStats;
  moodVocab: string[];
  truncated: boolean;
  sampled: boolean; // truncated via a stratified per-genre sample (vs. full)
  max: number | null; // node cap the server applied to this load (null: mock)
  hardMax: number; // ceiling the UI may raise the node cap to
  mapProjection: MapProjectionStatus | null; // null: mock / older controller
  mock: boolean;
}

// From GET /library/observatory/track/:id
export interface TrackDetail {
  track: {
    id: string;
    title: string | null;
    artist: string | null;
    album: string | null;
    year: number | null;
    genres: string[];
    genre: string | null;
    durationSec: number | null;
    moods: string[];
    energy: Energy;
    source: string | null;
    confidence: number | null;
    taggerVersion: number | null;
    model: string | null;
    taggedAt: string | null;
    lastfmTags: string[] | null;
    lyricExcerpt: string | null;
    bpm: number | null;
    musicalKey: string | null;
    introMs: number | null;
    analysisConfidence: number | null;
    analysisVersion: number | null;
    loudnessLufs: number | null;
    peakDb: number | null;
    structure: Section[] | null;
    vocalRanges: Section[] | null;
    pace: PaceSpan[] | null;
    keyRanges: KeyRange[] | null;
    // Zero-shot, scored from the CLAP audio vector; distinct from the editorial
    // `moods`. Scores are the full {mood: cosine} map.
    audioMoods: string[];
    audioMoodScores: Record<string, number> | null;
    // Measured ending. null = not analysed.
    outro: { startMs: number; ending: 'fade' | 'cold'; lufs: number | null; bpm: number | null } | null;
  };
  textEmbedding: number[] | null;
  audioEmbedding: number[] | null;
  mixNext: {
    id: string;
    title: string | null;
    artist: string | null;
    bpm: number | null;
    musicalKey: string | null;
    energy: Energy;
    similarity: number | null;
  }[];
}

const NO_GENRE = '—';

// Older controllers expose only `genre`; keep the scalar as a fallback.
export function trackGenres(t: Pick<RawTrack, 'genres' | 'genre'>): string[] {
  if (Array.isArray(t.genres) && t.genres.length) return t.genres;
  return t.genre ? [t.genre] : [];
}

export function genreText(t: Pick<RawTrack, 'genres' | 'genre'>): string {
  return trackGenres(t).join(' · ');
}

// Built once per load so a keystroke doesn't re-lowercase every field per track.
function searchTextOf(t: Pick<RawTrack, 'title' | 'artist' | 'album' | 'genres' | 'genre' | 'moods'>): string {
  return [t.title, t.artist, t.album, ...trackGenres(t), ...(t.moods || [])]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
}

export interface ObservatoryFilters {
  query: string;
  energy: Set<string>;
  moods: Set<string>;
  genres: Set<string>;
  sources: Set<string>;
  analysedOnly: boolean;
}

export function matchesObservatoryTrack(t: ObsTrack, filters: ObservatoryFilters): boolean {
  if (filters.energy.size && !(t.energy && filters.energy.has(t.energy))) return false;
  if (filters.sources.size && !(t.source && filters.sources.has(t.source))) return false;
  if (filters.genres.size && !trackGenres(t).some((genre) => filters.genres.has(genre))) return false;
  if (filters.moods.size && !t.moods.some((mood) => filters.moods.has(mood))) return false;
  if (filters.analysedOnly && !t.analysed) return false;
  const query = filters.query.trim().toLowerCase();
  if (query && !t.searchText.includes(query)) return false;
  return true;
}

// Jittered off a dedicated seed so positions don't shift if this logic changes.
function energyToVal(energy: Energy, id: string): number {
  const r = mulberry32(hashStr(id) ^ 0x5eed)();
  switch (energy) {
    case 'low':
      return 0.1 + r * 0.24;
    case 'medium':
      return 0.4 + r * 0.24;
    case 'high':
      return 0.68 + r * 0.3;
    default:
      return 0.46 + r * 0.08; // unknown → mid, faint spread
  }
}

// Layout -- place every track on a 1000x1000 disc. SOUND MAP scales the [0,1]
// UMAP coords into the disc's inscribed square when coverage allows; otherwise
// GENRE CLUSTERS, a genre ring plus gaussian spread.
const SOUND_MAP_MIN = 50; // absolute floor of mapped tracks
const SOUND_MAP_COVERAGE = 0.6; // fraction of tracks that must be mapped

function genreAnchor(
  t: Pick<RawTrack, 'genres' | 'genre'>,
  centers: Record<string, { x: number; y: number }>,
): { x: number; y: number } {
  const tagged = trackGenres(t);
  const anchors = (tagged.length ? tagged : [NO_GENRE]).map((genre) => centers[genre]!);
  return {
    x: anchors.reduce((sum, anchor) => sum + anchor.x, 0) / anchors.length,
    y: anchors.reduce((sum, anchor) => sum + anchor.y, 0) / anchors.length,
  };
}

export function layoutTracks(raw: RawTrack[]): {
  tracks: ObsTrack[];
  genres: string[];
  centers: Record<string, { x: number; y: number; angle: number }>;
  soundMap: boolean;
} {
  // Most-populous first, for a stable angular assignment.
  const counts: Record<string, number> = {};
  raw.forEach((t) => {
    const tagged = trackGenres(t);
    for (const genre of tagged.length ? tagged : [NO_GENRE]) {
      counts[genre] = (counts[genre] || 0) + 1;
    }
  });
  const genres = Object.keys(counts).sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0) || a.localeCompare(b));
  const n = Math.max(1, genres.length);

  const mappedCount = raw.reduce((acc, t) => acc + (t.mapX != null && t.mapY != null ? 1 : 0), 0);
  const soundMap = mappedCount >= SOUND_MAP_MIN && mappedCount >= raw.length * SOUND_MAP_COVERAGE;

  if (soundMap) {
    // [0,1] → the disc's inscribed square, with a margin for labels/halo.
    const M = 70;
    const S = 1000 - 2 * M;
    const px = (v: number) => M + v * S;

    const sums: Record<string, { x: number; y: number; c: number }> = {};
    raw.forEach((t) => {
      if (t.mapX == null || t.mapY == null) return;
      const tagged = trackGenres(t);
      for (const genre of tagged.length ? tagged : [NO_GENRE]) {
        (sums[genre] ||= { x: 0, y: 0, c: 0 });
        sums[genre]!.x += px(t.mapX);
        sums[genre]!.y += px(t.mapY);
        sums[genre]!.c++;
      }
    });
    const centers: Record<string, { x: number; y: number; angle: number }> = {};
    genres.forEach((g) => {
      const s = sums[g];
      const x = s ? s.x / s.c : 500;
      const y = s ? s.y / s.c : 500;
      centers[g] = { x, y, angle: Math.atan2(y - 500, x - 500) };
    });

    const tracks: ObsTrack[] = raw.map((t, idx) => {
      let x: number;
      let y: number;
      if (t.mapX != null && t.mapY != null) {
        x = px(t.mapX);
        y = px(t.mapY);
      } else {
        // Unmapped tracks sit between every scene they belong to rather than
        // collapsing onto the generated primary genre.
        const c = genreAnchor(t, centers);
        const rng = mulberry32(hashStr(t.id) ^ 0xc0ffee);
        x = c.x + gauss(rng) * 45;
        y = c.y + gauss(rng) * 45;
      }
      return {
        ...t,
        idx,
        energyVal: energyToVal(t.energy, t.id),
        analysed: t.bpm != null,
        x,
        y,
        _eseed: hashStr(t.id),
        searchText: searchTextOf(t),
      };
    });
    return { tracks, genres, centers, soundMap: true };
  }

  const centers: Record<string, { x: number; y: number; angle: number }> = {};
  genres.forEach((g, i) => {
    const base = (i / n) * Math.PI * 2;
    // small stable jitter so clusters don't sit on a perfect ring
    const jitter = (mulberry32(hashStr(g))() - 0.5) * ((Math.PI * 2) / n) * 0.55;
    const a = base + jitter;
    const rad = 360 * (0.5 + 0.45 * mulberry32(hashStr(g) ^ 0x9e3779b9)());
    centers[g] = { x: 500 + Math.cos(a) * rad, y: 500 + Math.sin(a) * rad, angle: a };
  });

  const tracks: ObsTrack[] = raw.map((t, idx) => {
    const c = genreAnchor(t, centers);
    const rng = mulberry32(hashStr(t.id) ^ 0xc0ffee);
    const spread = 50 + rng() * 30;
    const x = c.x + gauss(rng) * spread;
    const y = c.y + gauss(rng) * spread;
    return {
      ...t,
      idx,
      energyVal: energyToVal(t.energy, t.id),
      analysed: t.bpm != null,
      x,
      y,
      _eseed: hashStr(t.id),
      searchText: searchTextOf(t),
    };
  });

  return { tracks, genres, centers, soundMap: false };
}

// Tag-source enum → colour + filled/hollow + short label.
export interface SourceStyle {
  color: string;
  filled: boolean;
  label: string;
}
export function sourceStyle(source: string | null): SourceStyle {
  switch (source) {
    case 'manual':
      return { color: '#d94b2a', filled: true, label: 'MANUAL' };
    case 'llm':
      return { color: '#9a5b1f', filled: true, label: 'LLM' };
    case 'uncertain-llm':
      return { color: '#9a5b1f', filled: false, label: 'UNCERTAIN' };
    case 'propagated':
      return { color: '#4a443d', filled: true, label: 'PROPAGATED' };
    case 'legacy-v1':
      return { color: '#9b948a', filled: false, label: 'LEGACY' };
    default:
      return { color: '#4a443d', filled: true, label: (source || '—').toUpperCase() };
  }
}

// Synapse links -- one nearby shared-genre neighbour per node, via a uniform
// spatial grid so the pass stays O(n) at any density. Returns index pairs.
// LINK_SCAN_BUDGET caps per-track distance checks across the 9-cell probe: a
// genre packing thousands of tracks into one cluster degenerates toward
// O(n*clusterSize). Links are cosmetic, so past the budget keep the nearest seen.
const LINK_SCAN_BUDGET = 96;
// 3x3 probe offsets, own cell first.
const PROBE_ORDER: [number, number][] = [
  [0, 0],
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1], [0, 1],
  [1, -1], [1, 0], [1, 1],
];

export function buildSynapseLinks(tracks: ObsTrack[]): [number, number][] {
  const CELL = 64; // ~ the gaussian cluster spread in layoutTracks
  const grid = new Map<string, number[]>();
  const cellKey = (g: string, x: number, y: number) =>
    `${g}|${Math.floor(x / CELL)}|${Math.floor(y / CELL)}`;
  tracks.forEach((t, i) => {
    const tagged = trackGenres(t);
    for (const genre of tagged.length ? tagged : [NO_GENRE]) {
      const key = cellKey(genre, t.x, t.y);
      const bucket = grid.get(key);
      if (bucket) bucket.push(i);
      else grid.set(key, [i]);
    }
  });
  const out: [number, number][] = [];
  const seen = new Set<number>();
  const n = tracks.length;
  tracks.forEach((t, i) => {
    const tagged = trackGenres(t);
    const gx = Math.floor(t.x / CELL);
    const gy = Math.floor(t.y / CELL);
    let best = -1;
    let bd = Infinity;
    let budget = LINK_SCAN_BUDGET;
    // Single-genre tracks occupy one grid partition and need no duplicate guard.
    const checked = tagged.length > 1 ? new Set<number>() : null;
    // Own cell first, ring after: when the budget engages, candidates must come
    // from the immediate neighbourhood or every link spans a cell diagonal.
    // Own-cell-first also keeps picks mutual, so the a<b dedup still collapses.
    probe: for (const genre of (tagged.length ? tagged : [NO_GENRE])) {
      for (const [dx, dy] of PROBE_ORDER) {
        const cell = grid.get(`${genre}|${gx + dx}|${gy + dy}`);
        if (!cell) continue;
        for (const j of cell) {
          if (j === i || checked?.has(j)) continue;
          checked?.add(j);
          const ddx = t.x - tracks[j]!.x;
          const ddy = t.y - tracks[j]!.y;
          const d = ddx * ddx + ddy * ddy;
          if (d < bd) {
            bd = d;
            best = j;
          }
          if (--budget <= 0) break probe;
        }
      }
    }
    if (best >= 0) {
      const a = Math.min(i, best);
      const b = Math.max(i, best);
      const pk = a * n + b; // unique pair id (safe < 2^53 for n ≤ ~94M)
      if (!seen.has(pk)) {
        seen.add(pk);
        out.push([a, b]);
      }
    }
  });
  return out;
}

// Node appearance -- shared by the SVG node layer, hover overlay and canvas
// renderer so all three stay pixel-identical.
export type ColorBy = 'energy' | 'confidence' | 'source' | 'analysis' | 'loudness' | 'pace' | 'vocal';

// Integrated loudness (LUFS, typically −30…0) → 0..1 for the heat ramp.
// null → mid-faint, like the unknown-energy case.
export function loudnessToVal(lufs: number | null): number {
  if (lufs == null) return 0.5;
  return Math.max(0, Math.min(1, (lufs + 30) / 30));
}

// Reuses the source filled/hollow convention.
export function vocalStyle(v: Vocal): SourceStyle {
  if (v === 'vocal') return { color: '#d94b2a', filled: true, label: 'VOCAL' };
  if (v === 'instrumental') return { color: '#4a443d', filled: true, label: 'INSTRUMENTAL' };
  return { color: '#9b948a', filled: false, label: 'UNKNOWN' };
}

export function nodeColor(t: ObsTrack, colorBy: ColorBy): string {
  if (colorBy === 'energy') return heat(t.energyVal);
  if (colorBy === 'confidence') return heat(0.15 + (t.confidence ?? 0.5) * 0.85);
  if (colorBy === 'source') return sourceStyle(t.source).color;
  if (colorBy === 'analysis') return t.analysed ? '#d94b2a' : '#9b948a';
  if (colorBy === 'loudness') return t.loudnessLufs == null ? '#9b948a' : heat(loudnessToVal(t.loudnessLufs));
  if (colorBy === 'pace') return t.paceMean == null ? '#9b948a' : heat(0.1 + t.paceMean * 0.9);
  if (colorBy === 'vocal') return vocalStyle(t.vocal).color;
  return '#4a443d';
}

export function nodeFilled(t: ObsTrack, colorBy: ColorBy): boolean {
  if (colorBy === 'source') return sourceStyle(t.source).filled;
  if (colorBy === 'analysis') return t.analysed;
  if (colorBy === 'loudness') return t.loudnessLufs != null;
  if (colorBy === 'pace') return t.paceMean != null;
  if (colorBy === 'vocal') return vocalStyle(t.vocal).filled;
  return true;
}

// Mock library -- empty-library fallback, seeded generator emitting the real
// ObsTrack shape.
const MOCK_SCENES = [
  { genre: 'Ambient', tempo: [60, 82], moods: ['hazy', 'reflective', 'calm'], energy: [0.05, 0.3], angle: 205 },
  { genre: 'Downtempo', tempo: [78, 100], moods: ['night', 'rainy', 'calm'], energy: [0.2, 0.5], angle: 230 },
  { genre: 'Dream Pop', tempo: [95, 120], moods: ['romantic', 'reflective', 'calm'], energy: [0.3, 0.62], angle: 318 },
  { genre: 'Synthpop', tempo: [98, 124], moods: ['energetic', 'night', 'driving'], energy: [0.55, 0.88], angle: 18 },
  { genre: 'Indie Rock', tempo: [110, 150], moods: ['driving', 'energetic'], energy: [0.55, 0.85], angle: 50 },
  { genre: 'House', tempo: [118, 128], moods: ['night', 'driving', 'celebratory'], energy: [0.6, 0.92], angle: 135 },
  { genre: 'Techno', tempo: [128, 145], moods: ['driving', 'night'], energy: [0.72, 0.98], angle: 158 },
  { genre: 'Soul', tempo: [70, 100], moods: ['romantic', 'reflective', 'night'], energy: [0.3, 0.6], angle: 275 },
  { genre: 'Jazz', tempo: [80, 140], moods: ['reflective', 'night', 'romantic'], energy: [0.25, 0.58], angle: 255 },
  { genre: 'Hip-Hop', tempo: [82, 100], moods: ['night', 'driving'], energy: [0.45, 0.78], angle: 0 },
];
const MOCK_ADJ = ['Neon', 'Velvet', 'Slow', 'Glass', 'Paper', 'Midnight', 'Distant', 'Hollow', 'Golden', 'Silent', 'Electric', 'Faded', 'Lucid', 'Cosmic', 'Amber', 'Drowned'];
const MOCK_NOUN = ['Drift', 'Tide', 'Avenue', 'Moons', 'Signal', 'Mirage', 'Embers', 'Glow', 'Pulse', 'Halo', 'Vapor', 'Orbit', 'Harbor', 'Smoke', 'Echoes', 'Dusk'];
const MOCK_ART_A = ['The', '', '', 'Saint', 'Young', 'Neon', 'Glass', 'Slow', 'Quiet', 'Night'];
const MOCK_ART_B = ['Tigers', 'Atlas', 'Mode', 'Wolves', 'Cassette', 'Avenue', 'Lights', 'Motel', 'Radio', 'Vega', 'Coast', 'Hours', 'Parade', 'Lux', 'Vela', 'Mira'];
const MOCK_ALBUM = ['Nightlines', 'After Hours', 'Tidewater', 'Paper Engines', 'Halo Sessions', 'Velvet Rooms', 'Cassette Era', 'Golden Hour', 'Marble Skies', 'Vapor Trails', 'Frequencies', 'Harbor Lights'];
const MOCK_SOURCES = ['manual', 'llm', 'propagated', 'propagated', 'llm', 'legacy-v1'];

function mpick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}
function mhex(rng: () => number): string {
  let s = '';
  const hex = '0123456789abcdef';
  for (let i = 0; i < 32; i++) s += hex[Math.floor(rng() * 16)];
  return s;
}
function bandToEnergy(e: number): 'low' | 'medium' | 'high' {
  if (e < 0.4) return 'low';
  if (e < 0.68) return 'medium';
  return 'high';
}

export function buildMockLibrary(count = 400): LibraryData {
  const rng = mulberry32(0x5713a7);
  const R = 360;
  const centers: Record<string, { x: number; y: number; angle: number }> = {};
  MOCK_SCENES.forEach((s) => {
    const a = (s.angle * Math.PI) / 180;
    const rad = R * (0.55 + 0.45 * mulberry32(s.angle + 7)());
    centers[s.genre] = { x: 500 + Math.cos(a) * rad, y: 500 + Math.sin(a) * rad, angle: a };
  });

  const tracks: ObsTrack[] = [];
  const byMood: Record<string, number> = {};
  const byEnergy: Record<string, number> = {};
  const byGenre: Record<string, number> = {};
  const bySource: Record<string, number> = {};

  for (let i = 0; i < count; i++) {
    const scene = MOCK_SCENES[Math.floor(rng() * MOCK_SCENES.length)]!;
    const c = centers[scene.genre]!;
    const spread = 50 + rng() * 28;
    const x = c.x + gauss(rng) * spread;
    const y = c.y + gauss(rng) * spread;
    const [elo = 0, ehi = 1] = scene.energy;
    let ev = elo + rng() * (ehi - elo) + gauss(rng) * 0.05;
    ev = Math.max(0.02, Math.min(0.99, ev));
    const moodCount = 2 + (rng() < 0.5 ? 1 : 0);
    const moods: string[] = [];
    const pool = scene.moods.slice();
    for (let m = 0; m < moodCount && pool.length; m++) {
      const picked = pool.splice(Math.floor(rng() * pool.length), 1)[0];
      if (picked) moods.push(picked);
    }
    const [tlo = 90, thi = 120] = scene.tempo;
    const analysed = rng() < 0.78;
    const bpm = analysed ? Math.round((tlo + rng() * (thi - tlo)) * 10) / 10 : null;
    const source = mpick(rng, MOCK_SOURCES);
    const confidence = source === 'manual' ? 1 : Math.round((0.55 + rng() * 0.44) * 100) / 100;
    const id = mhex(rng);
    const a1 = mpick(rng, MOCK_ART_A);
    const a2 = mpick(rng, MOCK_ART_B);
    const energy = bandToEnergy(ev);
    const year = 1978 + Math.floor(rng() * 48);

    moods.forEach((m) => (byMood[m] = (byMood[m] || 0) + 1));
    byEnergy[energy] = (byEnergy[energy] || 0) + 1;
    byGenre[scene.genre] = (byGenre[scene.genre] || 0) + 1;
    bySource[source] = (bySource[source] || 0) + 1;

    // Pick order is load-bearing: it fixes the seeded RNG stream.
    const title = `${mpick(rng, MOCK_ADJ)} ${mpick(rng, MOCK_NOUN)}`;
    const artist = (a1 ? a1 + ' ' : '') + a2;
    const album = mpick(rng, MOCK_ALBUM);
    tracks.push({
      id,
      idx: i,
      title,
      artist,
      album,
      year,
      genres: [scene.genre],
      genre: scene.genre,
      durationSec: 150 + Math.floor(rng() * 200),
      moods,
      energy,
      source,
      confidence,
      bpm,
      musicalKey: analysed ? (CAMELOT_KEYS[Math.floor(rng() * 24)] ?? null) : null,
      analysisConfidence: analysed ? Math.round((0.55 + rng() * 0.43) * 100) / 100 : null,
      // Acoustic scalars track the energy band so colour-by modes look plausible.
      loudnessLufs: analysed ? Math.round((-22 + ev * 16 + (rng() - 0.5) * 3) * 10) / 10 : null,
      paceMean: analysed ? Math.max(0.02, Math.min(0.98, Math.round((ev + (rng() - 0.5) * 0.2) * 100) / 100)) : null,
      vocal: analysed ? (rng() < 0.7 ? 'vocal' : 'instrumental') : null,
      mapX: null,
      mapY: null,
      energyVal: Math.round(ev * 100) / 100,
      analysed,
      x,
      y,
      _eseed: Math.floor(rng() * 1e9),
      searchText: searchTextOf({ title, artist, album, genres: [scene.genre], genre: scene.genre, moods }),
    });
  }

  return {
    tracks,
    genres: MOCK_SCENES.map((s) => s.genre),
    centers,
    soundMap: false,
    stats: {
      total: count,
      distinctArtists: Object.keys(byGenre).length * 6,
      byMood,
      byEnergy,
      byGenre,
      bySource,
      withEmbedding: count,
      withAudioEmbedding: Math.round(count * 0.4),
      updatedAt: null,
    },
    moodVocab: [...new Set(MOCK_SCENES.flatMap((s) => s.moods))],
    truncated: false,
    sampled: false,
    max: null,
    hardMax: 100000,
    mapProjection: null,
    mock: true,
  };
}

// Mock track dossier -- synthesises the lazy /track/:id payload for the
// landing-page showcase. Deterministic off the track's seed.
const MOCK_SECTION_KINDS = ['intro', 'verse', 'chorus', 'verse', 'chorus', 'bridge', 'outro'];
const MOCK_TONICS = ['C', 'D', 'E', 'F', 'G', 'A', 'B', 'C#', 'F#', 'G#'];

export function buildMockDetail(track: ObsTrack): TrackDetail {
  const seed = track._eseed >>> 0;
  const rng = mulberry32(seed ^ 0x0d05);
  const durSec = track.durationSec ?? 210;
  const totalMs = durSec * 1000;

  const nSec = 5 + Math.floor(rng() * 3); // 5–7
  const bounds = [0];
  for (let i = 1; i < nSec; i++) {
    bounds.push(Math.max(0, Math.round((totalMs * i) / nSec + (rng() - 0.5) * totalMs * 0.06)));
  }
  bounds.push(totalMs);
  const structure: Section[] = [];
  for (let i = 0; i < nSec; i++) {
    structure.push({ startMs: bounds[i]!, endMs: bounds[i + 1]!, kind: MOCK_SECTION_KINDS[i % MOCK_SECTION_KINDS.length] });
  }
  const introMs = structure[0]!.endMs;

  const base = track.energyVal;
  const nPace = 14;
  const pace: PaceSpan[] = [];
  for (let i = 0; i < nPace; i++) {
    const phase = i / nPace;
    const hump = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
    const v = Math.max(0.05, Math.min(0.98, base * 0.55 + hump * 0.5 + (rng() - 0.5) * 0.12));
    pace.push({
      startMs: Math.round((totalMs * i) / nPace),
      endMs: Math.round((totalMs * (i + 1)) / nPace),
      value: Math.round(v * 100) / 100,
    });
  }

  // Mode follows the Camelot suffix (A = minor, B = major).
  const mode: 'major' | 'minor' = track.musicalKey?.endsWith('B') ? 'major' : 'minor';
  const keyRanges: KeyRange[] = [
    { startMs: 0, endMs: Math.round(totalMs * 0.62), tonic: MOCK_TONICS[seed % MOCK_TONICS.length]!, mode },
    {
      startMs: Math.round(totalMs * 0.62),
      endMs: totalMs,
      tonic: MOCK_TONICS[(seed + 5) % MOCK_TONICS.length]!,
      mode: mode === 'major' ? 'minor' : 'major',
    },
  ];

  // Empty array = instrumental.
  const vocalRanges: Section[] | null =
    track.vocal === 'instrumental'
      ? []
      : structure.filter((s) => s.kind === 'verse' || s.kind === 'chorus').map((s) => ({ startMs: s.startMs, endMs: s.endMs }));

  const lastfmTags = [...trackGenres(track).map((genre) => genre.toLowerCase()), ...track.moods]
    .filter(Boolean)
    .slice(0, 4) as string[];

  // Reuse the editorial moods with plausible cosines for the demo.
  const audioMoods = track.analysed ? track.moods.slice(0, 2) : [];
  const audioMoodScores = audioMoods.length
    ? Object.fromEntries(audioMoods.map((m, i) => [m, Math.round((0.34 - i * 0.04 + rng() * 0.04) * 1000) / 1000]))
    : null;
  const fade = rng() < 0.4;
  const outro = track.analysed
    ? {
        startMs: Math.round(totalMs - (fade ? 9000 : 3000) - rng() * 4000),
        ending: (fade ? 'fade' : 'cold') as 'fade' | 'cold',
        lufs: track.loudnessLufs != null ? Math.round((track.loudnessLufs - (fade ? 7 : 1.5)) * 10) / 10 : null,
        bpm: track.bpm,
      }
    : null;

  return {
    track: {
      id: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album,
      year: track.year,
      genres: track.genres,
      genre: track.genre,
      durationSec: track.durationSec,
      moods: track.moods,
      energy: track.energy,
      source: track.source,
      confidence: track.confidence,
      taggerVersion: 3,
      model: 'ollama:glm-5.1:cloud',
      taggedAt: null,
      lastfmTags,
      lyricExcerpt: null,
      bpm: track.bpm,
      musicalKey: track.musicalKey,
      introMs,
      analysisConfidence: track.analysisConfidence,
      analysisVersion: 1,
      loudnessLufs: track.loudnessLufs,
      peakDb: track.loudnessLufs != null ? Math.round((track.loudnessLufs + 3) * 10) / 10 : null,
      structure,
      vocalRanges,
      pace,
      keyRanges,
      audioMoods,
      audioMoodScores,
      outro,
    },
    textEmbedding: embeddingVector(seed, 768),
    audioEmbedding: track.analysed ? embeddingVector(seed ^ 0x9e37, 512) : null,
    mixNext: [],
  };
}

/* ============================================================================
   SUB/WAVE — Library Observatory · data + layout
   Ported from the Claude Design prototype (data.jsx / viz.jsx helpers) and
   adapted to real library records. The prototype laid tracks out by genre
   cluster + gaussian spread — we reproduce that from real genres, so no
   embedding projection is needed. Continuous `energyVal` (for the heat ramp)
   is derived deterministically from the real `energy` band. A seeded mock
   library remains for the empty-library fallback.
   ============================================================================ */

// --- seeded RNG (mulberry32) ------------------------------------------------
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

// Stable string → uint32 seed (FNV-1a). Lets every per-track value seed off the
// track id, so positions/energy jitter are identical across reloads.
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

// nearest neighbours among a candidate list (spatial — used for synapse links
// and as the mix-next fallback when the server returned no KNN neighbours)
export function nearest(track: ObsTrack, list: ObsTrack[], k: number): ObsTrack[] {
  return list
    .filter((t) => t.idx !== track.idx)
    .map((t) => ({ t, d: dist2(track, t) }))
    .sort((p, q) => p.d - q.d)
    .slice(0, k)
    .map((p) => p.t);
}

// tally — count occurrences (single value or array per item), sorted desc
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

// Deterministic pseudo-embedding for the dossier fingerprint, used as a
// fallback when a track has no stored vector. Same look as the prototype's.
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

// Scale a real embedding to [-1,1] by its peak magnitude so the fingerprint has
// visible contrast (raw cosine-normalised vectors cluster near 0).
export function normaliseFingerprint(vec: number[]): number[] {
  let max = 0;
  for (const v of vec) max = Math.max(max, Math.abs(v));
  if (max === 0) return vec;
  return vec.map((v) => Math.max(-1, Math.min(1, v / max)));
}

export const CAMELOT_KEYS: string[] = [];
for (let n = 1; n <= 12; n++) {
  CAMELOT_KEYS.push(n + 'A');
  CAMELOT_KEYS.push(n + 'B');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Energy = 'low' | 'medium' | 'high' | null;

// Raw track row as it arrives from GET /library/observatory.
export interface RawTrack {
  id: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  year: number | null;
  genre: string | null;
  durationSec: number | null;
  moods: string[];
  energy: Energy;
  source: string | null;
  confidence: number | null;
  bpm: number | null;
  musicalKey: string | null;
  analysisConfidence: number | null;
}

// A track after layout — what the map / panels / tooltip consume.
export interface ObsTrack extends RawTrack {
  idx: number;
  energyVal: number; // continuous 0..1, derived from the energy band
  analysed: boolean; // bpm != null
  x: number;
  y: number;
  _eseed: number; // seed for the fallback fingerprint
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

export interface LibraryData {
  tracks: ObsTrack[];
  genres: string[];
  centers: Record<string, { x: number; y: number; angle: number }>;
  stats: ObservatoryStats;
  moodVocab: string[];
  truncated: boolean;
  mock: boolean;
}

// Detail payload from GET /library/observatory/track/:id
export interface TrackDetail {
  track: {
    id: string;
    title: string | null;
    artist: string | null;
    album: string | null;
    year: number | null;
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

// Continuous energy value (for the heat ramp) from the discrete band, jittered
// per-track off a dedicated seed so positions don't shift if this logic changes.
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

// ---------------------------------------------------------------------------
// Layout — place every track on a 1000×1000 disc, clustered by genre.
// ---------------------------------------------------------------------------
export function layoutTracks(raw: RawTrack[]): {
  tracks: ObsTrack[];
  genres: string[];
  centers: Record<string, { x: number; y: number; angle: number }>;
} {
  // Distinct genres, most-populous first, for a stable angular assignment.
  const counts: Record<string, number> = {};
  raw.forEach((t) => {
    const g = t.genre || NO_GENRE;
    counts[g] = (counts[g] || 0) + 1;
  });
  const genres = Object.keys(counts).sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0) || a.localeCompare(b));
  const n = Math.max(1, genres.length);

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
    const g = t.genre || NO_GENRE;
    const c = centers[g]!;
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
    };
  });

  return { tracks, genres, centers };
}

// ---------------------------------------------------------------------------
// Source palette — maps the REAL tag-source enum (llm | propagated |
// uncertain-llm | legacy-v1 | manual) to colour + filled/hollow + a short
// label. Used by colour-by=source and the tag-source filter.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Node appearance — shared by the SVG node layer, the hover overlay, and the
// canvas renderer so all three stay pixel-identical. `colorBy` selects what the
// ink→vermilion ramp / source palette encodes.
// ---------------------------------------------------------------------------
export type ColorBy = 'energy' | 'confidence' | 'source' | 'analysis';

export function nodeColor(t: ObsTrack, colorBy: ColorBy): string {
  if (colorBy === 'energy') return heat(t.energyVal);
  if (colorBy === 'confidence') return heat(0.15 + (t.confidence ?? 0.5) * 0.85);
  if (colorBy === 'source') return sourceStyle(t.source).color;
  if (colorBy === 'analysis') return t.analysed ? '#d94b2a' : '#9b948a';
  return '#4a443d';
}

export function nodeFilled(t: ObsTrack, colorBy: ColorBy): boolean {
  if (colorBy === 'source') return sourceStyle(t.source).filled;
  if (colorBy === 'analysis') return t.analysed;
  return true;
}

// ---------------------------------------------------------------------------
// Mock library — empty-library fallback. A trimmed port of the prototype's
// seeded generator, emitting the real ObsTrack shape (incl. layout + real
// source enum) so the UI looks identical with or without a backing library.
// ---------------------------------------------------------------------------
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

    tracks.push({
      id,
      idx: i,
      title: `${mpick(rng, MOCK_ADJ)} ${mpick(rng, MOCK_NOUN)}`,
      artist: (a1 ? a1 + ' ' : '') + a2,
      album: mpick(rng, MOCK_ALBUM),
      year,
      genre: scene.genre,
      durationSec: 150 + Math.floor(rng() * 200),
      moods,
      energy,
      source,
      confidence,
      bpm,
      musicalKey: analysed ? (CAMELOT_KEYS[Math.floor(rng() * 24)] ?? null) : null,
      analysisConfidence: analysed ? Math.round((0.55 + rng() * 0.43) * 100) / 100 : null,
      energyVal: Math.round(ev * 100) / 100,
      analysed,
      x,
      y,
      _eseed: Math.floor(rng() * 1e9),
    });
  }

  return {
    tracks,
    genres: MOCK_SCENES.map((s) => s.genre),
    centers,
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
    mock: true,
  };
}

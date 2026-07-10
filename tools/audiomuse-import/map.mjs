// Pure mapping from AudioMuse-AI's analysis vocabulary into SUB/WAVE's
// library.db columns. No I/O here — every function is a pure transform so it
// can be unit-tested (see map.test.mjs). Coupling note: the target shapes
// (Camelot musical_key, energy low/medium/high, the 17-mood vocab, the JSON
// moods array) mirror controller/src/music/library-db.ts + settings.ts — if
// those change, update this file to match.

// --- tag-score strings ------------------------------------------------------
// AudioMuse stores mood_vector / other_features as "label:score,label:score"
// with 3-decimal scores (database.py). Labels never contain a colon, so a
// single split on ":" is safe even for "easy listening" / "Hip-Hop" / "00s".
export function parseTagScores(str) {
  const out = {};
  if (!str || typeof str !== 'string') return out;
  for (const pair of str.split(',')) {
    const i = pair.indexOf(':');
    if (i < 0) continue;
    const label = pair.slice(0, i).trim();
    const score = Number(pair.slice(i + 1));
    if (label && Number.isFinite(score)) out[label] = score;
  }
  return out;
}

// --- musical key -> Camelot -------------------------------------------------
// AudioMuse gives key (e.g. "C", "F#", "Db") + scale ("major"/"minor").
// SUB/WAVE's musical_key is a Camelot code (e.g. "8A" = A minor, "8B" = C major).
const PITCH_CLASS = {
  C: 0, 'B#': 0, 'C#': 1, DB: 1, D: 2, 'D#': 3, EB: 3, E: 4, FB: 4,
  'E#': 5, F: 5, 'F#': 6, GB: 6, G: 7, 'G#': 8, AB: 8, A: 9, 'A#': 10,
  BB: 10, B: 11, CB: 11,
};
// Indexed by pitch class 0..11 (C..B).
const CAMELOT_MAJOR = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
const CAMELOT_MINOR = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];

export function keyToCamelot(key, scale) {
  if (!key || !scale) return null;
  const pc = PITCH_CLASS[String(key).trim().toUpperCase()];
  if (pc == null) return null;
  const mode = String(scale).trim().toLowerCase();
  if (mode === 'major') return CAMELOT_MAJOR[pc];
  if (mode === 'minor') return CAMELOT_MINOR[pc];
  return null;
}

// --- energy -> low/medium/high ---------------------------------------------
// AudioMuse energy is a raw RMS-ish REAL; it normalises against ENERGY_MIN/MAX
// (config.py) before use. We reproduce that range, then bucket into the three
// values SUB/WAVE's energy CHECK constraint allows.
const ENERGY_MIN = 0.01;
const ENERGY_MAX = 0.15;

export function energyToBucket(energy) {
  if (energy == null || !Number.isFinite(Number(energy))) return null;
  const n = Math.min(1, Math.max(0, (Number(energy) - ENERGY_MIN) / (ENERGY_MAX - ENERGY_MIN)));
  if (n < 0.34) return 'low';
  if (n < 0.67) return 'medium';
  return 'high';
}

// --- mood translation -------------------------------------------------------
// Static map from AudioMuse's tags (the 50 MusiCNN mood_vector labels + the 6
// CLAP other_features labels) to SUB/WAVE's 17 editorial moods (SHOW_MOODS in
// settings.ts). Keys are lower-cased for case-insensitive lookup. Only tags
// with a genuine mood signal are mapped; pure genre/decade/instrument tags
// (rock, pop, 80s, guitar…) intentionally map to nothing — SUB/WAVE's own
// audio-mood pass and the contextual moods (rainy/night/workout…) fill those.
export const AUDIOMUSE_MOOD_MAP = {
  // energetic
  aggressive: 'energetic', 'hard rock': 'energetic', 'heavy metal': 'energetic',
  metal: 'energetic', punk: 'energetic', electro: 'energetic', dance: 'energetic',
  house: 'energetic',
  // calm
  chill: 'calm', chillout: 'calm', mellow: 'calm', ambient: 'calm',
  'easy listening': 'calm', relaxed: 'calm', acoustic: 'calm',
  // reflective
  sad: 'reflective', beautiful: 'reflective', blues: 'reflective', folk: 'reflective',
  oldies: 'reflective',
  // celebratory
  happy: 'celebratory', party: 'celebratory', catchy: 'celebratory', funk: 'celebratory',
  danceable: 'celebratory',
  // romantic
  sexy: 'romantic', soul: 'romantic', rnb: 'romantic',
  // focus
  instrumental: 'focus', experimental: 'focus',
};

// Genre-like tags eligible to populate tracks.genre (order-independent set).
const GENRE_TAGS = new Set([
  'rock', 'pop', 'alternative', 'indie', 'electronic', 'dance', 'jazz', 'metal',
  'soul', 'folk', 'punk', 'blues', 'funk', 'country', 'hip-hop', 'rnb', 'house',
  'ambient', 'electronica', 'classic rock', 'hard rock', 'heavy metal', 'indie rock',
  'indie pop', 'alternative rock', 'progressive rock', 'electro', 'experimental',
]);

// Highest-scoring genre-like tag from a parsed mood_vector, or null. Returns the
// original-cased label as AudioMuse spelled it. `cutoff` gates confidence the
// same way moods are gated, so a near-zero tag ("metal:0.02") can't become a
// track's genre off noise (#934 review); default 0 keeps standalone callers
// unfiltered.
export function topGenre(moodScores, cutoff = 0) {
  let best = null;
  let bestScore = -Infinity;
  for (const [label, score] of Object.entries(moodScores)) {
    if (score < cutoff) continue;
    if (GENRE_TAGS.has(label.toLowerCase()) && score > bestScore) {
      best = label;
      bestScore = score;
    }
  }
  return best;
}

// Full per-track mapping. `row` is one entry from AudioMuse's /api/sync payload
// ({ tempo, key, scale, mood_vector, other_features, energy, ... }). Returns the
// SUB/WAVE-shaped fields to write. `moodCutoff` gates which tag scores count.
export function mapTrack(row, { moodCutoff = 0.4 } = {}) {
  const moodScores = parseTagScores(row.mood_vector);
  const otherScores = parseTagScores(row.other_features);

  const moods = [];
  const seen = new Set();
  for (const [label, score] of [...Object.entries(moodScores), ...Object.entries(otherScores)]) {
    if (score < moodCutoff) continue;
    const mood = AUDIOMUSE_MOOD_MAP[label.toLowerCase()];
    if (mood && !seen.has(mood)) {
      seen.add(mood);
      moods.push(mood);
    }
  }

  const bpm = Number.isFinite(Number(row.tempo)) && Number(row.tempo) > 0 ? Number(row.tempo) : null;

  return {
    bpm,
    musicalKey: keyToCamelot(row.key, row.scale),
    energy: energyToBucket(row.energy),
    moods,
    genre: topGenre(moodScores, moodCutoff),
  };
}

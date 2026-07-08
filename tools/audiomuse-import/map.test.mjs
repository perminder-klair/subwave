// Pure-mapping tests. Run: node --test  (no deps, no library.db needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTagScores,
  keyToCamelot,
  energyToBucket,
  topGenre,
  mapTrack,
  AUDIOMUSE_MOOD_MAP,
} from './map.mjs';

test('parseTagScores parses label:score pairs', () => {
  assert.deepEqual(parseTagScores('rock:0.812,indie:0.640'), { rock: 0.812, indie: 0.64 });
});

test('parseTagScores handles empty / null / malformed', () => {
  assert.deepEqual(parseTagScores(''), {});
  assert.deepEqual(parseTagScores(null), {});
  assert.deepEqual(parseTagScores('garbage'), {});
});

test('parseTagScores keeps multi-word and hyphen/decade labels', () => {
  const s = parseTagScores('easy listening:0.5,Hip-Hop:0.3,00s:0.9');
  assert.equal(s['easy listening'], 0.5);
  assert.equal(s['Hip-Hop'], 0.3);
  assert.equal(s['00s'], 0.9);
});

test('keyToCamelot maps majors and minors (relative pairs align)', () => {
  assert.equal(keyToCamelot('C', 'major'), '8B');
  assert.equal(keyToCamelot('A', 'minor'), '8A'); // relative minor of C major
  assert.equal(keyToCamelot('G', 'major'), '9B');
  assert.equal(keyToCamelot('E', 'minor'), '9A'); // relative minor of G major
  assert.equal(keyToCamelot('Eb', 'major'), '5B');
  assert.equal(keyToCamelot('C', 'minor'), '5A'); // relative minor of Eb major
});

test('keyToCamelot handles enharmonics and casing', () => {
  assert.equal(keyToCamelot('Db', 'major'), keyToCamelot('C#', 'major'));
  assert.equal(keyToCamelot('f#', 'MINOR'), '11A');
});

test('keyToCamelot returns null on missing / unknown input', () => {
  assert.equal(keyToCamelot('', 'major'), null);
  assert.equal(keyToCamelot('C', ''), null);
  assert.equal(keyToCamelot('H', 'major'), null);
  assert.equal(keyToCamelot('C', 'dorian'), null);
});

test('energyToBucket buckets across the normalised range', () => {
  assert.equal(energyToBucket(0.01), 'low'); // == ENERGY_MIN -> 0
  assert.equal(energyToBucket(0.08), 'medium'); // mid-range
  assert.equal(energyToBucket(0.15), 'high'); // == ENERGY_MAX -> 1
  assert.equal(energyToBucket(null), null);
  assert.equal(energyToBucket('x'), null);
});

test('energyToBucket only ever emits CHECK-valid values', () => {
  for (let e = 0; e <= 0.2; e += 0.005) {
    const b = energyToBucket(e);
    assert.ok(b === 'low' || b === 'medium' || b === 'high');
  }
});

test('topGenre picks the highest-scoring genre-like tag', () => {
  assert.equal(topGenre({ rock: 0.4, jazz: 0.9, happy: 0.99 }), 'jazz');
  assert.equal(topGenre({ happy: 0.9, sad: 0.8 }), null); // no genre tags
  assert.equal(topGenre({}), null);
});

test('topGenre honours the confidence cutoff', () => {
  // A near-zero genre tag must not win off noise once a cutoff is applied.
  assert.equal(topGenre({ metal: 0.02, rock: 0.9 }, 0.4), 'rock');
  assert.equal(topGenre({ metal: 0.02 }, 0.4), null);
  // The higher-confidence genre still wins even when both clear the cutoff.
  assert.equal(topGenre({ rock: 0.5, jazz: 0.9 }, 0.4), 'jazz');
});

test('mapTrack applies moodCutoff to genre too', () => {
  // metal below the default 0.4 cutoff → excluded from BOTH moods and genre.
  const m = mapTrack({ mood_vector: 'metal:0.05,rock:0.8', other_features: '' });
  assert.equal(m.genre, 'rock');
  const noisy = mapTrack({ mood_vector: 'metal:0.05', other_features: '' });
  assert.equal(noisy.genre, null);
});

test('mood map only carries genuine mood signal, not genre', () => {
  assert.equal(AUDIOMUSE_MOOD_MAP['rock'], undefined);
  assert.equal(AUDIOMUSE_MOOD_MAP['aggressive'], 'energetic');
  assert.equal(AUDIOMUSE_MOOD_MAP['chillout'], 'calm');
});

test('mapTrack produces the full SUB/WAVE shape and dedupes moods', () => {
  const row = {
    tempo: 128.4,
    key: 'A',
    scale: 'minor',
    mood_vector: 'rock:0.9,aggressive:0.7,chill:0.1,jazz:0.5',
    other_features: 'danceable:0.8,party:0.6,sad:0.2',
    energy: 0.12,
  };
  const m = mapTrack(row);
  assert.equal(m.bpm, 128.4);
  assert.equal(m.musicalKey, '8A');
  assert.equal(m.energy, 'high');
  assert.equal(m.genre, 'rock'); // highest genre tag
  // aggressive->energetic, danceable+party->celebratory (deduped); chill/sad below cutoff
  assert.deepEqual([...m.moods].sort(), ['celebratory', 'energetic']);
});

test('mapTrack tolerates missing analysis fields', () => {
  const m = mapTrack({ tempo: 0, key: null, scale: null, mood_vector: '', energy: null });
  assert.equal(m.bpm, null);
  assert.equal(m.musicalKey, null);
  assert.equal(m.energy, null);
  assert.deepEqual(m.moods, []);
  assert.equal(m.genre, null);
});

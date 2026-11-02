// The signal every TTY drawing reacts to: the band layout, the bounds every
// reader relies on, and the fallback that keeps a scene moving where Web
// Audio can't attach.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_HZ, MIN_HZ, STILL_SIGNAL, bandAt, bandEdgeHz, beatPulse, createSignal, feedSilence,
  feedSpectrum, feedSynthetic, feedWave, type Signal,
} from './signal';

const inRange = (sig: Signal) => {
  for (const v of [...sig.bands, ...sig.peaks, sig.level, sig.bass, sig.mid, sig.treble, sig.onset]) {
    assert.ok(v >= 0 && v <= 1, `${v} outside [0, 1]`);
  }
  for (const v of sig.wave) assert.ok(v >= -1.5 && v <= 1.5, `wave ${v}`);
};

test('band edges run log-spaced from the floor to the ceiling', () => {
  const n = 48;
  assert.equal(bandEdgeHz(0, n), MIN_HZ);
  assert.ok(Math.abs(bandEdgeHz(n, n) - MAX_HZ) < 1e-6);
  const ratio = bandEdgeHz(1, n) / bandEdgeHz(0, n);
  assert.ok(Math.abs(bandEdgeHz(31, n) / bandEdgeHz(30, n) - ratio) < 1e-9);
});

test('a loud flat spectrum fills the bands and stays in range', () => {
  const sig = createSignal();
  const bins = new Uint8Array(2048).fill(240);
  for (let i = 0; i < 30; i++) feedSpectrum(sig, bins, 44100, 1 / 30);
  inRange(sig);
  assert.ok(sig.level > 0.6);
  assert.equal(sig.live, true);
});

test('silence lets everything settle back to rest', () => {
  const sig = createSignal();
  for (let i = 0; i < 30; i++) feedSpectrum(sig, new Uint8Array(2048).fill(220), 48000, 1 / 30);
  for (let i = 0; i < 240; i++) feedSilence(sig, 1 / 30);
  assert.ok(sig.level < 0.02);
  assert.ok(Math.max(...sig.bands) < 0.02);
});

test('a sudden rise registers as an onset, then fades', () => {
  const sig = createSignal();
  for (let i = 0; i < 20; i++) feedSpectrum(sig, new Uint8Array(2048).fill(60), 44100, 1 / 30);
  feedSpectrum(sig, new Uint8Array(2048).fill(250), 44100, 1 / 30);
  assert.ok(sig.onset > 0.3);
  for (let i = 0; i < 30; i++) feedSpectrum(sig, new Uint8Array(2048).fill(250), 44100, 1 / 30);
  assert.ok(sig.onset < 0.05);
});

test('the scope trace starts on a rising zero crossing', () => {
  const sig = createSignal(8, 16);
  const samples = Uint8Array.from({ length: 1024 }, (_, i) => Math.round(128 + 100 * Math.sin(i / 9 + 2)));
  feedWave(sig, samples);
  assert.ok(Math.abs(sig.wave[0]!) < 0.1, `starts at ${sig.wave[0]}`);
  assert.ok(sig.wave[1]! > sig.wave[0]!, 'and rising');
});

test('the synthetic walk moves, stays in range, and says it is not live', () => {
  const sig = createSignal();
  sig.beat = 1;
  const seen = new Set<number>();
  for (let i = 0; i < 60; i++) {
    feedSynthetic(sig, i / 30, 1 / 30);
    seen.add(Math.round(sig.level * 100));
  }
  inRange(sig);
  assert.equal(sig.live, false);
  assert.ok(seen.size > 3, 'the level wanders');
});

test('the beat pulse peaks on the beat and has decayed by the next', () => {
  assert.equal(beatPulse(0), 1);
  assert.equal(beatPulse(3), 1);
  assert.ok(beatPulse(0.5) < 0.1);
  assert.ok(beatPulse(0.1) > beatPulse(0.2));
});

test('bands interpolate between neighbours', () => {
  const bands = Float32Array.from([0, 1]);
  assert.equal(bandAt(bands, 0), 0);
  assert.equal(bandAt(bands, 1), 1);
  assert.equal(bandAt(bands, 0.5), 0.5);
  assert.equal(bandAt(bands, 2), 1);
});

test('the still frame is a lit, in-range signal', () => {
  inRange(STILL_SIGNAL);
  assert.equal(STILL_SIGNAL.active, true);
  assert.ok(STILL_SIGNAL.level > 0.3);
});

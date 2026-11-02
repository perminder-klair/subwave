// What the music is doing right now, boiled down to the handful of numbers a
// drawing reacts to. Pure: useSignal feeds it from the shared Web Audio
// analyser when it can, and from a tempo-locked synthetic walk when it can't
// (iOS, which useAnalyser opts out of; a WebKit build that wires the graph
// but returns zeros) — so a scene moves to a song on every device, and moves
// to the real song where the browser lets it.

import { clamp, noise2 } from './noise';

export interface Signal {
  /** Log-spaced band levels in [0, 1], smoothed: fast attack, slow release. */
  bands: Float32Array;
  /** Per-band peak hold, falling slowly. */
  peaks: Float32Array;
  /** One trace in [-1, 1], started on a rising zero crossing so a steady
   *  tone stands still. */
  wave: Float32Array;
  level: number;
  bass: number;
  mid: number;
  treble: number;
  /** A 0..1 kick on a sudden rise in level, decaying over ~250ms. */
  onset: number;
  /** A 0..1 pulse at the track's tempo, peaking on the beat. */
  beat: number;
  /** True while sound is playing; false settles everything to rest. */
  active: boolean;
  /** True when the numbers come from the real audio. */
  live: boolean;
}

export const MIN_HZ = 40;
export const MAX_HZ = 16000;

export function createSignal(bands = 48, waveLength = 192): Signal {
  return {
    bands: new Float32Array(bands),
    peaks: new Float32Array(bands),
    wave: new Float32Array(waveLength),
    level: 0, bass: 0, mid: 0, treble: 0, onset: 0, beat: 0,
    active: false, live: false,
  };
}

/** Lower edge of band `i` of `n`, in Hz, on a log scale. */
export function bandEdgeHz(i: number, n: number): number {
  return MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, i / n);
}

/** A band array's level at a fractional position across it, interpolated. */
export function bandAt(bands: Float32Array, u: number): number {
  const f = clamp(u) * (bands.length - 1);
  const i = Math.floor(f);
  const a = bands[i] ?? 0;
  const b = bands[Math.min(bands.length - 1, i + 1)] ?? a;
  return a + (b - a) * (f - i);
}

/** Frame-rate independent easing toward a target: `rate` is per second. */
const ease = (from: number, to: number, rate: number, dt: number) =>
  from + (to - from) * (1 - Math.exp(-rate * dt));

function smoothInto(sig: Signal, target: Float32Array, dt: number): void {
  const { bands, peaks } = sig;
  for (let i = 0; i < bands.length; i++) {
    const cur = bands[i]!;
    const tgt = target[i]!;
    bands[i] = ease(cur, tgt, tgt > cur ? 28 : 5, dt);
    peaks[i] = Math.max(bands[i]!, peaks[i]! - dt * 0.35);
  }
  const n = bands.length;
  const avg = (a: number, b: number) => {
    let s = 0;
    for (let i = a; i < b; i++) s += bands[i]!;
    return s / Math.max(1, b - a);
  };
  const bass = avg(0, Math.round(n * 0.22));
  const mid = avg(Math.round(n * 0.22), Math.round(n * 0.62));
  const treble = avg(Math.round(n * 0.62), n);
  const level = bass * 0.45 + mid * 0.4 + treble * 0.15;
  // An onset is the level jumping clear of where it has been sitting.
  if (level - sig.level > 0.06 + dt * 0.5) sig.onset = Math.min(1, sig.onset + (level - sig.level) * 6);
  sig.onset = Math.max(0, sig.onset - dt * 4);
  sig.bass = bass;
  sig.mid = mid;
  sig.treble = treble;
  sig.level = ease(sig.level, level, 18, dt);
}

const scratch = new Map<number, Float32Array>();
const scratchOf = (n: number) => {
  let a = scratch.get(n);
  if (!a) { a = new Float32Array(n); scratch.set(n, a); }
  return a;
};

/** Byte FFT magnitudes (getByteFrequencyData) into the band levels. */
export function feedSpectrum(sig: Signal, bins: ArrayLike<number>, sampleRate: number, dt: number): void {
  const n = sig.bands.length;
  const target = scratchOf(n);
  const nyquist = sampleRate / 2;
  for (let i = 0; i < n; i++) {
    const lo = Math.floor((bandEdgeHz(i, n) / nyquist) * bins.length);
    const hi = Math.max(lo + 1, Math.floor((bandEdgeHz(i + 1, n) / nyquist) * bins.length));
    let s = 0;
    for (let b = lo; b < hi && b < bins.length; b++) s += bins[b]!;
    const raw = s / (hi - lo) / 255;
    // Byte bins are already dB-scaled; lift the floor off and tilt toward the
    // top, where music carries less energy than the eye expects to see.
    target[i] = clamp(((raw - 0.3) / 0.62) * (0.92 + 0.4 * (i / n)));
  }
  smoothInto(sig, target, dt);
  sig.live = true;
}

/** Byte time-domain samples (getByteTimeDomainData) into the trace. */
export function feedWave(sig: Signal, samples: ArrayLike<number>): void {
  const out = sig.wave;
  const stride = 4;
  const span = out.length * stride;
  let start = 0;
  for (let i = 1; i < samples.length - span; i++) {
    if (samples[i - 1]! < 128 && samples[i]! >= 128) { start = i; break; }
  }
  for (let i = 0; i < out.length; i++) out[i] = ((samples[start + i * stride] ?? 128) - 128) / 128;
}

/** A stand-in for the real thing: a spectrum-shaped noise walk that kicks on
 *  the beat, and a trace built from it. Deterministic in `t`. */
export function feedSynthetic(sig: Signal, t: number, dt: number): void {
  const n = sig.bands.length;
  const target = scratchOf(n);
  const kick = sig.beat;
  for (let i = 0; i < n; i++) {
    const f = i / n;
    const shape = 0.72 - f * 0.45;
    const wander = noise2(t * 1.7, i * 0.35, 11) * 0.7 + noise2(t * 6, i * 0.9, 12) * 0.3;
    target[i] = clamp(shape * (0.35 + wander * 0.75) + (f < 0.2 ? kick * 0.35 : kick * 0.08));
  }
  smoothInto(sig, target, dt);
  const w = sig.wave;
  const lvl = 0.25 + sig.level * 0.8;
  for (let i = 0; i < w.length; i++) {
    const p = i / w.length;
    w[i] = lvl * (Math.sin(p * Math.PI * 4) * (0.5 + sig.bass * 0.5)
      + Math.sin(p * Math.PI * 14 + t * 3) * sig.mid * 0.35
      + (noise2(p * 40, t * 9, 13) - 0.5) * sig.treble * 0.5);
  }
  sig.live = false;
}

/** Nothing playing: everything eases back to rest. */
export function feedSilence(sig: Signal, dt: number): void {
  smoothInto(sig, scratchOf(sig.bands.length).fill(0), dt);
  for (let i = 0; i < sig.wave.length; i++) sig.wave[i] = ease(sig.wave[i]!, 0, 10, dt);
  sig.live = false;
}

/** The tempo pulse: 1 on the beat, decaying quickly through it. `phase` is
 *  beats elapsed. */
export function beatPulse(phase: number): number {
  const p = phase - Math.floor(phase);
  return Math.exp(-p * 7);
}

/** What a still frame (lite mode, reduced motion) shows: a song mid-verse,
 *  so the picture is lit rather than dead. Never mutated. */
export const STILL_SIGNAL: Signal = (() => {
  const s = createSignal();
  for (let i = 0; i < s.bands.length; i++) {
    const f = i / s.bands.length;
    s.bands[i] = 0.66 - f * 0.4 + Math.sin(f * 19) * 0.06;
  }
  s.peaks.set(s.bands.map(v => Math.min(1, v + 0.08)));
  for (let i = 0; i < s.wave.length; i++) {
    const p = i / s.wave.length;
    s.wave[i] = Math.sin(p * Math.PI * 4) * 0.55 + Math.sin(p * Math.PI * 15) * 0.18;
  }
  Object.assign(s, { level: 0.5, bass: 0.62, mid: 0.45, treble: 0.3, beat: 0.4, active: true });
  return s;
})();

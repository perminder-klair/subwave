// The scope pane's four instruments, drawn in characters: a block spectrum
// with peak hold, a braille oscilloscope, an electric line that crackles and
// forks, and filament bars that arc between loud neighbours. Pure — they
// write palette indices into a Grid region; AsciiCanvas does the rest.

import type { Grid } from './term/grid';
import { clamp, hash2, noise2 } from './term/noise';
import { cool, hot, ink, mute } from './term/palette';
import { bandAt, MAX_HZ, MIN_HZ, type Signal } from './term/signal';

export type InstrumentId = 'spectrum' | 'scope' | 'electric' | 'filament';

export const INSTRUMENTS: ReadonlyArray<{ id: InstrumentId; label: string }> = [
  { id: 'spectrum', label: 'spectrum' },
  { id: 'scope', label: 'scope' },
  { id: 'electric', label: 'electric' },
  { id: 'filament', label: 'filament' },
];

export function isInstrument(v: unknown): v is InstrumentId {
  return INSTRUMENTS.some(i => i.id === v);
}

interface Spark { x: number; y: number; vx: number; vy: number; life: number }

/** What an instrument remembers between frames. */
export interface InstrumentState {
  sparks: Spark[];
  prev: Float32Array;
  lastT: number;
}

export function createInstrumentState(): InstrumentState {
  return { sparks: [], prev: new Float32Array(0), lastT: 0 };
}

export interface Area { x: number; y: number; w: number; h: number }

const LOWER = ' ▁▂▃▄▅▆▇█';

function spectrum(g: Grid, sig: Signal, a: Area): void {
  const axis = a.w >= 36 && a.h >= 5;
  const x0 = a.x + (axis ? 4 : 0);
  const w = a.w - (axis ? 4 : 0);
  const h = a.h - (axis ? 1 : 0);
  if (w < 2 || h < 1) return;
  if (axis) {
    g.text(a.x, a.y, '  0', mute(0.5));
    g.text(a.x, a.y + Math.floor(h / 2), '-30', mute(0.5));
    g.text(a.x, a.y + h - 1, '-60', mute(0.5));
    for (const [hz, label] of [[100, '100'], [1000, '1k'], [10000, '10k']] as const) {
      g.text(x0 + hzToCol(hz, w) - Math.floor(label.length / 2), a.y + h, label, mute(0.5));
    }
    for (let x = x0; x < x0 + w; x++) if (g.get(x, a.y + h) === 32) g.set(x, a.y + h, '┈', ink(0));
  }
  // Two-cell bars with a one-cell gap once there's room: an analyser's
  // bars, rather than a filled area.
  const pitch = w >= 60 ? 3 : 1;
  for (let c = 0; c < w; c++) {
    if (pitch > 1 && c % pitch === pitch - 1) continue;
    const u = (c - (c % pitch)) / Math.max(1, w - 1);
    const v = sig.active ? bandAt(sig.bands, u) : 0;
    const eighths = Math.round(v * h * 8);
    const peak = sig.active ? bandAt(sig.peaks, u) * h : 0;
    for (let r = 0; r < h; r++) {
      const y = a.y + h - 1 - r;
      const fill = eighths - r * 8;
      if (fill <= 0) {
        if (r === 0) g.set(x0 + c, y, '▁', mute(0.25));
        continue;
      }
      const frac = r / h;
      const color = frac > 0.78 ? hot(0.9) : frac > 0.5 ? ink(0.95) : ink(0.55 + frac * 0.6);
      g.set(x0 + c, y, LOWER[Math.min(8, fill)]!, color);
    }
    // The peak marker floats where the bar last reached.
    const pr = Math.floor(peak);
    if (peak > 0.3 && pr < h && pr * 8 + 4 > eighths) {
      g.set(x0 + c, a.y + h - 1 - pr, peak - pr < 0.5 ? '▁' : '▔', cool(0.95));
    }
  }
}

/** Braille dots: 2 across × 4 down per cell. */
function plotBraille(g: Grid, a: Area, dots: Uint8Array, colorOf: (cx: number, cy: number) => number): void {
  const BITS = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];
  const cells = new Uint8Array(a.w * a.h);
  const W = a.w * 2;
  for (let sy = 0; sy < a.h * 4; sy++) {
    for (let sx = 0; sx < W; sx++) {
      if (!dots[sy * W + sx]) continue;
      cells[Math.floor(sy / 4) * a.w + Math.floor(sx / 2)]! |= BITS[sy % 4]![sx % 2]!;
    }
  }
  for (let cy = 0; cy < a.h; cy++) {
    for (let cx = 0; cx < a.w; cx++) {
      const bits = cells[cy * a.w + cx]!;
      if (bits) g.set(a.x + cx, a.y + cy, 0x2800 + bits, colorOf(cx, cy));
    }
  }
}

/** Auto-gain so a quiet master still fills the window. */
function waveGain(wave: Float32Array): number {
  let max = 0;
  for (let i = 0; i < wave.length; i++) max = Math.max(max, Math.abs(wave[i]!));
  return Math.min(3, 0.9 / (max + 0.12));
}

function scope(g: Grid, sig: Signal, a: Area): void {
  const W = a.w * 2;
  const H = a.h * 4;
  if (W < 2 || H < 2) return;
  for (let x = 0; x < a.w; x += 1) g.set(a.x + x, a.y + Math.floor(a.h / 2), x % 2 ? '┈' : ' ', ink(0));
  const dots = new Uint8Array(W * H);
  const gain = waveGain(sig.wave);
  let prev = -1;
  for (let sx = 0; sx < W; sx++) {
    // Edges fade toward the centre line, the way a scope's trace does
    // between sweeps.
    const edge = Math.min(1, Math.min(sx, W - 1 - sx) / (W * 0.06));
    const v = (sig.wave[Math.floor((sx / W) * sig.wave.length)] ?? 0) * gain * edge;
    const sy = Math.round(clamp((1 - v) / 2) * (H - 1));
    const from = prev < 0 ? sy : prev;
    for (let y = Math.min(from, sy); y <= Math.max(from, sy); y++) dots[y * W + sx] = 1;
    prev = sy;
  }
  plotBraille(g, a, dots, (_cx, cy) => {
    const off = Math.abs(cy + 0.5 - a.h / 2) / (a.h / 2);
    return !sig.active ? mute(0.45) : off > 0.6 ? hot(0.95) : off > 0.3 ? ink(1) : ink(0.75);
  });
}

function spawn(st: InstrumentState, x: number, y: number, spread: number, n: number, seed: number): void {
  for (let i = 0; i < n && st.sparks.length < 48; i++) {
    const r1 = hash2(seed, i, 7);
    const r2 = hash2(seed, i, 8);
    st.sparks.push({ x, y, vx: (r1 - 0.5) * spread, vy: -2 - r2 * 6, life: 1 });
  }
}

function drawSparks(g: Grid, st: InstrumentState, a: Area, dt: number): void {
  const live: Spark[] = [];
  for (const s of st.sparks) {
    s.life -= dt * 2.2;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.vy += 9 * dt;
    if (s.life <= 0 || s.x < a.x || s.x >= a.x + a.w || s.y < a.y || s.y >= a.y + a.h) continue;
    g.set(s.x, s.y, s.life > 0.66 ? '*' : s.life > 0.33 ? '+' : '·', hot(0.4 + s.life * 0.6));
    live.push(s);
  }
  st.sparks = live;
}

const STEP = (dy: number) => (dy < 0 ? '╱' : dy > 0 ? '╲' : '─');

/** A write clipped to the instrument's own area: a fork or a mote off the
 *  line must not land in the pane next door. */
function within(g: Grid, a: Area, x: number, y: number, ch: string, ink: number): void {
  const cx = Math.round(x);
  const cy = Math.round(y);
  if (cx >= a.x && cx < a.x + a.w && cy >= a.y && cy < a.y + a.h) g.set(cx, cy, ch, ink);
}

function electric(g: Grid, sig: Signal, a: Area, t: number, st: InstrumentState, dt: number): void {
  if (a.w < 2 || a.h < 1) return;
  const mid = (a.h - 1) / 2;
  const gain = waveGain(sig.wave);
  const crackle = sig.active ? 0.25 + sig.level * 1.6 + sig.onset : 0.08;
  // At most a 12% brightness swing, and only frame to frame.
  const core = hot(0.9 + 0.1 * noise2(t * 20, 0, 3));
  const ys: number[] = [];
  for (let c = 0; c <= a.w; c++) {
    const edge = Math.min(1, Math.min(c, a.w - c) / (a.w * 0.08));
    const v = (sig.wave[Math.floor((c / a.w) * (sig.wave.length - 1))] ?? 0) * gain;
    const jag = (noise2(c * 0.7, t * 16, 5) - 0.5) * 2 * crackle;
    ys.push(clamp(mid - (v * mid * 0.9 + jag) * edge, 0, a.h - 1));
  }
  for (let c = 0; c < a.w; c++) {
    const y0 = Math.round(ys[c]!);
    const y1 = Math.round(ys[c + 1]!);
    const dy = y1 - y0;
    if (Math.abs(dy) > 1) {
      for (let y = Math.min(y0, y1) + 1; y < Math.max(y0, y1); y++) g.set(a.x + c, a.y + y, '│', core);
    }
    g.set(a.x + c, a.y + y0, STEP(Math.sign(dy)), core);
    // The halo: a few motes either side of the line.
    if (sig.active && noise2(c * 1.3, t * 9, 6) > 0.72 - crackle * 0.1) {
      const side = hash2(c, Math.floor(t * 12), 9) > 0.5 ? 1 : -1;
      const hy = a.y + y0 + side;
      if (g.get(a.x + c, hy) === 32) within(g, a, a.x + c, hy, '·', hot(0.45));
    }
    // A fork off a loud peak: a short branch running away from the centre.
    if (sig.active && Math.abs(y0 - mid) > mid * 0.55 && noise2(c * 0.5, t * 6, 4) > 0.78 - sig.level * 0.2) {
      const dir = y0 < mid ? -1 : 1;
      const lean = hash2(c, Math.floor(t * 8), 10) > 0.5 ? 1 : -1;
      for (let k = 1; k <= 3; k++) {
        within(g, a, a.x + c + lean * k, a.y + y0 + dir * k, lean * dir < 0 ? '╱' : '╲', hot(0.75 - k * 0.12));
      }
    }
  }
  if (sig.onset > 0.35) {
    const c = Math.floor(hash2(Math.floor(t * 30), 1, 11) * a.w);
    spawn(st, a.x + c, a.y + ys[c]!, 10, 3, Math.floor(t * 60));
  }
  drawSparks(g, st, a, dt);
}

function filament(g: Grid, sig: Signal, a: Area, t: number, st: InstrumentState, dt: number): void {
  const pitch = a.w >= 48 ? 3 : 2;
  const n = Math.floor(a.w / pitch);
  if (n < 1 || a.h < 2) return;
  if (st.prev.length !== n) st.prev = new Float32Array(n);
  const x0 = a.x + Math.floor((a.w - n * pitch) / 2) + 1;
  const tips: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = sig.active ? bandAt(sig.bands, i / Math.max(1, n - 1)) : 0;
    const height = Math.max(1, Math.round(v * a.h));
    const bx = x0 + i * pitch;
    const jag = clamp(v * 1.5);
    let last = 0;
    for (let r = 0; r < height; r++) {
      const off = Math.round((noise2(i * 3.1, r * 0.8 + t * 9, 2) - 0.5) * 2 * jag);
      const y = a.y + a.h - 1 - r;
      const ch = r === 0 ? '╽' : off > last ? '╱' : off < last ? '╲' : v > 0.6 ? '┃' : '│';
      const tip = r === height - 1;
      g.set(bx + off, y, sig.active ? ch : '·', !sig.active ? mute(0.35) : tip ? hot(1) : hot(0.45 + (r / a.h) * 0.45));
      last = off;
    }
    tips.push(a.y + a.h - height);
    if (sig.active && v - st.prev[i]! > 0.12) spawn(st, bx, a.y + a.h - height - 1, 6, 2, i * 977 + Math.floor(t * 50));
    st.prev[i] = v;
  }
  // Arcs between loud neighbours, flickering on and off.
  for (let i = 0; i < n - 1; i++) {
    const loud = a.h - (tips[i]! - a.y);
    const next = a.h - (tips[i + 1]! - a.y);
    if (loud < a.h * 0.55 || next < a.h * 0.55) continue;
    if (noise2(i * 2.3, t * 18, 7) < 0.45) continue;
    const y = Math.max(tips[i]!, tips[i + 1]!);
    for (let k = 1; k < pitch; k++) g.set(x0 + i * pitch + k, y, '~', cool(0.95));
  }
  drawSparks(g, st, a, dt);
}

/** Draw instrument `id` into area `a` (the whole grid by default). */
export function drawInstrument(
  id: InstrumentId,
  g: Grid,
  sig: Signal,
  t: number,
  st: InstrumentState,
  a: Area = { x: 0, y: 0, w: g.cols, h: g.rows },
): void {
  const dt = clamp(t - st.lastT, 0, 0.1);
  st.lastT = t;
  if (id === 'spectrum') spectrum(g, sig, a);
  else if (id === 'scope') scope(g, sig, a);
  else if (id === 'electric') electric(g, sig, a, t, st, dt);
  else filament(g, sig, a, t, st, dt);
}

/** Where a frequency lands across `w` cells of the log axis. */
export function hzToCol(hz: number, w: number): number {
  return Math.round((Math.log(hz / MIN_HZ) / Math.log(MAX_HZ / MIN_HZ)) * (w - 1));
}

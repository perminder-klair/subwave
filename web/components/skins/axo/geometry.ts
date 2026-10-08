// The AXO stack's drawing, computed once. 30° isometric: a world point (x, y, z)
// lands on screen at ((x − y)·cos30, (x + y)·sin30 − z). Each box face is drawn
// flat inside a shear matrix so its controls can be laid out in plain 2D, and
// silhouettes are traced separately at a heavier pen. Pure data, no React.

const C = 0.8660254;
const S = 0.5;

type Pt = [number, number];

const n = (v: number) => Math.round(v * 100) / 100;
const P = (x: number, y: number, z: number): Pt => [n((x - y) * C), n((x + y) * S - z)];
const mat = (a: number, b: number, c: number, d: number, p: Pt) =>
  `matrix(${[a, b, c, d, p[0], p[1]].join(' ')})`;

export interface BoxFaces {
  /** Top face — its local x runs along world x, local y along world y. */
  T: string;
  /** Front-left face — local x along world x, local y downward. */
  L: string;
  /** Front-right face — local x along world −y, local y downward. */
  R: string;
}

const box = (x: number, y: number, z: number, w: number, d: number, h: number): BoxFaces => ({
  T: mat(C, S, -C, S, P(x, y, z + h)),
  L: mat(C, S, 0, 1, P(x, y + d, z + h)),
  R: mat(C, -S, 0, 1, P(x + w, y + d, z + h)),
});

const poly = (pts: Pt[]) => `M${pts.map(p => p.join(' ')).join('L')}Z`;

const sil = (x: number, y: number, z: number, w: number, d: number, h: number) =>
  poly([
    P(x, y, z + h), P(x + w, y, z + h), P(x + w, y, z),
    P(x + w, y + d, z), P(x, y + d, z), P(x, y + d, z + h),
  ]);

/** Tick ring around a knob, sweeping 270° from −135°. */
const ring = (cx: number, cy: number, r0: number, r1: number, count: number) => {
  let d = '';
  for (let i = 0; i <= count; i++) {
    const a = ((-135 + (i * 270) / count) * Math.PI) / 180;
    d += `M${n(cx + Math.sin(a) * r0)} ${n(cy - Math.cos(a) * r0)}L${n(cx + Math.sin(a) * r1)} ${n(cy - Math.cos(a) * r1)}`;
  }
  return d;
};

/** Floor hatching: a strip on the ground to the +x side of an object, 45° in plan. */
const hatchStrip = (x0: number, x1: number, y0: number, y1: number, step: number) => {
  let d = '';
  const W = x1 - x0;
  for (let k = y0; k <= y1 + W; k += step) {
    const t0 = Math.max(0, k - y1);
    const t1 = Math.min(W, k - y0);
    if (t1 - t0 < 1) continue;
    d += `M${P(x0 + t0, k - t0, 0).join(' ')}L${P(x0 + t1, k - t1, 0).join(' ')}`;
  }
  return d;
};

/** A hand-drawn loop that doesn't quite close, for circling a control. */
const loop = (cx: number, cy: number, rx: number, ry: number) => {
  let d = '';
  for (let i = 0; i <= 44; i++) {
    const a = -0.6 + (i / 44) * (Math.PI * 2 + 0.9);
    const w = 1 + 0.07 * Math.sin(a * 3 + 1);
    const dx = (i / 44) * 4;
    d += `${i ? 'L' : 'M'}${n(cx + dx + Math.cos(a) * rx * w)} ${n(cy - dx * 0.5 + Math.sin(a) * ry * w)}`;
  }
  return d;
};

const arrow = (x0: number, y0: number, qx: number, qy: number, x1: number, y1: number) => {
  const ang = Math.atan2(y1 - qy, x1 - qx);
  const h = 10;
  const a1 = ang + Math.PI - 0.45;
  const a2 = ang + Math.PI + 0.45;
  return `M${x0} ${y0}Q${qx} ${qy} ${x1} ${y1}`
    + `M${n(x1 + Math.cos(a1) * h)} ${n(y1 + Math.sin(a1) * h)}L${x1} ${y1}L${n(x1 + Math.cos(a2) * h)} ${n(y1 + Math.sin(a2) * h)}`;
};

let dialTicks = '';
for (let i = 0; i <= 13; i++) dialTicks += `M${16 + i * 8} 11V${i % 4 === 0 ? 20 : 15}`;

const lidA = P(10, 10, 256), lidB = P(230, 10, 256), lidC = P(230, -24.16, 383.5), lidD = P(10, -24.16, 383.5);
const li = P(18, 4, 268), lj = P(222, 4, 268), lk = P(222, -18, 372), ll = P(18, -18, 372);
const g1 = P(40, 0, 290), g2 = P(70, -12, 335), g3 = P(56, 0, 300), g4 = P(78, -9, 330);
const pw = P(152, 142, 64), mu = P(152, 142, 33);
const lcdA = P(22, 142, 44), lcdB = P(124, 142, 30);

export interface SigBar { x: number; y: number; h: number }

export const AXO = {
  spL: box(-130, 20, 0, 80, 100, 250),
  spR: box(290, 20, 0, 80, 100, 250),
  pBL: box(0, 0, 0, 8, 8, 232), pBR: box(232, 0, 0, 8, 8, 232),
  pFL: box(0, 142, 0, 8, 8, 232), pFR: box(232, 142, 0, 8, 8, 232),
  s0: box(0, 0, 0, 240, 150, 8), s1: box(0, 0, 108, 240, 150, 8), s2: box(0, 0, 224, 240, 150, 8),
  rcv: box(10, 10, 8, 220, 132, 80),
  tape: box(10, 10, 116, 220, 132, 62),
  tt: box(10, 10, 232, 220, 132, 24),
  silSpL: sil(-130, 20, 0, 80, 100, 250),
  silSpR: sil(290, 20, 0, 80, 100, 250),
  silRcv: sil(10, 10, 8, 220, 132, 80),
  silTape: sil(10, 10, 116, 220, 132, 62),
  silTt: sil(10, 10, 232, 220, 132, 24),
  hatch: hatchStrip(-50, -24, 26, 120, 7) + hatchStrip(240, 270, 8, 150, 7) + hatchStrip(370, 396, 26, 120, 7),
  lid: poly([lidA, lidB, lidC, lidD]),
  lidInner: poly([li, lj, lk, ll]),
  lidGlint: `M${g1.join(' ')}L${g2.join(' ')}M${g3.join(' ')}L${g4.join(' ')}`,
  dialTicks,
  volTicks: ring(186, 38, 25, 29, 14),
  sigBars: [0, 1, 2, 3, 4].map((i): SigBar => ({ x: 61 + i * 4, h: n(2 + i * 1.3), y: n(74.6 - (2 + i * 1.3)) })),
  /** Sound lines: two per speaker, keyed `speaker:ring`. */
  arcs: [[0, 0], [0, 1], [1, 0], [1, 1]] as Array<[number, number]>,
  /** Screen position of each woofer's centre, which the sound lines radiate from. */
  woofers: [P(-90, 120, 72), P(330, 120, 72)] as [Pt, Pt],
  loopPower: loop(pw[0], pw[1], 18, 13),
  loopMute: loop(mu[0], mu[1], 20, 12),
  arrowPress: arrow(-62, 198, -20, 190, -2, 102),
  arrowMute: arrow(-96, 184, -50, 176, -14, 132),
  crossLcd: `M${lcdA.join(' ')}L${lcdB.join(' ')}M${P(22, 142, 30).join(' ')}L${P(124, 142, 44).join(' ')}`,
} as const;

/** Desktop frames the whole stack; mobile crops to the receiver and tape deck,
 *  so every control reads about 1.3× larger. */
export const VIEWBOX = {
  desk: '-250 -410 590 680',
  mobile: '-160 -178 290 372',
} as const;

/** Volume knob pointer angle in degrees: −135 at 0, +135 at full. */
export function knobAngle(volume: number): number {
  return -135 + Math.min(1, Math.max(0, volume)) * 270;
}

/** Tonearm angle about its pivot. Rest, cueing toward the lead-in, then
 *  tracking inward across the record as the song plays. */
export function armAngle(phase: 'rest' | 'cue' | 'play', ratio: number | null): number {
  if (phase === 'play') return 38 + (ratio ?? 0) * 14;
  return phase === 'cue' ? 30 : 6;
}

/** Sound-line arc for one ring of one speaker at a given energy (0..1). */
export function arcPath(speaker: number, ringIdx: number, energy: number): string {
  const [cx, cy] = AXO.woofers[speaker] ?? AXO.woofers[0];
  const R = 48 + ringIdx * 16 + energy * 8;
  const a0 = (118 * Math.PI) / 180;
  const a1 = (182 * Math.PI) / 180;
  return `M${(cx + Math.cos(a0) * R).toFixed(1)} ${(cy + Math.sin(a0) * R).toFixed(1)}`
    + `A${R.toFixed(1)} ${R.toFixed(1)} 0 0 1 ${(cx + Math.cos(a1) * R).toFixed(1)} ${(cy + Math.sin(a1) * R).toFixed(1)}`;
}

/** Sound-line opacity for a ring: the outer ring only shows on louder passages. */
export function arcOpacity(ringIdx: number, energy: number): number {
  return Math.max(0, Math.min(0.75, energy * 1.1 - ringIdx * 0.25));
}

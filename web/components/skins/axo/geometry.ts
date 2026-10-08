// The AXO stack's drawing, computed once with the shared isometric kit
// (components/iso/geometry.ts): every box is its three faces in a shear
// matrix, silhouettes traced separately at a heavier pen. Pure data, no React.

import { arrow, drawBlock, hatchStrip, loop, poly, project, round2, type DrawnBlock, type Pt } from '@/components/iso/geometry';

export type { DrawnBlock };

/** Tick ring around a knob, sweeping 270° from −135°. */
const ring = (cx: number, cy: number, r0: number, r1: number, count: number) => {
  let d = '';
  for (let i = 0; i <= count; i++) {
    const a = ((-135 + (i * 270) / count) * Math.PI) / 180;
    d += `M${round2(cx + Math.sin(a) * r0)} ${round2(cy - Math.cos(a) * r0)}L${round2(cx + Math.sin(a) * r1)} ${round2(cy - Math.cos(a) * r1)}`;
  }
  return d;
};

let dialTicks = '';
for (let i = 0; i <= 13; i++) dialTicks += `M${16 + i * 8} 11V${i % 4 === 0 ? 20 : 15}`;

const lidA = project(10, 10, 256), lidB = project(230, 10, 256), lidC = project(230, -24.16, 383.5), lidD = project(10, -24.16, 383.5);
const li = project(18, 4, 268), lj = project(222, 4, 268), lk = project(222, -18, 372), ll = project(18, -18, 372);
const g1 = project(40, 0, 290), g2 = project(70, -12, 335), g3 = project(56, 0, 300), g4 = project(78, -9, 330);
const pw = project(152, 142, 64), mu = project(152, 142, 33);
const lcdA = project(22, 142, 44), lcdB = project(124, 142, 30);

/** A corner post of the rack, 8 × 8 and as tall as the shelving. */
const post = (x: number, y: number) => drawBlock({ x, y, z: 0, w: 8, d: 8, h: 232 });
/** A rack shelf at height z. */
const shelf = (z: number) => drawBlock({ x: 0, y: 0, z, w: 240, d: 150, h: 8 });
/** A component sitting in the rack: receiver, tape deck or turntable. */
const unit = (z: number, h: number) => drawBlock({ x: 10, y: 10, z, w: 220, d: 132, h });
/** A floor-standing speaker. */
const speaker = (x: number) => drawBlock({ x, y: 20, z: 0, w: 80, d: 100, h: 250 });

export interface SigBar { x: number; y: number; h: number }

export const AXO = {
  spL: speaker(-130),
  spR: speaker(290),
  pBL: post(0, 0), pBR: post(232, 0),
  pFL: post(0, 142), pFR: post(232, 142),
  s0: shelf(0), s1: shelf(108), s2: shelf(224),
  rcv: unit(8, 80),
  tape: unit(116, 62),
  tt: unit(232, 24),
  hatch: hatchStrip(-50, -24, 26, 120, 7) + hatchStrip(240, 270, 8, 150, 7) + hatchStrip(370, 396, 26, 120, 7),
  lid: poly([lidA, lidB, lidC, lidD]),
  lidInner: poly([li, lj, lk, ll]),
  lidGlint: `M${g1.join(' ')}L${g2.join(' ')}M${g3.join(' ')}L${g4.join(' ')}`,
  dialTicks,
  volTicks: ring(186, 38, 25, 29, 14),
  sigBars: [0, 1, 2, 3, 4].map((i): SigBar => ({ x: 61 + i * 4, h: round2(2 + i * 1.3), y: round2(74.6 - (2 + i * 1.3)) })),
  /** Sound lines: two per speaker, keyed `speaker:ring`. */
  arcs: [[0, 0], [0, 1], [1, 0], [1, 1]] as Array<[number, number]>,
  /** Screen position of each woofer's centre, which the sound lines radiate from. */
  woofers: [project(-90, 120, 72), project(330, 120, 72)] as [Pt, Pt],
  loopPower: loop(pw[0], pw[1], 18, 13),
  loopMute: loop(mu[0], mu[1], 20, 12),
  arrowPress: arrow(-62, 198, -20, 190, -2, 102),
  arrowMute: arrow(-96, 184, -50, 176, -14, 132),
  crossLcd: `M${lcdA.join(' ')}L${lcdB.join(' ')}M${project(22, 142, 30).join(' ')}L${project(124, 142, 44).join(' ')}`,
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

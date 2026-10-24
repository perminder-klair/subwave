// The AXO stack's drawing, computed once with the shared isometric kit
// (components/iso/geometry.ts): every box is its three faces in a shear
// matrix, silhouettes traced separately at a heavier pen. Pure data, no React.

import { drawBlock, hatchStrip, poly, project, round2, type DrawnBlock, type Pt } from '@/components/iso/geometry';

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
for (let i = 0; i <= 13; i++) dialTicks += `M${16 + i * 8} 13V${i % 4 === 0 ? 22 : 17}`;

/** Convex hull of screen points (monotone chain), for an outline of a shape
 *  whose corners don't fall on one obvious ring. */
function hull(pts: Pt[]): Pt[] {
  const s = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: Pt[]) => {
    const out: Pt[] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(s), ...half([...s].reverse())];
}

// The dust cover: a clear box 220 × 132, its walls LID.h deep, swung open on
// hinges along the plinth's back edge. Closed it would sit on the plinth's
// top; open, every point turns about the hinge line (y = LID.y, z = LID.z)
// past upright, so the open rim faces the viewer and the whole cover stays
// behind the plinth — which is what lets it be drawn before the turntable.
export const LID = { x0: 10, x1: 230, y: 10, z: 256, d: 132, h: 18, deg: 104 } as const;
const LID_C = Math.cos((LID.deg * Math.PI) / 180);
const LID_S = Math.sin((LID.deg * Math.PI) / 180);
/** Where a point of the closed cover, `dy` in from its hinge edge and `dz` up
 *  off the plinth, sits with the cover open: its world [y, z]. */
export const lidWorld = (dy: number, dz: number): [number, number] =>
  [LID.y + dy * LID_C - dz * LID_S, LID.z + dy * LID_S + dz * LID_C];
const lidAt = (x: number, dy: number, dz: number): Pt => project(x, ...lidWorld(dy, dz));
const lidQuad = (pts: Array<[number, number, number]>) => poly(pts.map(([x, dy, dz]) => lidAt(x, dy, dz)));
const { x0: L0, x1: L1, d: LD, h: LH } = LID;
const lidCorners: Pt[] = [0, LD].flatMap(dy => [0, LH].flatMap(dz => [lidAt(L0, dy, dz), lidAt(L1, dy, dz)]));

// The cover's panel as a flat sheet, for anything laid out ON the glass (the
// focus-mode screen): u runs along the hinge left to right, v down from the
// cover's free edge, both in world units. The projection is affine, so one
// matrix carries the whole sheet onto the screen; measured across the full
// panel so the 2-decimal rounding in `project` washes out.
const LW = L1 - L0;
const sheetO = lidAt(L0, LD, LH);
const sheetU: Pt = [(lidAt(L1, LD, LH)[0] - sheetO[0]) / LW, (lidAt(L1, LD, LH)[1] - sheetO[1]) / LW];
const sheetV: Pt = [(lidAt(L0, 0, LH)[0] - sheetO[0]) / LD, (lidAt(L0, 0, LH)[1] - sheetO[1]) / LD];
const sheetDet = sheetU[0] * sheetV[1] - sheetV[0] * sheetU[1];
/** A screen point back onto the sheet. */
const toSheet = ([x, y]: Pt): Pt => {
  const px = x - sheetO[0], py = y - sheetO[1];
  return [(px * sheetV[1] - py * sheetV[0]) / sheetDet, (py * sheetU[0] - px * sheetU[1]) / sheetDet];
};
// Each wall runs from a panel edge to the matching rim edge, so where the rim
// lands on the sheet says how much of each edge a wall hides.
const [rimU, rimV] = toSheet(lidAt(L0, LD, 0));
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const sheetM = [...sheetU, ...sheetV, ...sheetO].map(r4) as [number, number, number, number, number, number];

export const LID_SHEET = {
  /** The sheet-to-screen map, as SVG matrix(a b c d e f) numbers. */
  m: sheetM,
  transform: `matrix(${sheetM.join(' ')})`,
  w: LW,
  h: LD,
  /** Seen from inside through the open rim, the sheet must still read left to
   *  right: a negative determinant would mirror everything printed on it. */
  mirrored: sheetDet < 0,
  /** The part of the sheet no wall stands in front of. */
  clear: {
    x0: round2(Math.max(0, rimU)),
    y0: round2(Math.max(0, rimV)),
    x1: round2(LW + Math.min(0, rimU)),
    y1: round2(LD + Math.min(0, rimV)),
  },
} as const;

// The rack: three shelves on four corner posts. Each post is drawn as the
// segments BETWEEN shelves, so a shelf passes in front of the post it rests
// on rather than the post slicing down through every shelf front, and each
// segment goes on in depth order — a front segment after the unit beside it.
// A post is 10 wide, so its inner face lines up with the units' sides and no
// gap opens between a post and the unit next to it.
const SHELF_H = 8;
/** A rack post segment from z0 up to z1. */
const post = (x: number, y: number, z0: number, z1: number) => drawBlock({ x, y, z: z0, w: 10, d: 8, h: z1 - z0 });
/** A rack shelf at height z. */
const shelf = (z: number) => drawBlock({ x: 0, y: 0, z, w: 240, d: 150, h: SHELF_H });
/** A component sitting in the rack: receiver, tape deck or turntable. */
const unit = (z: number, h: number) => drawBlock({ x: 10, y: 10, z, w: 220, d: 132, h });
/** A floor-standing speaker. */
const speaker = (x: number) => drawBlock({ x, y: 20, z: 0, w: 80, d: 100, h: 250 });

/** One bay of the rack, bottom up: the shelf, the post segments standing on
 *  it behind and in front of the unit it carries. The top shelf has none. */
export interface RackLevel { shelf: DrawnBlock; back: DrawnBlock[]; front: DrawnBlock[] }
/** The bay whose shelf sits at z, its posts rising to the next shelf up. */
const bay = (z: number, next: number | null): RackLevel => {
  if (next == null) return { shelf: shelf(z), back: [], front: [] };
  const z0 = z + SHELF_H;
  return {
    shelf: shelf(z),
    back: [post(0, 0, z0, next), post(230, 0, z0, next)],
    front: [post(0, 142, z0, next), post(230, 142, z0, next)],
  };
};
const rack: [RackLevel, RackLevel, RackLevel] = [bay(0, 108), bay(108, 224), bay(224, null)];

export interface SigBar { x: number; y: number; h: number }

export const AXO = {
  spL: speaker(-130),
  spR: speaker(290),
  rack,
  rcv: unit(8, 80),
  tape: unit(116, 62),
  tt: unit(232, 24),
  /** Hinge knuckles straddling the plinth's back edge, over the cover's foot. */
  hinges: [drawBlock({ x: 40, y: 7, z: 256, w: 14, d: 7, h: 4 }), drawBlock({ x: 166, y: 7, z: 256, w: 14, d: 7, h: 4 })],
  /** The shadow each floor-standing piece casts on the floor beside it, away
   *  from the light, hatched in pen. */
  hatch: hatchStrip(-50, -24, 26, 120, 7) + hatchStrip(240, 270, 8, 150, 7) + hatchStrip(370, 396, 26, 120, 7),
  lid: {
    /** The top panel, seen from inside through the open rim. */
    panel: lidQuad([[L0, 0, LH], [L1, 0, LH], [L1, LD, LH], [L0, LD, LH]]),
    back: lidQuad([[L0, 0, 0], [L1, 0, 0], [L1, 0, LH], [L0, 0, LH]]),
    left: lidQuad([[L0, 0, 0], [L0, LD, 0], [L0, LD, LH], [L0, 0, LH]]),
    right: lidQuad([[L1, 0, 0], [L1, LD, 0], [L1, LD, LH], [L1, 0, LH]]),
    front: lidQuad([[L0, LD, 0], [L1, LD, 0], [L1, LD, LH], [L0, LD, LH]]),
    /** The open rim, nearest the viewer. */
    rim: lidQuad([[L0, 0, 0], [L1, 0, 0], [L1, LD, 0], [L0, LD, 0]]),
    sil: poly(hull(lidCorners)),
    glint: `M${lidAt(42, 14, LH).join(' ')}L${lidAt(84, 70, LH).join(' ')}`
      + `M${lidAt(62, 16, LH).join(' ')}L${lidAt(96, 60, LH).join(' ')}`
      + `M${lidAt(150, 96, LH).join(' ')}L${lidAt(172, 124, LH).join(' ')}`,
  },
  dialTicks,
  volTicks: ring(186, 38, 25, 29, 14),
  sigBars: [0, 1, 2, 3, 4].map((i): SigBar => ({ x: 61 + i * 4, h: round2(2 + i * 1.3), y: round2(74.6 - (2 + i * 1.3)) })),
  /** Sound lines: two per speaker, keyed `speaker:ring`. */
  arcs: [[0, 0], [0, 1], [1, 0], [1, 1]] as Array<[number, number]>,
  /** Screen position of each woofer's centre, which the sound lines radiate from. */
  woofers: [project(-90, 120, 72), project(330, 120, 72)] as [Pt, Pt],
} as const;

/** Both frame the whole stack. Desktop leaves room for the ON AIR sign above
 *  it; mobile hugs the speakers, the open lid and the sound lines, so the
 *  drawing fills as much of a phone as it can. */
export const VIEWBOX = {
  desk: '-250 -410 590 680',
  mobile: '-254 -404 570 672',
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

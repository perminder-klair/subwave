// The 30° isometric drawing kit, shared by the AXO skin and the broadsheet's
// figures. A world point (x, y, z) lands on screen at ((x − y)·cos30,
// (x + y)·sin30 − z): world x runs down-right, world y down-left, z straight
// up. Each box face is drawn flat inside a shear matrix so whatever sits on it
// can be laid out in plain 2D, and silhouettes are traced separately at a
// heavier pen. Pure data, no React.

export const COS30 = 0.8660254;
export const SIN30 = 0.5;

export type Pt = [number, number];

/** A box in world units: its back corner at (x, y, z), `w` along world x,
 *  `d` along world y and `h` straight up. */
export interface Block {
  x: number;
  y: number;
  z: number;
  w: number;
  d: number;
  h: number;
}

/** Two decimals: enough for a crisp line, short enough to keep paths small. */
export const round2 = (v: number) => Math.round(v * 100) / 100;

/** Project a world point onto the screen. */
export const project = (x: number, y: number, z: number): Pt => [
  round2((x - y) * COS30),
  round2((x + y) * SIN30 - z),
];

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

/** The three visible faces of a block, as SVG transforms. Draw a w×d rect in
 *  T, w×h in L and d×h in R. */
export const boxFaces = ({ x, y, z, w, d, h }: Block): BoxFaces => ({
  T: mat(COS30, SIN30, -COS30, SIN30, project(x, y, z + h)),
  L: mat(COS30, SIN30, 0, 1, project(x, y + d, z + h)),
  R: mat(COS30, -SIN30, 0, 1, project(x + w, y + d, z + h)),
});

export const poly = (pts: Pt[]) => `M${pts.map(p => p.join(' ')).join('L')}Z`;

/** A block's outline as seen from the front: the heavier pen around its faces. */
export const silhouette = ({ x, y, z, w, d, h }: Block) =>
  poly([
    project(x, y, z + h), project(x + w, y, z + h), project(x + w, y, z),
    project(x + w, y + d, z), project(x, y + d, z), project(x, y + d, z + h),
  ]);

/** A block ready to draw: its faces and silhouette, carrying its own size so
 *  a renderer sizes each face's rect from it rather than retyping w, d and h. */
export interface DrawnBlock extends BoxFaces, Pick<Block, 'w' | 'd' | 'h'> {
  sil: string;
}

export const drawBlock = (b: Block): DrawnBlock => ({
  ...boxFaces(b),
  sil: silhouette(b),
  w: b.w,
  d: b.d,
  h: b.h,
});

/** Floor hatching: a strip on the ground to the +x side of an object, 45° in plan. */
export const hatchStrip = (x0: number, x1: number, y0: number, y1: number, step: number) => {
  let d = '';
  const W = x1 - x0;
  for (let k = y0; k <= y1 + W; k += step) {
    const t0 = Math.max(0, k - y1);
    const t1 = Math.min(W, k - y0);
    if (t1 - t0 < 1) continue;
    d += `M${project(x0 + t0, k - t0, 0).join(' ')}L${project(x0 + t1, k - t1, 0).join(' ')}`;
  }
  return d;
};

/** A hand-drawn loop that doesn't quite close, for circling something. */
export const loop = (cx: number, cy: number, rx: number, ry: number) => {
  let d = '';
  for (let i = 0; i <= 44; i++) {
    const a = -0.6 + (i / 44) * (Math.PI * 2 + 0.9);
    const w = 1 + 0.07 * Math.sin(a * 3 + 1);
    const dx = (i / 44) * 4;
    d += `${i ? 'L' : 'M'}${round2(cx + dx + Math.cos(a) * rx * w)} ${round2(cy - dx * 0.5 + Math.sin(a) * ry * w)}`;
  }
  return d;
};

/** A hand-drawn arrow: one quadratic stroke from (x0, y0) bending through
 *  (qx, qy), with an open head at (x1, y1). */
export const arrow = (x0: number, y0: number, qx: number, qy: number, x1: number, y1: number) => {
  const ang = Math.atan2(y1 - qy, x1 - qx);
  const h = 10;
  const a1 = ang + Math.PI - 0.45;
  const a2 = ang + Math.PI + 0.45;
  return `M${x0} ${y0}Q${qx} ${qy} ${x1} ${y1}`
    + `M${round2(x1 + Math.cos(a1) * h)} ${round2(y1 + Math.sin(a1) * h)}L${x1} ${y1}L${round2(x1 + Math.cos(a2) * h)} ${round2(y1 + Math.sin(a2) * h)}`;
};

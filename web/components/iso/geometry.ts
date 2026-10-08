// The 30° isometric drawing kit, shared by the AXO skin and the broadsheet's
// figures. A world point (x, y, z) lands on screen at ((x − y)·cos30,
// (x + y)·sin30 − z): world x runs down-right, world y down-left, z straight
// up. Each box face is drawn flat inside a shear matrix so whatever sits on it
// can be laid out in plain 2D, and silhouettes are traced separately at a
// heavier pen. Pure data, no React.

export const C = 0.8660254;
export const S = 0.5;

export type Pt = [number, number];

/** Two decimals: enough for a crisp line, short enough to keep paths small. */
export const n = (v: number) => Math.round(v * 100) / 100;

/** Project a world point onto the screen. */
export const P = (x: number, y: number, z: number): Pt => [n((x - y) * C), n((x + y) * S - z)];

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

/** The three visible faces of a box at (x, y, z) sized w × d × h, as SVG
 *  transforms. Draw a w×d rect in T, w×h in L and d×h in R. */
export const box = (x: number, y: number, z: number, w: number, d: number, h: number): BoxFaces => ({
  T: mat(C, S, -C, S, P(x, y, z + h)),
  L: mat(C, S, 0, 1, P(x, y + d, z + h)),
  R: mat(C, -S, 0, 1, P(x + w, y + d, z + h)),
});

export const poly = (pts: Pt[]) => `M${pts.map(p => p.join(' ')).join('L')}Z`;

/** A box's outline as seen from the front: the heavier pen around its faces. */
export const sil = (x: number, y: number, z: number, w: number, d: number, h: number) =>
  poly([
    P(x, y, z + h), P(x + w, y, z + h), P(x + w, y, z),
    P(x + w, y + d, z), P(x, y + d, z), P(x, y + d, z + h),
  ]);

/** Floor hatching: a strip on the ground to the +x side of an object, 45° in plan. */
export const hatchStrip = (x0: number, x1: number, y0: number, y1: number, step: number) => {
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

/** A hand-drawn loop that doesn't quite close, for circling something. */
export const loop = (cx: number, cy: number, rx: number, ry: number) => {
  let d = '';
  for (let i = 0; i <= 44; i++) {
    const a = -0.6 + (i / 44) * (Math.PI * 2 + 0.9);
    const w = 1 + 0.07 * Math.sin(a * 3 + 1);
    const dx = (i / 44) * 4;
    d += `${i ? 'L' : 'M'}${n(cx + dx + Math.cos(a) * rx * w)} ${n(cy - dx * 0.5 + Math.sin(a) * ry * w)}`;
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
    + `M${n(x1 + Math.cos(a1) * h)} ${n(y1 + Math.sin(a1) * h)}L${x1} ${y1}L${n(x1 + Math.cos(a2) * h)} ${n(y1 + Math.sin(a2) * h)}`;
};

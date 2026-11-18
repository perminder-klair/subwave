// Platter's focus mode draws the deck at 30° isometric on the shared kit
// (components/iso/geometry.ts): a plinth on four feet with the platter and
// tonearm on its top, and behind it the sleeve of the record playing with the
// one cued next leaning in the crate behind that. World units throughout; the
// scene paints what this decides. Pure data, no React.

import { drawBlock, poly, project, round2, type Block, type Pt } from '@/components/iso/geometry';

/** The plinth: wider than deep, standing on feet FOOT tall. */
const FOOT = 6;
const PLINTH_BLOCK: Block = { x: 0, y: 0, z: FOOT, w: 300, d: 250, h: 40 };
/** Height of the plinth's top face off the floor. */
export const TOP_Z = PLINTH_BLOCK.z + PLINTH_BLOCK.h;

/** The platter on the plinth's top face (that face's local x runs along world
 *  x, local y along world y), `t` proud of it; the record lies on it. */
export const PLATTER = { cx: 122, cy: 126, r: 100, t: 7 } as const;
export const RECORD = { r: 94, t: 1.5 } as const;
/** How far the record's surface stands off the plinth. */
export const RECORD_LIFT = PLATTER.t + RECORD.t;

/** The tonearm: its pivot on the plinth's top face, how high the arm rides
 *  over it, and its length to the stylus. */
export const ARM = { px: 262, py: 50, lift: 14, len: 152 } as const;

/** The grooves the stylus tracks across, outer to inner. */
const GROOVE_OUT = 90;
const GROOVE_IN = 44;
/** Parked on its rest, clear of the record. */
const ARM_REST = 98;
/** The post the parked arm lies on, most of the way along it. */
export const REST_POST = {
  x: round2(ARM.px + Math.cos((ARM_REST * Math.PI) / 180) * ARM.len * 0.7),
  y: round2(ARM.py + Math.sin((ARM_REST * Math.PI) / 180) * ARM.len * 0.7),
} as const;

/** Progress ticks round the platter, printed on the plinth's top face: far
 *  enough out that the raised platter, whose cap sits back toward the viewer's
 *  top, doesn't cover the ring's start. */
export const RING = { r0: 111, r1: 116, count: 60 } as const;

/** The playing record's sleeve, propped upright behind the plinth with its
 *  cover facing the viewer's left, and the next one's further back in the
 *  crate, offset right so it shows past the first. Both stand on the floor. */
const SLEEVE_BLOCK: Block = { x: 14, y: -40, z: 0, w: 176, d: 3, h: 176 };
const NEXT_SLEEVE_BLOCK: Block = { x: 168, y: -84, z: 0, w: 138, d: 3, h: 138 };

/** Feet at the plinth's corners; only the three nearest the viewer show. */
const feet = [
  { x: 10, y: 214 },
  { x: 264, y: 214 },
  { x: 264, y: 10 },
].map(({ x, y }) => drawBlock({ x, y, z: 0, w: 26, d: 26, h: FOOT }));

export const DECK = {
  plinth: drawBlock(PLINTH_BLOCK),
  plinthBox: PLINTH_BLOCK,
  feet,
  sleeve: drawBlock(SLEEVE_BLOCK),
  sleeveBox: SLEEVE_BLOCK,
  nextSleeve: drawBlock(NEXT_SLEEVE_BLOCK),
  nextSleeveBox: NEXT_SLEEVE_BLOCK,
  /** The plinth's contact shadow on the floor, spilling to its front and right. */
  shadow: poly([
    project(-4, 6, 0), project(312, 6, 0), project(312, 264, 0), project(-4, 264, 0),
  ]),
} as const;

/** Every world point the scene draws, for the frame round it. */
function extremes(): Pt[] {
  const corners = (b: Block): Pt[] => [0, b.w].flatMap(dx => [0, b.d].flatMap(dy => [0, b.h].map(
    dz => project(b.x + dx, b.y + dy, b.z + dz),
  )));
  return [...corners({ ...PLINTH_BLOCK, z: 0, h: TOP_Z + ARM.lift + 10 }), ...corners(SLEEVE_BLOCK), ...corners(NEXT_SLEEVE_BLOCK)];
}

/** The scene's frame: the drawing plus a margin, as an SVG viewBox. */
export const VIEWBOX = (() => {
  const pts = extremes();
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const m = 18;
  const x0 = Math.min(...xs) - m, y0 = Math.min(...ys) - m;
  return {
    x0: round2(x0), y0: round2(y0),
    w: round2(Math.max(...xs) + m - x0), h: round2(Math.max(...ys) + m - y0),
    toString() { return `${this.x0} ${this.y0} ${this.w} ${this.h}`; },
  };
})();

const DEG = Math.PI / 180;
const ARM_TO_CENTRE = Math.hypot(PLATTER.cx - ARM.px, PLATTER.cy - ARM.py);
const ARM_HEADING = Math.atan2(PLATTER.cy - ARM.py, PLATTER.cx - ARM.px);

/** The arm's angle (degrees, about its pivot, from the face's +x) that puts
 *  the stylus `r` from the record's centre: the law of cosines over the
 *  pivot–centre line, swung to the side that brings the arm down the record's
 *  right, the way a tonearm sits. */
export function armAngleAt(r: number): number {
  const L = ARM.len, d = ARM_TO_CENTRE;
  const cos = Math.min(1, Math.max(-1, (L * L + d * d - r * r) / (2 * L * d)));
  return round2((ARM_HEADING - Math.acos(cos)) / DEG);
}

export type ArmPose = 'rest' | 'cue' | 'play';

/** Where the tonearm sits: parked, cueing over the lead-in, or tracking the
 *  grooves inward as the song plays. */
export function armAngle(phase: ArmPose, ratio: number | null): number {
  if (phase === 'rest') return ARM_REST;
  if (phase === 'cue') return armAngleAt(GROOVE_OUT + 3);
  return armAngleAt(GROOVE_OUT - (ratio ?? 0) * (GROOVE_OUT - GROOVE_IN));
}

/** The most the arm steps in one move without swinging. A whole song tracks
 *  under 20°, so a song of ten seconds or more creeps less than this each
 *  second, and a jump back to the lead-in is far more. */
export const ARM_STEP_MAX = 2;

/** Whether the arm eases to a new angle or steps to it. It swings for a
 *  change of pose and for a jump, such as a new song's lead-in; the creep
 *  across a playing record steps, since an ease restarted every second never
 *  comes to rest. */
export function armSwings(
  from: { pose: ArmPose; angle: number },
  to: { pose: ArmPose; angle: number },
): boolean {
  return from.pose !== to.pose || Math.abs(to.angle - from.angle) > ARM_STEP_MAX;
}

/** The stylus's position for an arm angle, on the face's plane. */
export function stylusAt(angleDeg: number): Pt {
  return [ARM.px + Math.cos(angleDeg * DEG) * ARM.len, ARM.py + Math.sin(angleDeg * DEG) * ARM.len];
}

/** The progress ring as two paths, lit and unlit. It starts at the platter's
 *  far side, the top of the ellipse as the viewer sees it, and runs clockwise. */
export function ringTicks(ratio: number | null): { lit: string; unlit: string } {
  const lit = ratio == null ? 0 : Math.round(Math.min(1, Math.max(0, ratio)) * RING.count);
  let on = '', off = '';
  for (let i = 0; i < RING.count; i++) {
    const a = (-135 + (i * 360) / RING.count) * DEG;
    const c = Math.cos(a), s = Math.sin(a);
    const seg = `M${round2(PLATTER.cx + c * RING.r0)} ${round2(PLATTER.cy + s * RING.r0)}`
      + `L${round2(PLATTER.cx + c * RING.r1)} ${round2(PLATTER.cy + s * RING.r1)}`;
    if (i < lit) on += seg; else off += seg;
  }
  return { lit: on, unlit: off };
}

/** Cut a line to `max` characters, ending it with an ellipsis if it ran over. */
export function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

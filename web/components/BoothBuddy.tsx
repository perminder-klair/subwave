'use client';

import { memo, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { COS30, boxFaces, poly, project, silhouette, type Block, type Pt } from './iso/geometry';
import styles from './BoothBuddy.module.css';

// DJ Doc: the booth's mascot, a little speaker box with a screen for a face and
// a record spinning on its head. Drawn in the isometric kit's own 30° projection
// (components/iso/geometry.ts), so it stands in the same space as the AXO skin
// and the admin figures: the face is laid out flat on the box's front-left
// plane and the shear does the rest. Colour comes from the theme (the casing is
// --accent, the lights --accent-2), so it follows every palette.
//
// One SVG from the 16px top-bar badge up to the doctor page. A mood is a look,
// not a separate drawing: eyes, mouth, brows, an extra and a move, picked from
// LOOKS. The resting frame is the finished still: every move layers on only
// under prefers-reduced-motion: no-preference, and lite mode kills it.

export type BuddyMood =
  | 'content'
  | 'happy'
  | 'onair'
  | 'listening'
  | 'thinking'
  | 'curious'
  | 'worried'
  | 'spooked'
  | 'sleepy'
  | 'dizzy';

export const BUDDY_MOODS: readonly BuddyMood[] = [
  'content',
  'happy',
  'onair',
  'listening',
  'thinking',
  'curious',
  'worried',
  'spooked',
  'sleepy',
  'dizzy',
];

type Eyes = 'dot' | 'happy' | 'closed' | 'wide' | 'up' | 'scan' | 'quizzical' | 'swirl';
type Mouth = 'smile' | 'grin' | 'talk' | 'o' | 'gasp' | 'wavy' | 'small' | 'flat';
type Extra = 'zz' | 'sweat' | 'dots' | 'sparkle' | 'question' | 'waves' | 'stars';
type Move = 'breathe' | 'hop' | 'shake' | 'nod' | 'wobble' | 'doze';
type Bulb = 'steady' | 'pulse' | 'blink' | 'alarm' | 'dim';

interface Look {
  eyes: Eyes;
  mouth: Mouth;
  brows?: 'worried' | 'raised';
  cheeks?: boolean;
  extra?: Extra;
  headphones?: boolean;
  /** The record on its head turns. */
  spin?: boolean;
  bulb: Bulb;
  move: Move;
  /** Degrees, about the feet. */
  tilt: number;
}

const LOOKS: Record<BuddyMood, Look> = {
  content: { eyes: 'dot', mouth: 'smile', cheeks: true, bulb: 'steady', move: 'breathe', tilt: 0 },
  happy: { eyes: 'happy', mouth: 'grin', cheeks: true, extra: 'sparkle', spin: true, bulb: 'pulse', move: 'hop', tilt: 0 },
  onair: { eyes: 'dot', mouth: 'talk', extra: 'waves', spin: true, bulb: 'pulse', move: 'breathe', tilt: 0 },
  listening: { eyes: 'scan', mouth: 'small', headphones: true, spin: true, bulb: 'pulse', move: 'nod', tilt: 0 },
  thinking: { eyes: 'up', mouth: 'flat', extra: 'dots', bulb: 'blink', move: 'breathe', tilt: -4 },
  curious: { eyes: 'quizzical', mouth: 'o', brows: 'raised', extra: 'question', bulb: 'steady', move: 'breathe', tilt: -8 },
  worried: { eyes: 'dot', mouth: 'wavy', brows: 'worried', extra: 'sweat', bulb: 'blink', move: 'breathe', tilt: 0 },
  spooked: { eyes: 'wide', mouth: 'gasp', extra: 'sweat', bulb: 'alarm', move: 'shake', tilt: 0 },
  sleepy: { eyes: 'closed', mouth: 'small', extra: 'zz', bulb: 'dim', move: 'doze', tilt: 6 },
  dizzy: { eyes: 'swirl', mouth: 'wavy', extra: 'stars', bulb: 'dim', move: 'wobble', tilt: 0 },
};

// World units. The head is a box W along world x (the face side), D deep and H
// tall, standing on legs LEG high.
const W = 56;
const D = 30;
const H = 46;
const LEG = 10;
const TOP = LEG + H;
const HEAD: Block = { x: 0, y: 0, z: LEG, w: W, d: D, h: H };
const HEAD_FACES = boxFaces(HEAD);
/** The head's on-screen width, which `size` maps to px. */
const SPAN = (W + D) * COS30;

const LEGS: Block[] = [
  { x: 10, y: D - 9, z: 0, w: 8, d: 8, h: LEG },
  { x: W - 18, y: D - 9, z: 0, w: 8, d: 8, h: LEG },
];

// The face, in the front-left plane's own units (u across, v down).
const EYE_Y = 16.5;
const EYE_X = [W / 2 - 9.5, W / 2 + 9.5] as const;
const MOUTH = { x: W / 2, y: 27.5 };

/** The antenna stands at the top's back-right corner; the record sits in front. */
const ANTENNA = { x: W - 9, y: 8 };
const RECORD = { u: 23, v: 16, r: 11 };
/** The plane the headphone band arcs in. */
const BAND_Y = D * 0.55;

const VIEW = { x: -34, y: -66, w: 90, h: 114 };
const TILT_ORIGIN = project(W / 2, D, 0);

const pts = (list: Pt[]) => list.map(p => p.join(' ')).join(' ');

function Block3({ b, top = styles.top, left = styles.body, right = styles.side }: { b: Block; top?: string; left?: string; right?: string }) {
  const f = boxFaces(b);
  return (
    <>
      <rect transform={f.T} width={b.w} height={b.d} className={top} />
      <rect transform={f.L} width={b.w} height={b.h} className={left} />
      <rect transform={f.R} width={b.d} height={b.h} className={right} />
      <path d={silhouette(b)} strokeWidth={1.2} className={styles.edge} />
    </>
  );
}

/** An Archimedean spiral for the dizzy eyes, as a polyline. */
function spiral(cx: number, cy: number): string {
  const out: Pt[] = [];
  for (let i = 0; i <= 28; i++) {
    const a = (i / 28) * Math.PI * 4.5;
    const r = 0.4 + (a / (Math.PI * 4.5)) * 4.2;
    out.push([Math.round((cx + Math.cos(a) * r) * 100) / 100, Math.round((cy + Math.sin(a) * r) * 100) / 100]);
  }
  return pts(out);
}

/** A four-point sparkle. */
const star = (x: number, y: number, s: number) =>
  `M${x} ${y - s}Q${x} ${y} ${x + s} ${y}Q${x} ${y} ${x} ${y + s}Q${x} ${y} ${x - s} ${y}Q${x} ${y} ${x} ${y - s}Z`;

function Eye({ kind, cx, side }: { kind: Eyes; cx: number; side: 0 | 1 }) {
  const y = EYE_Y;
  switch (kind) {
    case 'happy':
      return <path d={`M${cx - 4.5} ${y + 2.5}Q${cx} ${y - 4.5} ${cx + 4.5} ${y + 2.5}`} strokeWidth={2.8} className={styles.line} />;
    case 'closed':
      return <path d={`M${cx - 4.5} ${y}Q${cx} ${y + 3.5} ${cx + 4.5} ${y}`} strokeWidth={2.4} className={styles.line} />;
    case 'wide':
      return (
        <>
          <rect x={cx - 5.5} y={y - 6} width="11" height="12" rx="2.5" className={styles.glow} />
          <rect x={cx - 2} y={y - 1.5} width="4" height="4.5" rx="1" className={styles.screen} />
        </>
      );
    case 'swirl':
      return <polyline points={spiral(cx, y)} strokeWidth={1.4} className={styles.line} />;
    case 'quizzical':
      return side === 1 ? (
        <rect x={cx - 4.5} y={y - 6} width="9" height="11" rx="2.2" className={styles.glow} />
      ) : (
        <rect x={cx - 3.5} y={y - 3.5} width="7" height="8" rx="2" className={styles.glow} />
      );
    case 'up':
      return <rect x={cx - 2} y={y - 7} width="7" height="9" rx="2" className={styles.glow} />;
    default:
      return <rect x={cx - 3.5} y={y - 4.5} width="7" height="9" rx="2" className={styles.glow} />;
  }
}

function Mouth({ kind }: { kind: Mouth }) {
  const { x, y } = MOUTH;
  switch (kind) {
    case 'grin':
      return <path d={`M${x - 8} ${y - 2.5}H${x + 8}Q${x + 7.5} ${y + 6.5} ${x} ${y + 6.5}Q${x - 7.5} ${y + 6.5} ${x - 8} ${y - 2.5}Z`} className={styles.glow} />;
    case 'talk':
      return <rect x={x - 5.5} y={y - 3.5} width="11" height="7.5" rx="3" className={cn(styles.glow, styles.talk)} />;
    case 'o':
      return <ellipse cx={x} cy={y} rx="3" ry="3.5" className={styles.glow} />;
    case 'gasp':
      return <ellipse cx={x} cy={y + 0.5} rx="4" ry="5" className={styles.glow} />;
    case 'wavy':
      return <path d={`M${x - 7} ${y}Q${x - 3.5} ${y - 3} ${x} ${y}Q${x + 3.5} ${y + 3} ${x + 7} ${y}`} strokeWidth={2.2} className={styles.line} />;
    case 'small':
      return <ellipse cx={x} cy={y} rx="2.3" ry="1.6" className={styles.glow} />;
    case 'flat':
      return <path d={`M${x - 4.5} ${y}H${x + 4.5}`} strokeWidth={2.4} className={styles.line} />;
    default:
      return <path d={`M${x - 6.5} ${y - 1.5}Q${x} ${y + 4.5} ${x + 6.5} ${y - 1.5}`} strokeWidth={2.6} className={styles.line} />;
  }
}

function Brows({ kind }: { kind: 'worried' | 'raised' }) {
  const [l, r] = EYE_X;
  const y = EYE_Y - 7;
  if (kind === 'raised') {
    return <path d={`M${r - 4.5} ${y - 1}Q${r} ${y - 4.5} ${r + 4.5} ${y - 1}`} strokeWidth={1.8} className={styles.line} />;
  }
  return (
    <path
      d={`M${l - 4} ${y + 2}L${l + 3.5} ${y - 2.5}M${r - 3.5} ${y - 2.5}L${r + 4} ${y + 2}`}
      strokeWidth={2}
      className={styles.line}
    />
  );
}

/** The face: a screen inset in the front-left plane, lit by the mood. */
function Face({ look }: { look: Look }) {
  const blinks = look.eyes === 'dot' || look.eyes === 'up' || look.eyes === 'quizzical';
  return (
    <g transform={HEAD_FACES.L}>
      <rect x="5" y="5" width={W - 10} height={H - 14} rx="4.5" className={styles.screen} />
      <path d={`M9 8H22L13 19H9Z`} className={styles.gloss} />
      {look.cheeks && (
        <>
          <ellipse cx="11.5" cy="25" rx="3.6" ry="2" className={styles.cheek} />
          <ellipse cx={W - 11.5} cy="25" rx="3.6" ry="2" className={styles.cheek} />
        </>
      )}
      <g className={cn(blinks && styles.blink, look.eyes === 'scan' && styles.scan)}>
        {EYE_X.map((cx, i) => (
          <Eye key={i} kind={look.eyes} cx={cx} side={i as 0 | 1} />
        ))}
      </g>
      {look.brows && <Brows kind={look.brows} />}
      <Mouth kind={look.mouth} />
      {/* The chin: a level meter, three bars lit at rest. */}
      {[0, 1, 2, 3, 4].map(i => (
        <rect
          key={i}
          x={W / 2 - 11 + i * 4.6}
          y={H - 6.5}
          width="3.4"
          height="2.6"
          rx="0.6"
          className={cn(i < 3 ? styles.meterOn : styles.meterOff, look.spin && styles[`meter${i}`])}
        />
      ))}
    </g>
  );
}

/** The record on its head, in the top plane, so it turns in perspective. */
function Record({ spin }: { spin: boolean }) {
  const { u, v, r } = RECORD;
  return (
    <g transform={HEAD_FACES.T}>
      <circle cx={u} cy={v} r={r} className={styles.vinyl} />
      <g className={cn(spin && styles.spin)}>
        <circle cx={u} cy={v} r={r * 0.68} strokeWidth={0.7} className={styles.groove} />
        <circle cx={u} cy={v} r={3.6} className={styles.label} />
        <circle cx={u + 1.9} cy={v - 1.2} r={0.9} className={styles.vinyl} />
      </g>
    </g>
  );
}

/** The speaker grille down the right-hand side. */
function Grille() {
  return (
    <g transform={HEAD_FACES.R}>
      {[12, 18, 24, 30].map(v => (
        <rect key={v} x="7" y={v} width={D - 14} height="2.4" rx="1.2" className={styles.slot} />
      ))}
    </g>
  );
}

function Antenna({ bulb }: { bulb: Bulb }) {
  const [bx, by] = project(ANTENNA.x, ANTENNA.y, TOP);
  const tipY = by - 13;
  return (
    <>
      <path d={`M${bx} ${by}V${tipY}`} strokeWidth={2.2} className={styles.stalk} />
      {(bulb === 'pulse' || bulb === 'alarm') && (
        <circle cx={bx} cy={tipY - 3} r="4.2" className={cn(bulb === 'alarm' ? styles.alarmBulb : styles.bulb, styles.halo)} />
      )}
      <circle
        cx={bx}
        cy={tipY - 3}
        r="4.2"
        strokeWidth={1}
        className={cn(
          bulb === 'alarm' ? styles.alarmBulb : bulb === 'dim' ? styles.dimBulb : styles.bulb,
          styles.edge,
          bulb === 'blink' && styles.flash,
          bulb === 'alarm' && styles.alarm,
        )}
      />
      <circle cx={bx - 1.4} cy={tipY - 4.4} r="1.2" className={styles.shine} />
    </>
  );
}

/** Headphones: a band arcing over the top, one cup on the visible side. */
function Headphones() {
  const arc: Pt[] = [];
  for (let i = 0; i <= 12; i++) {
    const x = (i / 12) * (W + 2);
    arc.push(project(x, BAND_Y, TOP + 2 + 8 * Math.sin((Math.PI * x) / (W + 2))));
  }
  arc.push(project(W + 2, BAND_Y, TOP - 13));
  const cup: Block = { x: W, y: BAND_Y - 8, z: TOP - 32, w: 4, d: 16, h: 19 };
  return (
    <>
      <polyline points={pts(arc)} strokeWidth={3.6} className={styles.band} />
      <Block3 b={cup} top={styles.metal} left={styles.metalDark} right={styles.metal} />
      <rect transform={boxFaces(cup).R} x="3" y="3" width={cup.d - 6} height={cup.h - 6} rx="2.5" className={styles.bulb} />
    </>
  );
}

function ExtraArt({ kind }: { kind: Extra }) {
  switch (kind) {
    case 'zz':
      return (
        <>
          <text x="44" y="-44" fontSize={12} fontWeight={800} className={cn(styles.zz, styles.z1)}>z</text>
          <text x="51" y="-53" fontSize={15} fontWeight={800} className={cn(styles.zz, styles.z2)}>z</text>
        </>
      );
    case 'sweat':
      return (
        <path
          d="M-27 -42C-29.5 -38 -31 -35.5 -31 -33.5A4 4 0 0 0 -23 -33.5C-23 -35.5 -24.5 -38 -27 -42Z"
          strokeWidth={0.9}
          className={cn(styles.drop, styles.drip)}
        />
      );
    case 'dots':
      return (
        <>
          <circle cx="40" cy="-49" r="2.2" className={cn(styles.spark, styles.dot1)} />
          <circle cx="46.5" cy="-55.5" r="2.8" className={cn(styles.spark, styles.dot2)} />
          <circle cx="53.5" cy="-62.5" r="3.4" className={cn(styles.spark, styles.dot3)} />
        </>
      );
    case 'sparkle':
      return (
        <>
          <path d={star(-27, -50, 5.5)} className={cn(styles.spark, styles.twinkle)} />
          <path d={star(48, -46, 4.2)} className={cn(styles.spark, styles.twinkle2)} />
        </>
      );
    case 'question':
      return (
        <text x="41" y="-45" fontSize={18} fontWeight={800} className={cn(styles.spark, styles.bob)}>?</text>
      );
    case 'waves':
      return (
        <>
          <path d="M-30 -21Q-34.5 -14 -30 -7" strokeWidth={2} className={cn(styles.wave, styles.wave1)} />
          <path d="M-34 -26Q-41 -14 -34 -2" strokeWidth={2} className={cn(styles.wave, styles.wave2)} />
        </>
      );
    case 'stars': {
      const [cx, cy] = project(W / 2, D / 2, TOP + 12);
      return (
        <g className={styles.orbit}>
          <ellipse cx={cx} cy={cy} rx="22" ry="6.5" strokeWidth={0.9} className={styles.ring} />
          <path d={star(cx - 20, cy + 1, 3.6)} className={styles.spark} />
          <path d={star(cx + 13, cy - 5, 3)} className={styles.spark} />
          <path d={star(cx + 9, cy + 6, 2.6)} className={styles.spark} />
        </g>
      );
    }
  }
}

export interface BoothBuddyProps {
  mood?: BuddyMood;
  /** The head's on-screen width in px; the whole sprite scales from it. */
  size?: number;
  className?: string;
}

export default memo(function BoothBuddy({ mood = 'content', size = 20, className }: BoothBuddyProps) {
  const look = LOOKS[mood] ?? LOOKS.content;
  const s = size / SPAN;
  const footprint = poly([
    project(-2, -2, 0),
    project(W + 2, -2, 0),
    project(W + 2, D + 2, 0),
    project(-2, D + 2, 0),
  ]);
  const extras: ReactNode = look.extra ? <ExtraArt kind={look.extra} /> : null;

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`}
      width={Number((VIEW.w * s).toFixed(2))}
      height={Number((VIEW.h * s).toFixed(2))}
      className={cn('v3-buddy', styles.root, className)}
      data-mood={mood}
    >
      <path d={footprint} className={styles.shadow} />
      <g className={styles[look.move]}>
        <g transform={look.tilt ? `rotate(${look.tilt} ${TILT_ORIGIN[0]} ${TILT_ORIGIN[1]})` : undefined}>
          {LEGS.map((b, i) => (
            <Block3 key={i} b={b} top={styles.metal} left={styles.metal} right={styles.metalDark} />
          ))}

          {/* The head: three shaded faces, then its outline. */}
          <rect transform={HEAD_FACES.T} width={W} height={D} className={styles.top} />
          <rect transform={HEAD_FACES.L} width={W} height={H} className={styles.body} />
          <rect transform={HEAD_FACES.R} width={D} height={H} className={styles.side} />
          <Record spin={!!look.spin} />
          <Grille />
          <Face look={look} />
          <path d={silhouette(HEAD)} strokeWidth={2} className={styles.edge} />
          <path
            d={`M${pts([project(0, D, TOP)])}L${pts([project(W, D, TOP)])}L${pts([project(W, 0, TOP)])}M${pts([project(W, D, TOP)])}L${pts([project(W, D, LEG)])}`}
            strokeWidth={1.1}
            className={styles.crease}
          />

          <Antenna bulb={look.bulb} />
          {look.headphones && <Headphones />}
          {extras}
        </g>
      </g>
    </svg>
  );
});

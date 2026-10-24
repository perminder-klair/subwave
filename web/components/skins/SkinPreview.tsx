'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { AXO, type DrawnBlock, type RackLevel } from './axo/geometry';
import { ROWS as CIPHER_ROWS } from './cipher/cipher';
import { ARM, DECK, PLATTER, RECORD, RECORD_LIFT, VIEWBOX as PLATTER_VIEWBOX, armAngle, ringTicks, stylusAt } from './platter/iso';

// A pure-CSS miniature of each skin's real layout, shared by the admin's station
// skin gallery and the listener's Appearance menu. The host card must be a
// Tailwind `group` that carries `aria-pressed`: the motion idles unless that card
// is the live pick or under the cursor, gated through play-state variants.
// Keyframes live in app/globals.css (skin-*).


// Shared play-state gate: paused by default, runs on hover or when this card is
// the active (aria-pressed) pick, and stands down under reduced motion.
const GATE =
  '[animation-play-state:paused] group-hover:[animation-play-state:running] group-aria-pressed:[animation-play-state:running] motion-reduce:animate-none';
const EQ = `origin-bottom animate-[skin-eq_900ms_ease-in-out_infinite] ${GATE}`;
const REEL = `animate-[skin-reel_3.2s_linear_infinite] ${GATE}`;
const BLINK = `animate-[skin-blink_1.05s_steps(1)_infinite] ${GATE}`;
const SCAN = `animate-[skin-scan_2.6s_linear_infinite] ${GATE}`;

// Literal delay classes (Tailwind scans source text, so these must be spelled
// out rather than built from an index) staggering the equaliser bars.
const EQ_BARS = [
  { h: 'h-2', d: '[animation-delay:0ms]' },
  { h: 'h-4', d: '[animation-delay:120ms]' },
  { h: 'h-3', d: '[animation-delay:60ms]' },
  { h: 'h-5', d: '[animation-delay:200ms]' },
  { h: 'h-3', d: '[animation-delay:90ms]' },
  { h: 'h-4', d: '[animation-delay:160ms]' },
  { h: 'h-2', d: '[animation-delay:240ms]' },
] as const;

function EqRow({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-end justify-center gap-[2px]', className)}>
      {EQ_BARS.map((b, i) => (
        <span key={i} className={cn('w-[2px] bg-ink', b.h, EQ, b.d)} />
      ))}
    </div>
  );
}

function ClassicPreview() {
  return (
    <div className="flex h-full w-full flex-col gap-1.5 p-2.5">
      <div className="flex items-center justify-between border-b border-ink pb-1">
        <span className="h-[3px] w-1/3 bg-ink" />
        <span className="size-[4px] bg-vermilion" />
      </div>
      <div className="flex flex-1 items-center justify-center">
        <span className="grid aspect-square h-[74%] place-items-center rounded-full border-2 border-ink">
          <span className="size-1/3 rounded-full bg-vermilion" />
        </span>
      </div>
      <EqRow className="h-5" />
      <div className="flex justify-center gap-1.5">
        <span className="size-1.5 bg-ink" />
        <span className="h-1.5 w-3 bg-vermilion" />
        <span className="size-1.5 bg-ink" />
      </div>
    </div>
  );
}

function UnitPreview() {
  return (
    <div className="flex h-full w-full flex-col gap-1.5 bg-field p-2.5">
      <div className="flex items-center justify-between">
        <span className="h-[3px] w-1/4 bg-ink" />
        <span className="flex items-center gap-1">
          <span className="size-[4px] rounded-full bg-vermilion" />
          <span className="size-[4px] rounded-full border border-ink" />
        </span>
      </div>
      <div className="flex flex-1 gap-1.5">
        <div className="flex w-2/5 flex-col gap-1">
          <div className="grid flex-1 grid-cols-2 gap-1">
            <span className="rounded-[2px] bg-ink" />
            <span className="rounded-[2px] bg-vermilion" />
            <span className="rounded-[2px] bg-ink" />
            <span className="rounded-[2px] bg-ink" />
          </div>
          <div className="flex items-center justify-around py-0.5">
            <span className="grid size-4 place-items-center rounded-full bg-ink">
              <span className="h-[2px] w-2 -rotate-45 bg-vermilion" />
            </span>
            <span className="grid size-4 place-items-center rounded-full bg-ink">
              <span className="h-[2px] w-2 rotate-12 bg-bg/70" />
            </span>
          </div>
        </div>
        <div className="flex flex-1 flex-col gap-1 bg-ink p-1.5">
          <span className="h-[5px] w-3/4 bg-bg/90" />
          <span className="h-[3px] w-1/2 bg-bg/60" />
          <span className="h-[2px] w-2/5 bg-vermilion" />
          <div className="mt-auto flex items-end justify-start gap-[2px]">
            {EQ_BARS.map((b, i) => (
              <span key={i} className={cn('w-[2px] bg-bg/80', b.h, EQ, b.d)} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function DriftPreview() {
  return (
    <div className="relative h-full w-full overflow-hidden bg-linear-to-b from-muted to-ink">
      <span className={cn('absolute inset-x-0 top-0 h-1/3 bg-bg/20', SCAN)} />
      <span className="absolute top-2 right-2 size-2 rounded-full bg-vermilion" />
      <div className="absolute bottom-2.5 left-2.5 grid gap-1">
        <span className="h-[4px] w-10 bg-bg" />
        <span className="h-[3px] w-6 bg-bg/70" />
      </div>
    </div>
  );
}

function SubampPreview() {
  return (
    <div className="flex h-full w-full flex-col gap-1 bg-[color-mix(in_oklab,var(--bg)_88%,var(--ink))] p-2.5">
      <div className="flex items-center gap-1 border border-ink bg-linear-to-r from-accent-soft to-field px-1 py-[3px]">
        <span className="size-[3px] bg-vermilion" />
        <span className="h-px flex-1 bg-ink/40" />
        <span className="h-[3px] w-1 bg-ink/40" />
      </div>
      <div className="flex items-center gap-1.5 border border-ink bg-bg px-1.5 py-1">
        <span className="font-mono text-[7px] leading-none font-bold text-vermilion">128</span>
        <EqRow className="h-4 flex-1 justify-end" />
      </div>
      <div className="flex items-center gap-1.5 border border-ink bg-bg px-1.5 py-1">
        <span className="size-2 rounded-full border border-ink" />
        <span className="h-px flex-1 bg-muted" />
      </div>
      <div className="grid flex-1 content-start gap-[3px] border border-ink bg-bg p-1.5">
        <span className="h-[3px] w-full bg-ink" />
        <span className="h-[3px] w-4/5 bg-muted" />
        <span className="h-[3px] w-3/5 bg-muted" />
      </div>
    </div>
  );
}

// TTY's panes: the status line, a now-playing pane with its scope's bars
// along the bottom, the booth tail beside it, and the htop key bar.
const TTY_BARS = ['h-2/3', 'h-full', 'h-3/4', 'h-full', 'h-1/2', 'h-2/3', 'h-1/3', 'h-1/2', 'h-1/4', 'h-1/3', 'h-1/4', 'h-1/6'];

function TtyPreview() {
  return (
    <div className="m-2.5 flex h-[calc(100%-1.25rem)] flex-col gap-1 bg-field">
      <div className="flex items-center gap-1 border border-ink px-1.5 py-1">
        <span className="size-1.5 rounded-full bg-vermilion" />
        <span className="h-[3px] w-6 bg-ink" />
        <span className="ml-auto h-px w-6 bg-muted" />
      </div>
      <div className="flex flex-1 gap-1">
        <div className="flex flex-1 flex-col gap-[3px] border border-line p-1.5">
          <span className="h-[4px] w-2/3 bg-ink" />
          <span className="h-[3px] w-1/2 bg-muted" />
          <span className="mt-auto flex h-3 items-end gap-px border border-line px-px pt-px">
            {TTY_BARS.map((h, i) => (
              <span key={i} className={cn('flex-1', h, i < 4 ? 'bg-vermilion' : 'bg-ink')} />
            ))}
          </span>
        </div>
        <div className="grid w-1/3 content-start gap-[3px] border border-line p-1.5">
          <span className="h-[3px] w-full bg-muted" />
          <span className="h-[3px] w-2/3 bg-muted" />
          <span className="flex items-center gap-1">
            <span className="h-[3px] w-1/2 bg-muted" />
            <span className={cn('h-2 w-[3px] bg-vermilion', BLINK)} />
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1">
        {[0, 1, 2, 3].map(i => (
          <span key={i} className="flex items-center gap-px">
            <span className="h-[4px] w-[3px] bg-ink" />
            <span className="h-[5px] w-2 bg-vermilion" />
          </span>
        ))}
        <span className="ml-auto h-px w-6 bg-muted" />
      </div>
    </div>
  );
}

// Platter's deck at 30° isometric — the turntable as its focus mode draws it,
// from the skin's own geometry (platter/iso.ts) so the card can't drift from
// the player — with the record's sleeve propped behind it, beside a slab card
// for the column of facts. The record turns under the shared play-state gate.
const PL_TOP = 'fill-bg';
const PL_LEFT = 'fill-[color-mix(in_oklab,var(--ink)_6%,var(--bg))]';
const PL_RIGHT = 'fill-[color-mix(in_oklab,var(--ink)_13%,var(--bg))]';
const PL_MAT = 'fill-[color-mix(in_oklab,var(--ink)_72%,var(--bg))]';
const PL_RING = ringTicks(0.62).lit;
const PL_STYLUS = stylusAt(armAngle('play', 0.4));

function PlatterPreview() {
  const { plinth, plinthBox: p, sleeve, sleeveBox: s } = DECK;
  const rx = PLATTER.cx - RECORD_LIFT, ry = PLATTER.cy - RECORD_LIFT;
  return (
    <div className="flex h-full w-full items-stretch bg-field">
      <div className="relative flex-1 bg-[radial-gradient(circle,var(--soft-border)_1px,transparent_1.5px)] bg-size-[9px_5.2px]">
        <svg
          viewBox={String(PLATTER_VIEWBOX)}
          className="absolute inset-0 size-full fill-none stroke-ink [&_*]:[vector-effect:non-scaling-stroke]"
          strokeWidth={0.7}
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <g transform={sleeve.L}>
            <rect width={s.w} height={s.h} className="fill-surface" />
            <rect x="18" y="18" width={s.w - 36} height={s.h - 70} className="fill-vermilion stroke-none" />
            <rect x="18" y={s.h - 40} width={s.w * 0.55} height="9" className="fill-ink stroke-none" />
          </g>
          <path d={sleeve.sil} strokeWidth={1.2} />
          <rect transform={plinth.L} width={p.w} height={p.h} className={PL_LEFT} />
          <rect transform={plinth.R} width={p.d} height={p.h} className={PL_RIGHT} />
          <rect transform={plinth.T} width={p.w} height={p.d} className={PL_TOP} />
          <g transform={plinth.T}>
            <path d={PL_RING} strokeWidth={1.4} className="stroke-vermilion" />
            <circle cx={PLATTER.cx} cy={PLATTER.cy} r={PLATTER.r} className={PL_MAT} />
            <g className={cn('origin-center [transform-box:fill-box]', REEL)}>
              <circle cx={rx} cy={ry} r={RECORD.r} className="fill-[#0c0a09]" />
              <circle cx={rx} cy={ry} r="34" className="fill-vermilion stroke-none" />
              <line x1={rx} y1={ry - RECORD.r + 6} x2={rx} y2={ry - RECORD.r + 20} className="stroke-bg" strokeWidth={1} />
            </g>
            <line
              x1={ARM.px - ARM.lift}
              y1={ARM.py - ARM.lift}
              x2={PL_STYLUS[0] - ARM.lift}
              y2={PL_STYLUS[1] - ARM.lift}
              strokeWidth={1.6}
            />
            <circle cx={ARM.px - ARM.lift} cy={ARM.py - ARM.lift} r="9" className="fill-bg" />
          </g>
          <path d={plinth.sil} strokeWidth={1.2} />
        </svg>
      </div>
      {/* The column, as a slab: its side and foot in the card's own shade. */}
      <div className="my-2.5 mr-3 grid w-[34%] content-start gap-1.5 border border-ink bg-surface p-1.5 shadow-[2.6px_1.5px_0_color-mix(in_oklab,var(--surface)_60%,#000)]">
        <span className="h-[3px] w-1/2 bg-vermilion" />
        <span className="h-[4px] w-full bg-ink" />
        <span className="h-[3px] w-2/3 bg-muted" />
        <span className="mt-1 h-[3px] w-full bg-soft-border" />
        <span className="h-[3px] w-4/5 bg-soft-border" />
      </div>
    </div>
  );
}

// The isometric stack in miniature, drawn from the skin's own geometry so the
// card can't drift from the player: speakers, receiver, tape deck, turntable,
// every box as its three shaded faces with a heavier silhouette, beside the
// column's brushed plate and its glass. The record spins and the power ring
// blinks under the shared play-state gate. Strokes don't scale with the
// drawing, so a hairline stays a hairline at card size.
const AXO_TOP = 'fill-bg';
const AXO_LEFT = 'fill-[color-mix(in_oklab,var(--ink)_4%,var(--bg))]';
const AXO_RIGHT = 'fill-[color-mix(in_oklab,var(--ink)_10%,var(--bg))]';
const AXO_WELL = 'fill-[color-mix(in_oklab,var(--ink)_16%,var(--bg))]';
const AXO_LID = 'fill-[color-mix(in_oklab,var(--ink)_7%,transparent)]';

/** One box: top (w×d), front-left (w×h) and front-right (d×h) faces. */
function AxoBox({ b }: { b: DrawnBlock }) {
  return (
    <>
      <rect transform={b.T} width={b.w} height={b.d} className={AXO_TOP} />
      <rect transform={b.L} width={b.w} height={b.h} className={AXO_LEFT} />
      <rect transform={b.R} width={b.d} height={b.h} className={AXO_RIGHT} />
    </>
  );
}

/** A rack bay as the player draws it: the shelf, then the back post segments
 *  standing on it. Its front segments go on after the unit it carries. */
function AxoBay({ level }: { level: RackLevel }) {
  return (
    <>
      <AxoBox b={level.shelf} />
      {level.back.map((p, i) => <AxoBox key={i} b={p} />)}
    </>
  );
}

function AxoPreview() {
  const [bay0, bay1, bay2] = AXO.rack;
  return (
    <div className="flex h-full w-full items-stretch">
      <div className="grid w-[30%] content-start gap-1.5 border-r border-ink bg-[color-mix(in_oklab,var(--bg)_94%,#000)] p-2 pt-4">
        <div className="grid gap-1 rounded-[2px] bg-[#0e0d0b] p-1.5">
          <span className="h-[3px] w-1/2 bg-vermilion" />
          <span className="h-[5px] w-full bg-[#f4f0e6]" />
          <span className="h-[3px] w-2/3 bg-[#f4f0e6]/50" />
          <span className="mt-0.5 h-[2px] w-full bg-[#f4f0e6]/20" />
        </div>
        <span className="mt-1 h-[3px] w-full bg-soft-border" />
        <span className="h-[3px] w-4/5 bg-soft-border" />
      </div>
      <div className="relative flex-1 bg-[radial-gradient(circle,var(--soft-border)_1px,transparent_1.5px)] bg-size-[9px_5.2px]">
        <svg
          viewBox="-250 -420 590 690"
          className="absolute inset-0 size-full fill-none stroke-ink [&_*]:[vector-effect:non-scaling-stroke]"
          strokeWidth={0.7}
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <AxoBox b={AXO.spL} />
          <path d={AXO.spL.sil} strokeWidth={1.2} />
          <AxoBay level={bay0} />
          <AxoBox b={AXO.rcv} />
          <g transform={AXO.rcv.L}>
            <rect x="12" y="42" width="112" height="20" className="fill-ink" />
            <circle cx="186" cy="38" r="22" className={AXO_WELL} />
            <circle
              cx="142"
              cy="24"
              r="12"
              strokeWidth={1.2}
              className={cn('stroke-vermilion', BLINK)}
            />
          </g>
          <path d={AXO.rcv.sil} strokeWidth={1.2} />
          {bay0.front.map((p, i) => <AxoBox key={i} b={p} />)}
          <AxoBay level={bay1} />
          <AxoBox b={AXO.tape} />
          <g transform={AXO.tape.L}>
            <rect x="12" y="8" width="110" height="46" className={AXO_WELL} />
            <circle cx="44" cy="34" r="10" className="fill-bg" />
            <circle cx="90" cy="34" r="10" className="fill-bg" />
            <rect x="134" y="8" width="44" height="14" className="fill-ink" />
          </g>
          <path d={AXO.tape.sil} strokeWidth={1.2} />
          {bay1.front.map((p, i) => <AxoBox key={i} b={p} />)}
          <AxoBay level={bay2} />
          <path d={AXO.lid.panel} className={AXO_LID} />
          <path d={AXO.lid.left} className={AXO_LID} />
          <path d={AXO.lid.right} className={AXO_LID} />
          <path d={AXO.lid.front} className={AXO_LID} />
          <path d={AXO.lid.sil} strokeWidth={1.2} />
          <AxoBox b={AXO.tt} />
          <g transform={AXO.tt.T}>
            <circle cx="96" cy="66" r="57" className={AXO_WELL} />
            <g className={cn('origin-center [transform-box:fill-box]', REEL)}>
              <circle cx="96" cy="66" r="52" className={AXO_LEFT} />
              <circle cx="96" cy="66" r="36" />
              <circle cx="96" cy="66" r="18" className="fill-vermilion stroke-none" />
              <line x1="96" y1="16" x2="96" y2="26" strokeWidth={1} />
            </g>
            <line x1="190" y1="24" x2="166" y2="98" strokeWidth={1.6} />
          </g>
          <path d={AXO.tt.sil} strokeWidth={1.2} />
          <AxoBox b={AXO.spR} />
          <g transform={AXO.spR.L}>
            <circle cx="40" cy="92" r="20" className={AXO_WELL} />
            <circle cx="40" cy="178" r="31" className={AXO_WELL} />
          </g>
          <path d={AXO.spR.sil} strokeWidth={1.2} />
        </svg>
      </div>
    </div>
  );
}

// The rotor machine in miniature, laid out on the desk machine's own grid
// (1360×800) and finished as the skin is, in Unit SW-9's hardware: a brushed
// plate whose side and lip show down the 30° axis, wells sunk into it, the
// tape and the lampboard as black display glass with two bulbs taking turns,
// dark keys on darker bodies swept down that same axis, and the power knob.
// Every key shade is mixed from the key's own face (--mk), as the skin's are,
// so the bodies stay darker than the faces on a dark theme too.
const C_PLATE = 'fill-[color-mix(in_oklab,var(--bg)_95%,#000)]';
const C_SIDE = 'fill-[color-mix(in_oklab,var(--bg)_72%,#000)]';
const C_LIP = 'fill-[color-mix(in_oklab,var(--bg)_80%,#000)]';
const C_WELL = 'fill-[color-mix(in_oklab,var(--bg)_89%,#000)]';
const C_DEEP = 'fill-[color-mix(in_oklab,var(--bg)_78%,#000)]';
const C_GLASS = 'fill-[#0e0d0b] stroke-[#0a0908]';
const C_KEY = 'fill-[var(--mk)]';
const C_BODY = 'fill-[color-mix(in_oklab,var(--mk)_56%,#000)] stroke-none';
// The 30° sweep of a key's body: cos 30°, sin 30° of its depth.
const C_DX = 7;
const C_DY = 4;

/** A block key: its body swept down the 30° axis, then its face. */
function CipherBlock({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const body = `M${x} ${y}H${x + w}L${x + w + C_DX} ${y + C_DY}V${y + h + C_DY}H${x + C_DX}L${x} ${y + h}Z`;
  return (
    <>
      <path d={body} className={C_BODY} />
      <rect x={x} y={y} width={w} height={h} rx="3" className={C_KEY} />
    </>
  );
}

function CipherPreview() {
  const lamps = CIPHER_ROWS.flatMap(({ length: n }, row) =>
    Array.from({ length: n }, (_, i) => ({ x: (n === 8 ? 316 : 264) + i * 104, y: 285 + row * 54 })),
  );
  const keys = CIPHER_ROWS.flatMap(({ length: n }, row) =>
    Array.from({ length: n }, (_, i) => ({ x: 264 + i * 104, y: 518 + row * 66 })),
  );
  return (
    <div className="flex h-full w-full items-center justify-center p-2.5 pt-5">
      <svg
        viewBox="0 0 1380 806"
        className="h-full w-full fill-none stroke-ink [--mk:color-mix(in_oklab,var(--ink)_92%,var(--bg))] [&_*]:[vector-effect:non-scaling-stroke]"
        strokeWidth={0.8}
        aria-hidden="true"
      >
        <path d="M1360 0L1374 8V796L1360 788Z" className={C_SIDE} />
        <path d="M0 788H1360L1374 796H14Z" className={C_LIP} />
        <rect width="1360" height="788" className={C_PLATE} strokeWidth={1.2} />
        {([
          [20, 20, 164, 200], [198, 20, 440, 200],
          [20, 234, 164, 214], [1176, 234, 164, 214],
          [20, 462, 164, 306], [1176, 462, 164, 306],
        ] as const).map(([x, y, w, h]) => <rect key={`${x}-${y}`} x={x} y={y} width={w} height={h} rx="4" className={C_WELL} />)}
        <rect x="198" y="462" width="964" height="306" rx="4" className={C_DEEP} />
        <rect x="652" y="20" width="688" height="200" rx="4" className={C_GLASS} />
        <rect x="198" y="234" width="964" height="214" rx="4" className={C_GLASS} />

        <g transform="translate(102 112)">
          <circle cx="6" cy="3.5" r="40" className={C_BODY} />
          <circle r="40" className={C_KEY} />
          <circle r="27" className="fill-[color-mix(in_oklab,var(--mk)_88%,#fff)]" />
          <g transform="rotate(45)">
            <line y1="-24" y2="-9" className="stroke-vermilion" strokeWidth={3} strokeLinecap="round" />
          </g>
        </g>
        {[278, 418, 558].map(c => (
          <g key={c}>
            <CipherBlock x={c - 42} y={34} w={84} h={24} />
            <rect x={c - 48} y="66" width="70" height="88" rx="3" className={C_GLASS} />
            <rect x={c - 30} y="98" width="34" height="24" className="fill-[#f4f0e6] stroke-none" />
            <rect x={c + 28} y="66" width="20" height="88" rx="3" className={C_KEY} />
            <CipherBlock x={c - 42} y={162} w={84} h={24} />
          </g>
        ))}
        <rect x="678" y="48" width="130" height="7" className="fill-vermilion stroke-none" />
        <rect x="678" y="80" width="320" height="38" className="fill-[#f4f0e6] stroke-none" />
        <rect x="678" y="138" width="210" height="10" className="fill-[#f4f0e6]/50 stroke-none" />
        <line x1="678" y1="192" x2="1314" y2="192" className="stroke-[#f4f0e6]/40" strokeDasharray="6 5" />
        <line x1="678" y1="192" x2="930" y2="192" className="stroke-vermilion" strokeWidth={2} />

        {([[46, 299, 112, 84], [1202, 299, 112, 84], [46, 540, 112, 56], [46, 616, 112, 56], [1198, 551, 120, 128], [472, 699, 416, 36]] as const).map(
          ([x, y, w, h]) => <CipherBlock key={`${x}-${y}`} x={x} y={y} w={w} h={h} />,
        )}
        {lamps.map(l => <circle key={`${l.x}-${l.y}`} cx={l.x} cy={l.y} r="25" className="fill-[#2a2724] stroke-[#000]" />)}
        <circle cx="888" cy="393" r="25" className={cn('fill-vermilion stroke-none', BLINK)} />
        <circle cx="1096" cy="285" r="25" className={cn('fill-vermilion stroke-none [animation-delay:525ms]', BLINK)} />
        {keys.map(k => (
          <g key={`${k.x}-${k.y}`}>
            <circle cx={k.x + C_DX} cy={k.y + C_DY} r="29" className={C_BODY} />
            <circle cx={k.x} cy={k.y} r="29" className={C_KEY} />
          </g>
        ))}
      </svg>
    </div>
  );
}

const PREVIEWS: Record<string, () => ReactNode> = {
  classic: ClassicPreview,
  unit: UnitPreview,
  drift: DriftPreview,
  subamp: SubampPreview,
  tty: TtyPreview,
  platter: PlatterPreview,
  axo: AxoPreview,
  cipher: CipherPreview,
};

// A neutral wireframe for any skin without a bespoke poster (community skins).
function GenericPreview() {
  return (
    <div className="flex h-full w-full flex-col gap-1.5 p-3">
      <span className="h-[3px] w-1/2 bg-ink" />
      <span className="flex-1 border border-dashed border-ink/50" />
      <EqRow className="h-4" />
    </div>
  );
}

/** The miniature for one skin id, or a neutral wireframe for an unknown one. */
export default function SkinPreview({ id }: { id: string }) {
  const Preview = PREVIEWS[id] ?? GenericPreview;
  return <Preview />;
}

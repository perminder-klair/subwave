'use client';

import type { ReactNode } from 'react';
import { DEFAULT_SKIN_ID, SKINS } from '../../skins';
import { Pill } from '../ui';
import { cn } from '../../../lib/cn';
import { AXO, type DrawnBlock } from '../../skins/axo/geometry';
import { ROWS as CIPHER_ROWS } from '../../skins/cipher/cipher';

// Each card frames a pure-CSS miniature of that skin's real layout. The motion
// idles unless a card is the live skin or under the cursor, gated through Tailwind
// play-state variants. Keyframes live in app/globals.css (skin-*).

interface SkinGalleryProps {
  activeSkinId?: string;
  busy: boolean;
  onChoose: (id: string) => void;
}

// Shared play-state gate: paused by default, runs on hover or when this card is
// the active (aria-pressed) station skin, and stands down under reduced motion.
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

function TtyPreview() {
  return (
    <div className="m-2.5 flex h-[calc(100%-1.25rem)] flex-col border border-ink bg-field">
      <div className="flex items-center gap-1 border-b border-ink px-1.5 py-1">
        <span className="size-1.5 rounded-full bg-vermilion" />
        <span className="size-1.5 rounded-full border border-ink" />
        <span className="ml-auto h-px w-6 bg-muted" />
      </div>
      <div className="flex flex-1 divide-x divide-ink">
        <div className="grid flex-1 content-start gap-[3px] p-1.5">
          <span className="flex items-center gap-1">
            <span className="font-mono text-[7px] leading-none font-bold text-vermilion">›</span>
            <span className="h-[3px] w-2/3 bg-ink" />
          </span>
          <span className="ml-2 h-[3px] w-1/2 bg-muted" />
          <span className="ml-2 h-[3px] w-3/5 bg-muted" />
          <span className="flex items-center gap-1">
            <span className="h-[3px] w-1/3 bg-ink" />
            <span className={cn('h-2 w-[3px] bg-vermilion', BLINK)} />
          </span>
        </div>
        <div className="grid w-1/3 content-start gap-[3px] p-1.5">
          <span className="h-[3px] w-full bg-muted" />
          <span className="h-[3px] w-2/3 bg-muted" />
          <span className="h-[3px] w-4/5 bg-muted" />
        </div>
      </div>
      <div className="flex items-center gap-1 border-t border-ink bg-ink px-1.5 py-[3px]">
        <span className="font-mono text-[7px] leading-none font-bold text-bg">ON AIR</span>
        <span className="ml-auto h-px w-8 bg-bg/60" />
      </div>
    </div>
  );
}

function PlatterPreview() {
  return (
    <div className="flex h-full w-full items-center gap-2 bg-field p-2.5">
      <div className="relative grid aspect-square h-full place-items-center border border-ink bg-bg">
        <span className={cn('relative grid aspect-square h-[74%] place-items-center rounded-full border border-ink bg-ink', REEL)}>
          <span className="grid aspect-square h-[42%] place-items-center rounded-full border border-bg/70 bg-field">
            <span className="size-[3px] rounded-full bg-vermilion" />
          </span>
        </span>
        <span className="absolute top-1 right-1 h-[2px] w-[58%] origin-right -rotate-[28deg] bg-ink" />
        <span className="absolute top-1 right-1 size-[5px] translate-x-1/2 -translate-y-1/2 rounded-full border border-ink bg-field" />
      </div>
      <div className="grid flex-1 content-start gap-1.5 border border-ink bg-surface p-1.5">
        <span className="h-[3px] w-1/3 bg-vermilion" />
        <span className="h-[4px] w-4/5 bg-ink" />
        <span className="h-[3px] w-1/2 bg-muted" />
        <span className="mt-1 h-[3px] w-full bg-soft-border" />
        <EqRow className="mt-1 h-4 justify-start" />
      </div>
    </div>
  );
}

// The isometric stack in miniature, drawn from the skin's own geometry so the
// card can't drift from the player: speakers, receiver, tape deck, turntable,
// every box as its three shaded faces with a heavier silhouette. The record
// spins and the power ring blinks under the shared play-state gate. Strokes
// don't scale with the drawing, so a hairline stays a hairline at card size.
const AXO_TOP = 'fill-bg';
const AXO_LEFT = 'fill-[color-mix(in_oklab,var(--ink)_4%,var(--bg))]';
const AXO_RIGHT = 'fill-[color-mix(in_oklab,var(--ink)_10%,var(--bg))]';
const AXO_WELL = 'fill-[color-mix(in_oklab,var(--ink)_16%,var(--bg))]';

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

function AxoPreview() {
  const posts = [AXO.pBL, AXO.pBR];
  const front = [AXO.pFL, AXO.pFR];
  return (
    <div className="flex h-full w-full items-stretch">
      <div className="grid w-[30%] content-start gap-1.5 border-r border-ink p-2.5 pt-5">
        <span className="h-[3px] w-1/2 bg-vermilion" />
        <span className="h-[5px] w-full bg-ink" />
        <span className="h-[3px] w-2/3 bg-muted" />
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
          {posts.map((p, i) => <AxoBox key={i} b={p} />)}
          <AxoBox b={AXO.s0} />
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
          <AxoBox b={AXO.s1} />
          <AxoBox b={AXO.tape} />
          <g transform={AXO.tape.L}>
            <rect x="12" y="8" width="110" height="46" className={AXO_WELL} />
            <circle cx="44" cy="34" r="10" className="fill-bg" />
            <circle cx="90" cy="34" r="10" className="fill-bg" />
            <rect x="134" y="8" width="44" height="14" className="fill-ink" />
          </g>
          <path d={AXO.tape.sil} strokeWidth={1.2} />
          <AxoBox b={AXO.s2} />
          <path d={AXO.lid} className="fill-[color-mix(in_oklab,var(--ink)_5%,transparent)]" />
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
          {front.map((p, i) => <AxoBox key={i} b={p} />)}
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

// The rotor machine's top deck in miniature, laid out on the desk machine's own
// grid (1360×800): power key, rotor windows, tape, the lampboard with two
// bulbs taking turns, and the keyboard in its well.
const CIPHER_PANEL = 'fill-bg';
const CIPHER_PLATE = 'fill-[color-mix(in_oklab,var(--ink)_5%,var(--bg))]';
const CIPHER_WELL = 'fill-[color-mix(in_oklab,var(--ink)_13%,var(--bg))]';
const CIPHER_SKIRT = 'fill-[color-mix(in_oklab,var(--ink)_12%,var(--bg))]';

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
        viewBox="0 0 1360 800"
        className="h-full w-full fill-none stroke-ink [&_*]:[vector-effect:non-scaling-stroke]"
        strokeWidth={0.8}
        aria-hidden="true"
      >
        <rect width="1360" height="788" className={CIPHER_PLATE} strokeWidth={1.2} />
        {([
          [20, 20, 164, 200], [198, 20, 440, 200], [652, 20, 688, 200],
          [20, 234, 164, 214], [198, 234, 964, 214], [1176, 234, 164, 214],
          [20, 462, 164, 306], [1176, 462, 164, 306],
        ] as const).map(([x, y, w, h]) => <rect key={`${x}-${y}`} x={x} y={y} width={w} height={h} className={CIPHER_PANEL} />)}
        <rect x="198" y="462" width="964" height="306" className={CIPHER_WELL} />

        <g transform="translate(102 112)">
          <circle r="40" className={CIPHER_WELL} />
          <circle r="28" className={CIPHER_PANEL} />
          <g transform="rotate(45)">
            <rect x="-8" y="-36" width="16" height="72" className={CIPHER_PANEL} />
            <line y1="-14" y2="14" className="stroke-vermilion" strokeWidth={2} />
          </g>
        </g>
        {[278, 418, 558].map(c => (
          <g key={c}>
            <rect x={c - 48} y="66" width="70" height="88" className={CIPHER_PANEL} />
            <rect x={c - 30} y="98" width="34" height="24" className="fill-ink stroke-none" />
            <rect x={c + 28} y="66" width="20" height="88" className={CIPHER_WELL} />
          </g>
        ))}
        <rect x="678" y="48" width="130" height="7" className="fill-vermilion stroke-none" />
        <rect x="678" y="80" width="320" height="38" className="fill-ink stroke-none" />
        <rect x="678" y="138" width="210" height="10" className="fill-muted stroke-none" />
        <line x1="678" y1="192" x2="1314" y2="192" strokeDasharray="6 5" />
        <line x1="678" y1="192" x2="930" y2="192" className="stroke-vermilion" strokeWidth={2} />

        {([[46, 299, 84], [1202, 299, 84], [46, 540, 56], [46, 616, 56], [1198, 551, 128]] as const).map(([x, y, h], i) => (
          <g key={`${x}-${y}`}>
            <rect x={x} y={y + 8} width={i === 4 ? 120 : 112} height={h} className={CIPHER_SKIRT} />
            <rect x={x} y={y} width={i === 4 ? 120 : 112} height={h} className={CIPHER_PANEL} />
          </g>
        ))}
        {lamps.map(l => <circle key={`${l.x}-${l.y}`} cx={l.x} cy={l.y} r="25" className={CIPHER_PANEL} />)}
        <circle cx="888" cy="393" r="25" className={cn('fill-vermilion stroke-none', BLINK)} />
        <circle cx="1096" cy="285" r="25" className={cn('fill-vermilion stroke-none [animation-delay:525ms]', BLINK)} />
        {keys.map(k => <circle key={`${k.x}-${k.y}`} cx={k.x} cy={k.y} r="29" className={CIPHER_PANEL} />)}
        <rect x="472" y="699" width="416" height="36" className={CIPHER_PANEL} />
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

export function SkinGallery({ activeSkinId, busy, onChoose }: SkinGalleryProps) {
  const active = SKINS.some(s => s.id === activeSkinId) ? activeSkinId : DEFAULT_SKIN_ID;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {SKINS.map((s, i) => {
        const isActive = s.id === active;
        const Preview = PREVIEWS[s.id] ?? GenericPreview;
        return (
          <button
            key={s.id}
            type="button"
            aria-pressed={isActive}
            aria-label={`Set station skin to ${s.name}`}
            disabled={busy || isActive}
            onClick={() => { if (!busy && !isActive) onChoose(s.id); }}
            className={cn(
              'group relative flex flex-col overflow-hidden border text-left transition-all duration-200',
              'focus-visible:ring-2 focus-visible:ring-vermilion focus-visible:ring-offset-2 focus-visible:ring-offset-bg focus-visible:outline-none',
              isActive
                ? 'border-vermilion shadow-[0_0_0_1px_var(--accent)]'
                : 'cursor-pointer border-ink hover:-translate-y-0.5 hover:shadow-[3px_3px_0_0_var(--ink)]',
            )}
          >
            <div
              className={cn(
                'relative aspect-[16/10] w-full overflow-hidden border-b',
                isActive ? 'border-vermilion bg-[var(--accent-soft)]' : 'border-ink bg-field',
              )}
            >
              <Preview />
              <span className="absolute top-1.5 left-1.5 font-mono text-[9px] leading-none font-bold tracking-[0.14em] text-muted">
                {String(i + 1).padStart(2, '0')}
              </span>
              {!isActive && (
                <span className="pointer-events-none absolute inset-x-0 bottom-0 translate-y-full bg-ink px-2 py-1 text-center text-[9px] font-bold tracking-[0.2em] text-bg uppercase transition-transform duration-200 group-hover:translate-y-0">
                  Set as station skin
                </span>
              )}
            </div>
            <div className="flex items-start justify-between gap-2 p-3">
              <div className="grid min-w-0 gap-0.5">
                <span className="text-[12px] font-bold tracking-[0.14em] text-ink uppercase">
                  {s.name}
                </span>
                {s.description && (
                  <span className="text-[10.5px] leading-[1.45] text-muted">{s.description}</span>
                )}
              </div>
              {isActive && <Pill tone="accent" dot>on air</Pill>}
            </div>
          </button>
        );
      })}
    </div>
  );
}

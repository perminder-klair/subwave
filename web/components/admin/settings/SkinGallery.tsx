'use client';

import type { ReactNode } from 'react';
import { DEFAULT_SKIN_ID, SKINS } from '../../skins';
import { Pill } from '../ui';
import { cn } from '../../../lib/cn';

// The skin picker as a contact sheet: each card frames a pure-CSS miniature of
// that skin's real layout, printed in the broadsheet palette. Signature motion
// (waveform, spinning reels, blinking cursor, a light sweep) idles only when a
// card is the live station skin or under the cursor — gated through Tailwind
// `group-hover` / `group-aria-pressed` play-state variants so the rack reads as
// a still print until touched. Keyframes live in app/globals.css (skin-*).

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

// ── Classic: masthead · centre-stage disc · waveform · transport deck ─────────
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

// ── Spool: a walkman cassette — the whole station on one tape ─────────────────
function ReelHub() {
  return (
    <span className="grid aspect-square h-[78%] place-items-center rounded-full border-2 border-ink bg-bg">
      <span className={cn('relative grid size-1/2 place-items-center rounded-full border border-ink', REEL)}>
        <span className="absolute h-px w-full bg-ink" />
        <span className="absolute h-full w-px bg-ink" />
        <span className="relative size-[3px] rounded-full bg-vermilion" />
      </span>
    </span>
  );
}

function SpoolPreview() {
  return (
    <div className="flex h-full w-full items-center justify-center p-3">
      <div className="flex aspect-[3/2] h-[82%] flex-col justify-between border-2 border-ink bg-field p-2">
        <div className="flex flex-1 items-center justify-around">
          <ReelHub />
          <ReelHub />
        </div>
        <span className="mx-auto mt-1.5 h-[3px] w-2/3 bg-ink" />
      </div>
    </div>
  );
}

// ── Drift: ninety percent weather, ten percent type ───────────────────────────
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

// ── Subamp: compact modular rack — deck · booth · log stacked like it's 1998 ──
function SubampPreview() {
  return (
    <div className="flex h-full w-full flex-col gap-1 p-2.5">
      <div className="flex items-center gap-1 border border-ink bg-ink px-1 py-[3px]">
        <span className="size-[3px] bg-vermilion" />
        <span className="h-px flex-1 bg-bg/60" />
        <span className="h-[3px] w-1 bg-bg/60" />
      </div>
      <div className="flex items-center gap-1.5 border border-ink px-1.5 py-1">
        <span className="font-mono text-[7px] leading-none font-bold text-vermilion">128</span>
        <EqRow className="h-4 flex-1 justify-end" />
      </div>
      <div className="flex items-center gap-1.5 border border-ink px-1.5 py-1">
        <span className="size-2 rounded-full border border-ink" />
        <span className="h-px flex-1 bg-muted" />
      </div>
      <div className="grid flex-1 content-start gap-[3px] border border-ink p-1.5">
        <span className="h-[3px] w-full bg-ink" />
        <span className="h-[3px] w-4/5 bg-muted" />
        <span className="h-[3px] w-3/5 bg-muted" />
      </div>
    </div>
  );
}

// ── TTY: the station as a live process — panes and a status line ──────────────
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

// ── Platter: a reference turntable — the record spins, the arm tracks ─────────
function PlatterPreview() {
  return (
    <div className="flex h-full w-full items-center gap-2 bg-field p-2.5">
      {/* plinth + spinning record + diagonal tonearm */}
      <div className="relative grid aspect-square h-full place-items-center border border-ink bg-bg">
        <span className={cn('relative grid aspect-square h-[74%] place-items-center rounded-full border border-ink bg-ink', REEL)}>
          <span className="grid aspect-square h-[42%] place-items-center rounded-full border border-bg/70 bg-field">
            <span className="size-[3px] rounded-full bg-vermilion" />
          </span>
        </span>
        <span className="absolute top-1 right-1 h-[2px] w-[58%] origin-right -rotate-[28deg] bg-ink" />
        <span className="absolute top-1 right-1 size-[5px] translate-x-1/2 -translate-y-1/2 rounded-full border border-ink bg-field" />
      </div>
      {/* metadata stub */}
      <div className="grid flex-1 content-start gap-1.5">
        <span className="h-[3px] w-1/3 bg-vermilion" />
        <span className="h-[4px] w-4/5 bg-ink" />
        <span className="h-[3px] w-1/2 bg-muted" />
        <span className="mt-1 h-[3px] w-full bg-soft-border" />
        <EqRow className="mt-1 h-4 justify-start" />
      </div>
    </div>
  );
}

const PREVIEWS: Record<string, () => ReactNode> = {
  classic: ClassicPreview,
  spool: SpoolPreview,
  drift: DriftPreview,
  subamp: SubampPreview,
  tty: TtyPreview,
  platter: PlatterPreview,
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

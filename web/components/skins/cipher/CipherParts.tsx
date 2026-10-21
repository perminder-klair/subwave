'use client';

// The machine's parts. Each one is drawn once and sized by the variables its
// machine sets (.desk or .mob in Cipher.module.css), so the desk and the phone
// share every component. Colour comes from the pen variables on the skin root:
// solid ink when powered, construction lines in standby or off air.

import { memo, useRef } from 'react';
import type { ButtonHTMLAttributes, PointerEvent, ReactNode, WheelEvent } from 'react';
import styles from './Cipher.module.css';
import { cn } from '@/lib/cn';
import { useDynamicStyle } from '@/hooks/useDynamicStyle';
import { ROWS, chr, scatter } from './cipher';
import type { Spelling } from './useCipherMachine';

/** A framed bay with its name notched into the top rule. */
export function Panel({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={cn(styles.panel, className)}>
      <span className={styles.legend}>{label}</span>
      {children}
    </div>
  );
}

/** The four slotted screws in the corners of the desk machine's top plate. */
export function Screws() {
  return (
    <>
      <span className={cn(styles.screw, 'top-[5px] left-[5px]')} aria-hidden="true" />
      <span className={cn(styles.screw, 'top-[5px] right-[5px]')} aria-hidden="true" />
      <span className={cn(styles.screw, 'bottom-[5px] left-[5px]')} aria-hidden="true" />
      <span className={cn(styles.screw, 'right-[5px] bottom-[5px]')} aria-hidden="true" />
    </>
  );
}

/** The power key: a turn switch that reads OFF at -45° and ON at +45°, with
 *  a ring rippling out of it while the tune-in gate waits. */
export function PowerKey({
  on,
  gate,
  disabled,
  compact,
  label,
  onPress,
}: {
  on: boolean;
  gate: boolean;
  disabled: boolean;
  /** The phone's key: bolder strokes for its smaller size, 0/1 legends. */
  compact?: boolean;
  label: string;
  onPress: () => void;
}) {
  const w = compact ? 2 : 1;
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      disabled={disabled}
      onClick={onPress}
      className="v3-focus block cursor-pointer border-0 bg-transparent p-0 disabled:cursor-default"
    >
      <svg
        viewBox="-64 -64 128 128"
        className={cn('block overflow-visible', compact ? 'size-[62px]' : 'size-[128px]')}
        aria-hidden="true"
      >
        <circle r="46" strokeWidth={1.5 * w} className={cn(styles.ring, gate && styles.ringOn)} />
        {compact ? (
          <>
            <text x="-46" y="-44" fontSize={16} fontWeight={700} textAnchor="middle" className={cn(styles.svgTxt, 'font-mono')}>0</text>
            <text x="46" y="-44" fontSize={16} fontWeight={700} textAnchor="middle" className={cn(styles.svgTxt, 'font-mono')}>1</text>
          </>
        ) : (
          <>
            <path d="M-31.1 -31.1L-36.8 -36.8M31.1 -31.1L36.8 -36.8" strokeWidth={1.5} className={styles.pen} />
            <text x="-45" y="-43" fontSize={9} fontWeight={700} letterSpacing="0.1em" textAnchor="middle" className={cn(styles.svgTxt, 'font-mono')}>OFF</text>
            <text x="45" y="-43" fontSize={9} fontWeight={700} letterSpacing="0.1em" textAnchor="middle" className={cn(styles.svgTxt, 'font-mono')}>ON</text>
          </>
        )}
        <circle r="40" strokeWidth={1.5 * w} className={cn(styles.pen, styles.penFill)} />
        <circle r="28" strokeWidth={w} className={cn(styles.pen, styles.penBg)} />
        <g className={cn(styles.keyTurn, on && styles.keyOn)}>
          <rect
            x={compact ? -9 : -8}
            y="-36"
            width={compact ? 18 : 16}
            height="72"
            strokeWidth={1.5 * w}
            className={cn(styles.pen, styles.penBg)}
          />
          {!compact && <circle cy="-27" r="3.5" strokeWidth={1} className={styles.pen} />}
          <line y1={compact ? -16 : -14} y2={compact ? 16 : 14} strokeWidth={compact ? 5 : 2.5} className={styles.svgAcc} />
        </g>
      </svg>
    </button>
  );
}

/** One rotor: arrows to step it, its window showing the neighbours, and a
 *  milled edge that drags. It is a slider to assistive tech and the keyboard.
 *  `max` makes it end-stopped (rotor I, the volume); without it, it wraps. */
export function Rotor({
  name,
  label,
  value,
  max,
  accent,
  onChange,
}: {
  name: string;
  label: string;
  value: number;
  max?: number;
  accent?: boolean;
  onChange: (v: number) => void;
}) {
  const glyph = (x: number) => (max == null ? chr(x) : x < 0 || x > max ? '' : String(x).padStart(2, '0'));
  const ridgeRef = useRef<HTMLSpanElement | null>(null);
  useDynamicStyle(ridgeRef, { '--ridge': `${value * 2}px` });

  const drag = useRef<{ y: number; v: number } | null>(null);
  const wheel = useRef(0);
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button > 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { y: e.clientY, v: value };
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d) onChange(d.v + Math.round((d.y - e.clientY) / 12));
  };
  const up = () => { drag.current = null; };
  // Trackpads send a stream of small deltas; a notch per 40px keeps one
  // flick from spinning the rotor round twice.
  const turn = (e: WheelEvent<HTMLDivElement>) => {
    wheel.current += e.deltaY;
    if (Math.abs(wheel.current) < 40) return;
    onChange(value + (wheel.current < 0 ? 1 : -1));
    wheel.current = 0;
  };

  const arrow = (dir: 1 | -1) => (
    <button
      type="button"
      aria-label={`${label} ${dir > 0 ? 'up' : 'down'}`}
      onClick={() => onChange(value + dir)}
      className={cn(styles.rotBtn, 'v3-focus flex cursor-pointer items-center justify-center border-0 bg-transparent p-0')}
    >
      <svg width="14" height="8" viewBox="0 0 14 8" className="block fill-none stroke-current" strokeWidth={1.5} aria-hidden="true">
        <path d={dir > 0 ? 'M1 7L7 1L13 7' : 'M1 1L7 7L13 1'} />
      </svg>
    </button>
  );

  return (
    <div className={cn(styles.rotCol, 'flex flex-col items-center')}>
      {arrow(1)}
      <div
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max ?? 25}
        aria-valuenow={max == null ? ((value % 26) + 26) % 26 : value}
        aria-valuetext={max == null ? chr(value) : `${value} of ${max}`}
        onKeyDown={e => {
          const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
          if (step != null) { e.preventDefault(); onChange(value + step); }
          else if (max != null && e.key === 'Home') { e.preventDefault(); onChange(0); }
          else if (max != null && e.key === 'End') { e.preventDefault(); onChange(max); }
        }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onWheel={turn}
        className={cn(styles.rotBody, 'v3-focus flex outline-none')}
      >
        <span className={cn(styles.rotWin, 'relative flex flex-col items-center justify-center gap-1 overflow-hidden')}>
          <span className={styles.rotSmall}>{glyph(value - 1)}</span>
          <span className={styles.rotBig}>{glyph(value)}</span>
          <span className={styles.rotSmall}>{glyph(value + 1)}</span>
          <span className={styles.rotTick} />
        </span>
        <span ref={ridgeRef} className={styles.rotRidge} />
      </div>
      {arrow(-1)}
      <span className={cn(styles.rotLabel, accent ? 'text-vermilion' : 'text-muted')}>{name}</span>
    </div>
  );
}

/** The lampboard: one bulb per letter, `lit` glowing. Decorative — the tape
 *  says in words what the bulbs spell. */
export const Lampboard = memo(function Lampboard({ lit }: { lit: string | null }) {
  return (
    <div aria-hidden="true" className="flex flex-col items-center">
      {ROWS.map(row => (
        <div key={row} className="flex">
          {Array.from(row, c => (
            <div key={c} className={cn(styles.lampCell, lit === c && styles.lampOn)}>
              <div className={styles.lamp}>
                <div className={styles.lampGlow} />
                <div className={styles.lampBase} />
                <div className={styles.lampGlass}>
                  <div className={styles.lampFill} />
                  <div className={styles.lampSpec} />
                </div>
                <div className={styles.lampRim}>{c}</div>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
});

export interface KeyHandlers {
  /** A finger or button went down on a key: type it and hold it. */
  hold: (ch: string) => void;
  /** Activated without a pointer (assistive tech): type it, spring back. */
  tap: (ch: string) => void;
  release: () => void;
}

/** The three rows of letter keys. They sit outside the tab order (the
 *  physical keyboard types the same letters) but stay buttons for assistive
 *  tech, which clicks them with detail 0. */
export const KeyRows = memo(function KeyRows({ down, keys }: { down: string | null; keys: KeyHandlers }) {
  return (
    <>
      {ROWS.map(row => (
        <div key={row} className="flex">
          {Array.from(row, c => (
            <button
              key={c}
              type="button"
              tabIndex={-1}
              aria-label={c}
              data-cipher-key=""
              data-down={down === c ? '' : undefined}
              onPointerDown={e => {
                if (e.button > 0) return;
                e.currentTarget.setPointerCapture?.(e.pointerId);
                keys.hold(c);
              }}
              onPointerUp={keys.release}
              onPointerCancel={keys.release}
              onLostPointerCapture={keys.release}
              onClick={e => { if (e.detail === 0) keys.tap(c); }}
              className={cn(styles.capCell, 'cursor-pointer border-0 bg-transparent p-0')}
            >
              <span className={styles.cap}>
                <span className={styles.capSkirt} />
                <span className={styles.capTop}>{c}</span>
              </span>
            </button>
          ))}
        </div>
      ))}
    </>
  );
});

/** A rectangular key on a skirt. `drop` (a Tailwind `[--drop:…]` class in
 *  className) is how far it travels. Latched keys sit down in the well;
 *  `lit` fills the face with the accent. */
export function BlockKey({
  latched,
  lit,
  dead,
  caps,
  down,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  latched?: boolean;
  lit?: boolean;
  /** Printed in the muted ink: nothing to act on yet. */
  dead?: boolean;
  /** The keyboard's darker skirt rather than a panel key's. */
  caps?: boolean;
  /** Held from the keyboard (the space bar). */
  down?: boolean;
}) {
  return (
    <button
      type="button"
      {...rest}
      data-down={down ? '' : undefined}
      className={cn(
        styles.block,
        latched && styles.latched,
        lit && styles.lit,
        dead && styles.dead,
        caps && styles.capsSkirt,
        'v3-focus cursor-pointer disabled:cursor-default',
        className,
      )}
    >
      <span className={styles.blockSkirt} />
      <span className={styles.blockFace}>{children}</span>
    </button>
  );
}

/** Title or artist as single characters, so the one on the beat can take the
 *  accent. While the tuning sweep runs, the unresolved tail shows scattered
 *  letters. Words stay whole across a wrap. */
export function TapeChars({
  text,
  base,
  spelling: { cursor, scramble, seed },
}: {
  text: string;
  /** Where this text starts in the lampboard sequence. */
  base: number;
  spelling: Spelling;
}) {
  const chars = Array.from(text);
  const resolved = Math.floor(scramble * chars.length);
  const words: { ch: string; j: number }[][] = [[]];
  chars.forEach((ch, j) => {
    if (ch === ' ') words.push([]);
    else words[words.length - 1]!.push({ ch, j });
  });
  return (
    <>
      {words.map((w, wi) => (
        <span key={wi}>
          {wi > 0 && ' '}
          <span className="whitespace-nowrap">
            {w.map(({ ch, j }) => {
              let c = ch;
              if (j >= resolved) {
                c = chr(scatter(base + j, seed));
                if (ch !== ch.toUpperCase()) c = c.toLowerCase();
              }
              return (
                <span key={j} className={base + j === cursor ? styles.hot : undefined}>{c}</span>
              );
            })}
          </span>
        </span>
      ))}
    </>
  );
}

'use client';

// The machine's parts, in Unit SW-9's hardware. Each one is drawn once and
// sized by the variables its machine sets (.desk or .mob in Cipher.module.css),
// so the desk and the phone share every component. Every depth — a key's
// travel, a lamp's socket, the knob's side — runs down the one 30° axis; the
// finish comes from the hardware variables on the skin root, and standby
// darkens the glass and the lamps rather than the metal. A part that shows a
// value the ambient clock changes (a bulb, a held key, a rotor window, a tape
// character) reads it from the machine's store itself, so the clock re-renders
// that part and never the machine round it.

import { memo, useId, useRef } from 'react';
import type { ButtonHTMLAttributes, PointerEvent, ReactNode, WheelEvent } from 'react';
import styles from './Cipher.module.css';
import { cn } from '@/lib/cn';
import { useDynamicStyle } from '@/hooks/useDynamicStyle';
import { ROWS, chr, scatter, volGlyph, type Rotors } from './cipher';
import { litOf, type MachineStore } from './machineStore';
import { useMachine } from './useCipherMachine';

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
export const Screws = memo(function Screws() {
  return (
    <>
      <span className={cn(styles.screw, 'top-[5px] left-[5px]')} aria-hidden="true" />
      <span className={cn(styles.screw, 'top-[5px] right-[5px]')} aria-hidden="true" />
      <span className={cn(styles.screw, 'bottom-[5px] left-[5px]')} aria-hidden="true" />
      <span className={cn(styles.screw, 'right-[5px] bottom-[5px]')} aria-hidden="true" />
    </>
  );
});

/** The power key: a weighted knob that reads OFF at -45° and ON at +45°, its
 *  side showing down the 30° axis, with a ring rippling out of it while the
 *  tune-in gate waits. */
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
  // useId's punctuation varies across React versions; keep url(#…) plain.
  const uid = `pk-${useId().replace(/[^\w-]/g, '')}`;
  const w = compact ? 2 : 1;
  // The knob stands 7 proud of the plate; its side runs down the 30° axis.
  const side = { x: 6.06, y: 3.5 };
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      disabled={disabled}
      onClick={onPress}
      className="v3-focus relative block cursor-pointer border-0 bg-transparent p-0 disabled:cursor-default"
    >
      {/* Under the drawing (both positioned, so DOM order stacks them), as
          the SVG circle was: the knob's side still covers its lower right. */}
      {gate && <span className={styles.ring} aria-hidden="true" />}
      <svg
        viewBox="-64 -64 128 128"
        className={cn('relative block overflow-visible', compact ? 'size-[62px]' : 'size-[128px]')}
        aria-hidden="true"
      >
        <defs>
          <radialGradient id={`${uid}-o`} cx="50%" cy="22%" r="80%">
            <stop offset="0" className={styles.pkO0} />
            <stop offset="0.72" className={styles.pkO1} />
          </radialGradient>
          <radialGradient id={`${uid}-i`} cx="50%" cy="20%" r="85%">
            <stop offset="0" className={styles.pkI0} />
            <stop offset="0.78" className={styles.pkI1} />
          </radialGradient>
        </defs>
        {compact ? (
          <>
            <text x="-46" y="-44" fontSize={16} fontWeight={700} textAnchor="middle" className={cn(styles.svgTxt, 'font-mono')}>0</text>
            <text x="46" y="-44" fontSize={16} fontWeight={700} textAnchor="middle" className={cn(styles.svgTxt, 'font-mono')}>1</text>
          </>
        ) : (
          <>
            <path d="M-31.1 -31.1L-36.8 -36.8M31.1 -31.1L36.8 -36.8" strokeWidth={1.5} className={styles.svgTick} />
            <text x="-45" y="-43" fontSize={9} fontWeight={700} letterSpacing="0.1em" textAnchor="middle" className={cn(styles.svgTxt, 'font-mono')}>OFF</text>
            <text x="45" y="-43" fontSize={9} fontWeight={700} letterSpacing="0.1em" textAnchor="middle" className={cn(styles.svgTxt, 'font-mono')}>ON</text>
          </>
        )}
        <circle cx={side.x + 5} cy={side.y + 5} r="41" className={styles.pkShadow} />
        <line x2={side.x} y2={side.y} strokeWidth={80} strokeLinecap="round" className={styles.pkSide} />
        <circle r="40" fill={`url(#${uid}-o)`} strokeWidth={w} className={styles.pkRim} />
        <circle r="34" strokeWidth={1} className={styles.pkKnurl} />
        <g className={cn(styles.keyTurn, on && styles.keyOn)}>
          <circle r="27" fill={`url(#${uid}-i)`} strokeWidth={w} className={styles.pkCapEdge} />
          <line y1="-24" y2="-9" strokeWidth={compact ? 9 : 7} strokeLinecap="round" className={styles.pkMarkGlow} />
          <line y1="-24" y2="-9" strokeWidth={compact ? 5 : 3.5} strokeLinecap="round" className={styles.pkMark} />
        </g>
      </svg>
    </button>
  );
}

/** One rotor: keys to step it, its glass window showing the neighbours, and
 *  a knurled thumbwheel that drags. It is a slider to assistive tech and the keyboard.
 *  `max` makes it end-stopped (rotor I, the volume); without it, it wraps. */
export const Rotor = memo(function Rotor({
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
});

/** Rotor II or III, whose position the clock steps. */
export const MachineRotor = memo(function MachineRotor({
  store,
  which,
  name,
  label,
  onTurn,
}: {
  store: MachineStore;
  which: keyof Rotors;
  name: string;
  label: string;
  onTurn: (which: keyof Rotors, to: number) => void;
}) {
  const value = useMachine(store, s => s.msg.rotors[which]);
  return <Rotor name={name} label={label} value={value} onChange={v => onTurn(which, v)} />;
});

/** The rotor readout, e.g. "rotors 18 · K · Q". */
export const RotorReadout = memo(function RotorReadout({ store, vol }: { store: MachineStore; vol: number }) {
  const middle = useMachine(store, s => s.msg.rotors.middle);
  const right = useMachine(store, s => s.msg.rotors.right);
  return <>{`rotors ${volGlyph(vol)} · ${chr(middle)} · ${chr(right)}`}</>;
});

/** One bulb. Each reads only whether it is lit, so a new letter re-renders
 *  the two bulbs that change rather than the board. The lit fill and its
 *  brighter highlight fade as one layer over the unlit highlight, which the
 *  opaque fill hides: one opacity change where there were two. */
const Lamp = memo(function Lamp({ store, c }: { store: MachineStore; c: string }) {
  const on = useMachine(store, s => litOf(s) === c);
  return (
    <div className={cn(styles.lampCell, on && styles.lampOn)}>
      <div className={styles.lamp}>
        <div className={styles.lampGlow} />
        <div className={styles.lampBase} />
        <div className={styles.lampGlass}>
          <div className={styles.lampSpec} />
          <div className={styles.lampFill}>
            <div className={styles.lampSpec} />
          </div>
        </div>
        <div className={styles.lampRim}>{c}</div>
      </div>
    </div>
  );
});

/** The lampboard: one smoked bulb per letter behind the glass. Decorative —
 *  the tape says in words what the bulbs spell. */
export const Lampboard = memo(function Lampboard({ store }: { store: MachineStore }) {
  return (
    <div aria-hidden="true" className="flex flex-col items-center">
      {ROWS.map(row => (
        <div key={row} className="flex">
          {Array.from(row, c => <Lamp key={c} store={store} c={c} />)}
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

/** One letter key; it reads only whether it is held. */
const CapKey = memo(function CapKey({ store, c, keys }: { store: MachineStore; c: string; keys: KeyHandlers }) {
  const down = useMachine(store, s => s.down === c);
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={c}
      data-cipher-key=""
      data-down={down ? '' : undefined}
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
  );
});

/** The three rows of letter keys, round dark caps. They sit outside the tab
 *  order (the physical keyboard types the same letters) but stay buttons for
 *  assistive tech, which clicks them with detail 0. */
export const KeyRows = memo(function KeyRows({ store, keys }: { store: MachineStore; keys: KeyHandlers }) {
  return (
    <>
      {ROWS.map(row => (
        <div key={row} className="flex">
          {Array.from(row, c => <CapKey key={c} store={store} c={c} keys={keys} />)}
        </div>
      ))}
    </>
  );
});

/** A rectangular key on its body. `drop` (a Tailwind `[--drop:…]` class in
 *  className) is how deep it stands and how far it travels, down the 30°
 *  axis. Latched keys sit down for good; `lit` glows the face in the accent. */
export function BlockKey({
  latched,
  lit,
  dead,
  down,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  latched?: boolean;
  lit?: boolean;
  /** Printed in the muted ink: nothing to act on yet. */
  dead?: boolean;
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
 *  letters. Words stay whole across a wrap. It reads only what changes its
 *  own characters: the title sits still while the artist is spelled, and the
 *  sweep's seed stops mattering once every letter has resolved. */
export const TapeChars = memo(function TapeChars({
  store,
  text,
  base,
}: {
  store: MachineStore;
  text: string;
  /** Where this text starts in the lampboard sequence. */
  base: number;
}) {
  const chars = Array.from(text);
  const n = chars.length;
  const hot = useMachine(store, s => {
    const i = s.frame.cursor - base;
    return i >= 0 && i < n ? i : -1;
  });
  const resolved = useMachine(store, s => Math.floor(s.frame.scramble * n));
  const seed = useMachine(store, s => (Math.floor(s.frame.scramble * n) < n ? s.frame.seed : 0));
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
                <span key={j} className={j === hot ? styles.hot : undefined}>{c}</span>
              );
            })}
          </span>
        </span>
      ))}
    </>
  );
});

/** The DJ's line as far as the clock has typed it, the caret at its head. */
export const TapeTyped = memo(function TapeTyped({ store, text }: { store: MachineStore; text: string }) {
  const typed = useMachine(store, s => s.frame.talkN);
  const chars = Array.from(text);
  return (
    <span aria-hidden="true">
      “{chars.slice(0, typed).join('')}
      {typed >= chars.length ? '”' : <span className={styles.caret} aria-hidden="true" />}
    </span>
  );
});

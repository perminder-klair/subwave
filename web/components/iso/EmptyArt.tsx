import type { ReactNode } from 'react';
import { IsoBox } from './IsoBox';
import { boxFaces, hatchStrip, project } from './geometry';
import iso from './Iso.module.css';
import { cn } from '@/lib/cn';

// Small drawings for the admin's "nothing here yet" panels, in construction
// lines: a thing drawn but not yet built reads as "empty" without a word.
// Each is a still, server-safe SVG; the panel's own copy says what is missing.

export type EmptyArtKind = 'crate' | 'tapes' | 'calendar' | 'jack';

export function EmptyArt({ kind, className }: { kind: EmptyArtKind; className?: string }) {
  return (
    <svg
      viewBox="-96 -78 192 128"
      className={cn(iso.sheet, 'block h-auto overflow-visible', className)}
      aria-hidden="true"
      focusable="false"
    >
      <g className={cn(iso.pen, iso.penOff)}>{ART[kind]}</g>
    </svg>
  );
}

const shadow = (x: number, y: number, w: number, d: number) => (
  <path d={hatchStrip(x + w, x + w + 16, y + 4, y + d, 6)} strokeWidth={0.5} opacity={0.6} className={iso.solid} />
);

/** An empty record crate. */
function Crate() {
  const x = -40, y = -30, w = 80, d = 60, t = 4, wall = 34;
  return (
    <>
      {shadow(x, y, w, d)}
      <IsoBox x={x} y={y} z={0} w={w} d={d} h={3} />
      <IsoBox x={x} y={y} z={3} w={w} d={t} h={wall} />
      <IsoBox x={x} y={y + t} z={3} w={t} d={d - t * 2} h={wall} />
      <IsoBox x={x + w - t} y={y + t} z={3} w={t} d={d - t * 2} h={wall} />
      <IsoBox
        x={x}
        y={y + d - t}
        z={3}
        w={w}
        d={t}
        h={wall}
        left={<rect x={w / 2 - 12} y="8" width="24" height="7" rx="3.5" className={iso.fW} />}
      />
    </>
  );
}

/** A tape tray with every slot empty. */
function Tapes() {
  const x = -46, y = -24, w = 92, d = 48, h = 20;
  return (
    <>
      {shadow(x, y, w, d)}
      <IsoBox
        x={x}
        y={y}
        z={0}
        w={w}
        d={d}
        h={h}
        top={[0, 1, 2, 3].map(i => (
          <rect key={i} x={8 + i * 20} y="8" width="14" height={d - 16} className={iso.fW} />
        ))}
        left={<path d={`M8 ${h - 6}H${w - 8}`} strokeWidth={0.5} opacity={0.6} />}
      />
    </>
  );
}

/** A desk calendar on a blank month. */
function Calendar() {
  const x = -36, y = -6, w = 72, d = 14, h = 62;
  const rings = [16, 36, 56].map(o => project(x + o, y + 2, h + 4));
  // It stands tall, so it sits lower in the frame than the flat drawings.
  return (
    <g transform="translate(0 26)">
      {shadow(x, y, w, d)}
      <IsoBox
        x={x}
        y={y}
        z={0}
        w={w}
        d={d}
        h={h}
        left={
          <>
            <rect x="0" y="0" width={w} height="12" className={cn(iso.fInk, iso.ns)} />
            <path
              d={[22, 32, 42, 52].map(r => `M6 ${r}H${w - 6}`).join('') + [18, 30, 42, 54].map(c => `M${c} 18V56`).join('')}
              strokeWidth={0.4}
              opacity={0.7}
            />
          </>
        }
      />
      {rings.map(([cx, cy], i) => (
        <ellipse key={i} cx={cx} cy={cy} rx="2.6" ry="4.2" strokeWidth={1} className={cn(iso.fNone, iso.solid)} />
      ))}
    </g>
  );
}

/** A patch panel with nothing plugged in, its lead lying loose. */
function Jack() {
  const x = -52, y = -26, w = 74, d = 22, h = 34;
  const floor = boxFaces({ x: -200, y: -200, z: 0, w: 400, d: 400, h: 0 }).T;
  return (
    <>
      {shadow(x, y, w, d)}
      <IsoBox
        x={x}
        y={y}
        z={0}
        w={w}
        d={d}
        h={h}
        left={[14, 32, 50].map(cx => (
          <g key={cx}>
            <circle cx={cx} cy="15" r="5.5" className={iso.fW} />
            <circle cx={cx} cy="15" r="2" className={cn(iso.fInk, iso.ns)} />
          </g>
        ))}
      />
      {/* A patch lead lying in front, plugged into nothing */}
      <IsoBox x={-34} y={6} z={0} w={12} d={6} h={6} />
      <g transform={floor}>
        <path d="M178 209C196 226 212 204 230 221" strokeWidth={2.2} className={iso.solid} />
      </g>
      <IsoBox x={30} y={18} z={0} w={12} d={6} h={6} />
    </>
  );
}

const ART: Record<EmptyArtKind, ReactNode> = {
  crate: <Crate />,
  tapes: <Tapes />,
  calendar: <Calendar />,
  jack: <Jack />,
};

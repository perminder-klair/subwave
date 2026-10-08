'use client';

import type { ReactNode } from 'react';
import { IsoBox, InkFilter } from '../iso/IsoBox';
import { arrow, loop, project, round2 } from '../iso/geometry';
import iso from '../iso/Iso.module.css';
import { cn } from '@/lib/cn';
import styles from './DoctorRig.module.css';
import {
  RIG_PARTS,
  firstSectionOf,
  fixFirstPart,
  partOfSection,
  rigStates,
  sectionAnchor,
  type RigPartId,
  type RigState,
} from './doctor-rig';
import type { DoctorReport, DoctorReview, DoctorStatus } from './doctor-queries';

// DJ Doc's rig, drawn: the five parts its intro names, set out on one bench in
// the same order. The drawing is the status display. A part nobody has checked
// stays in construction lines, the one on the meter marches, a checked part
// inks in, and the one thing to fix first gets circled. The words live in the
// HTML key under the drawing, so they stay readable on a phone: each part's
// verdict, and which one to fix first. A key entry (or a click on its part in
// the drawing) jumps to that part's rows in the rundown below.

const BENCH_Z = 8;
/** How far above the bench every tag floats: clear of the tallest part. */
const TAG_LIFT = 128;
const SLOT = 74;
const Y0 = 12;

interface PartLayout {
  /** Footprint start along world x. */
  x: number;
  w: number;
  d: number;
  /** Height of the part's top above the bench, for the tag and the loop. */
  h: number;
}

const LAYOUT: Record<RigPartId, PartLayout> = {
  brain: { x: 14, w: 52, d: 52, h: 9 },
  crate: { x: 12 + SLOT, w: 56, d: 56, h: 44 },
  mix: { x: 12 + SLOT * 2, w: 58, d: 56, h: 70 },
  voice: { x: 12 + SLOT * 3 + 16, w: 24, d: 24, h: 92 },
  extras: { x: 12 + SLOT * 4, w: 56, d: 56, h: 84 },
};

const centre = (id: RigPartId, z: number) => {
  const l = LAYOUT[id];
  return project(l.x + l.w / 2, Y0 + l.d / 2, z);
};

const VERDICT: Record<RigState, string> = {
  idle: 'not checked',
  pending: 'waiting',
  measuring: 'on the meter',
  ok: 'clean',
  warn: 'warn',
  fail: 'fail',
  skip: 'skipped',
};

function verdictText(state: RigState, counts: Record<DoctorStatus, number>): string {
  if (state === 'warn') return `${counts.warn} warn`;
  if (state === 'fail') return `${counts.fail} fail`;
  return VERDICT[state];
}

/** A checked part draws in ink; everything else stays in construction lines. */
const inked = (s: RigState) => s === 'ok' || s === 'warn' || s === 'fail';

const shortName = (name: string) => name.replace(/^The /, '');

/** The key's status dot, matching the drawn tag's: ink for clean, filled
 *  accent for a failure, an accent ring for a warning or the part on the
 *  meter, a dashed ring for anything not yet checked. */
const KEY_DOT: Record<RigState, string> = {
  ok: 'bg-ink',
  fail: 'bg-[var(--accent)]',
  warn: 'border-[1.5px] border-[var(--accent)]',
  measuring: cn('border-[1.5px] border-[var(--accent)]', styles.pulse),
  idle: 'border border-dashed border-ink',
  pending: 'border border-dashed border-ink',
  skip: 'border border-dashed border-ink',
};

interface DoctorRigProps {
  report: DoctorReport | null;
  review: DoctorReview | null;
  running: boolean;
  className?: string;
}

export default function DoctorRig({ report, review, running, className }: DoctorRigProps) {
  const states = rigStates(report, running);
  const circled = fixFirstPart(report, review, states);
  const complete = !!report && !running && report.sections.length > 0;
  const allClean = complete && !circled && RIG_PARTS.every(p => states[p.id] === 'ok' || states[p.id] === 'skip');

  const counts = (id: RigPartId) => {
    const c: Record<DoctorStatus, number> = { ok: 0, warn: 0, fail: 0, skip: 0 };
    for (const s of report?.sections ?? []) {
      if (partOfSection(s.name) !== id) continue;
      for (const f of s.findings) c[f.status]++;
    }
    return c;
  };

  const jump = (id: RigPartId) => {
    const name = firstSectionOf(report, id);
    if (!name) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    document.getElementById(sectionAnchor(name))?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  };
  const interactive = complete;

  return (
    <div className={cn(iso.sheet, className)}>
      <svg viewBox="-84 -114 432 354" className="block h-auto w-full overflow-visible" aria-hidden="true">
        <defs>
          <InkFilter id="doctor-rig-wob" />
        </defs>

        {/* The bench everything stands on */}
        <g className={cn(iso.pen, report ? undefined : iso.penOff)}>
          <IsoBox x={0} y={0} z={0} w={SLOT * 5 + 8} d={80} h={BENCH_Z} />
        </g>

        {/* Every part's drawing first, back to front, then every tag on top,
            so a tall part in front never covers the tag of the one behind. */}
        {RIG_PARTS.map(p => (
          <g
            key={p.id}
            onClick={interactive ? () => jump(p.id) : undefined}
            className={cn(iso.pen, styles.pen, !inked(states[p.id]) && iso.penOff, states[p.id] === 'measuring' && styles.measuring, interactive && styles.live)}
          >
            <PartDrawing id={p.id} />
          </g>
        ))}
        {RIG_PARTS.map(p => (
          <Tag
            key={p.id}
            id={p.id}
            name={shortName(p.name)}
            state={states[p.id]}
            onActivate={interactive && firstSectionOf(report, p.id) ? () => jump(p.id) : undefined}
          />
        ))}

        {/* The inked layer: what to fix first, or a clean bill. */}
        <g filter="url(#doctor-rig-wob)" className={iso.ink} strokeWidth={1.6}>
          {circled && <FixFirst id={circled} />}
          {allClean && (
            <>
              <path d="M150 196l10 10 22-26" />
              <text x="190" y="210" fontSize={20} fontWeight={600} className={cn(iso.txAcc, iso.display)}>
                clean mix
              </text>
            </>
          )}
        </g>
      </svg>

      <ol aria-label="The station rig" className="m-0 mt-3 flex list-none flex-wrap justify-center gap-x-4 gap-y-1.5 p-0 font-mono text-[11px] tracking-[0.12em] uppercase">
        {RIG_PARTS.map(p => {
          const state = states[p.id];
          const entry = (
            <>
              <span aria-hidden="true" className={cn('size-2 flex-none rounded-full', KEY_DOT[state])} />
              <b>{shortName(p.name)}</b>
              <span className={state === 'warn' || state === 'fail' ? 'text-[var(--accent)]' : 'text-muted'}>
                {verdictText(state, counts(p.id))}
              </span>
              {circled === p.id && <span className="font-bold text-[var(--accent)]">· fix this first</span>}
            </>
          );
          return (
            <li key={p.id}>
              {interactive && firstSectionOf(report, p.id) ? (
                <button
                  type="button"
                  onClick={() => jump(p.id)}
                  className="flex cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 font-[inherit] tracking-[inherit] text-ink uppercase hover:text-[var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                >
                  {entry}
                  <span className="sr-only">, show its findings</span>
                </button>
              ) : (
                <span className="flex items-center gap-1.5">{entry}</span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function FixFirst({ id }: { id: RigPartId }) {
  const l = LAYOUT[id];
  const [cx, cy] = centre(id, BENCH_Z + l.h / 2);
  const rx = round2((l.w + l.d) * 0.5 + 10);
  const ry = round2(l.h / 2 + 30);
  const noteX = Math.max(-78, cx - 150);
  const noteY = Math.min(234, cy + ry + 44);
  return (
    <>
      <path d={loop(cx, cy, rx, ry)} />
      <path d={arrow(noteX + 90, noteY - 18, cx - 40, noteY - 20, cx - rx * 0.45, cy + ry * 0.8)} />
      <text x={noteX} y={noteY} fontSize={19} fontWeight={600} className={cn(iso.txAcc, iso.display)}>
        fix this first
      </text>
    </>
  );
}

interface TagProps {
  id: RigPartId;
  name: string;
  state: RigState;
  onActivate?: () => void;
}

/** A part's tag: a status dot and its name, with a leader down to the part.
 *  Its verdict is in the HTML key; once a report is in, a click on the tag
 *  jumps like the key's entry does. */
function Tag({ id, name, state, onActivate }: TagProps) {
  const l = LAYOUT[id];
  const [tx, topY] = centre(id, BENCH_Z + l.h);
  // Every tag sits the same height above the bench, so the tags step down
  // the diagonal evenly and never meet, whatever height their parts are.
  const [bx, by] = centre(id, BENCH_Z);
  const tagX = round2(bx - 12);
  const tagY = round2(by - TAG_LIFT);
  return (
    <g onClick={onActivate} className={cn(onActivate && styles.live)}>
      <line x1={tagX} y1={tagY + 16} x2={tx} y2={topY - 4} strokeWidth={0.6} className={cn(iso.sInk, styles.leader)} />
      <circle
        cx={tagX}
        cy={tagY - 3.5}
        r="3.6"
        strokeWidth={1.2}
        className={cn(
          state === 'ok' && cn(iso.fInk, iso.ns),
          state === 'fail' && cn(iso.fAcc, iso.ns),
          state === 'warn' && cn(iso.fBg, iso.sAcc),
          state === 'measuring' && cn(iso.fBg, iso.sAcc, styles.pulse),
          (state === 'idle' || state === 'pending' || state === 'skip') && cn(iso.fBg, iso.sInk, styles.hollow),
        )}
      />
      <text x={tagX + 8} y={tagY} fontSize={11} fontWeight={700} letterSpacing="0.16em" className={cn(iso.tx, iso.mono)}>
        {name.toUpperCase()}
      </text>
    </g>
  );
}

/** Each part's drawing, standing on the bench. */
function PartDrawing({ id }: { id: RigPartId }): ReactNode {
  const l = LAYOUT[id];
  const z = BENCH_Z;
  switch (id) {
    case 'brain': {
      const pins = [8, 18, 28, 38];
      return (
        <>
          {pins.map(o => <IsoBox key={`b${o}`} x={l.x + o} y={Y0 - 5} z={z} w={4} d={5} h={2.5} outline={false} />)}
          {pins.map(o => <IsoBox key={`l${o}`} x={l.x - 5} y={Y0 + o} z={z} w={5} d={4} h={2.5} outline={false} />)}
          <IsoBox
            x={l.x}
            y={Y0}
            z={z}
            w={l.w}
            d={l.d}
            h={l.h}
            topFill={iso.fInk}
            top={
              <>
                <rect x="8" y="8" width="36" height="36" strokeWidth={0.6} className={cn(iso.sBg, iso.fNone, iso.solid)} />
                <circle cx="13" cy="13" r="2" className={cn(iso.fAcc, iso.ns)} />
                <text x="26" y="30" fontSize={9} fontWeight={700} letterSpacing="0.12em" textAnchor="middle" className={cn(iso.txBg, iso.mono)}>
                  LLM
                </text>
              </>
            }
          />
          {pins.map(o => <IsoBox key={`f${o}`} x={l.x + o} y={Y0 + l.d} z={z} w={4} d={5} h={2.5} outline={false} />)}
          {pins.map(o => <IsoBox key={`r${o}`} x={l.x + l.w} y={Y0 + o} z={z} w={5} d={4} h={2.5} outline={false} />)}
        </>
      );
    }
    case 'crate': {
      const t = 4;
      const wall = 30;
      return (
        <>
          <IsoBox x={l.x} y={Y0} z={z} w={l.w} d={l.d} h={3} />
          <IsoBox x={l.x} y={Y0} z={z + 3} w={l.w} d={t} h={wall} />
          <IsoBox x={l.x} y={Y0 + t} z={z + 3} w={t} d={l.d - t * 2} h={wall} />
          {[0, 1, 2, 3].map(i => (
            <IsoBox key={i} x={l.x + 9 + i * 11} y={Y0 + 7} z={z + 3} w={3} d={l.d - 14} h={l.h - 3} outline={false} />
          ))}
          <IsoBox x={l.x + l.w - t} y={Y0 + t} z={z + 3} w={t} d={l.d - t * 2} h={wall} />
          <IsoBox
            x={l.x}
            y={Y0 + l.d - t}
            z={z + 3}
            w={l.w}
            d={t}
            h={wall}
            left={<rect x={l.w / 2 - 9} y="6" width="18" height="6" rx="3" className={iso.fW} />}
          />
        </>
      );
    }
    case 'mix': {
      const body = 22;
      const mast = project(l.x + l.w - 8, Y0 + 8, z + body);
      const tip = project(l.x + l.w - 8, Y0 + 8, z + l.h);
      return (
        <>
          <IsoBox
            x={l.x}
            y={Y0}
            z={z}
            w={l.w}
            d={l.d}
            h={body}
            top={
              <>
                {[14, 28, 42].map((y, i) => (
                  <g key={y}>
                    <line x1="8" y1={y} x2="44" y2={y} strokeWidth={1.4} className={iso.solid} />
                    <rect x={[14, 30, 22][i]} y={y - 4} width="7" height="8" className={i === 1 ? cn(iso.fAcc, iso.ns) : iso.fBg} />
                  </g>
                ))}
              </>
            }
            left={
              <text x="6" y="13" fontSize={6} fontWeight={700} letterSpacing="0.16em" className={cn(iso.tx, iso.mono)}>
                MIX · ON AIR
              </text>
            }
          />
          <line x1={mast[0]} y1={mast[1]} x2={tip[0]} y2={tip[1]} strokeWidth={1.4} className={iso.solid} />
          <circle cx={tip[0]} cy={tip[1]} r="2.6" className={cn(iso.fAcc, iso.ns)} />
        </>
      );
    }
    case 'voice': {
      const base = 4;
      const pole = 54;
      const top = project(l.x + l.w / 2, Y0 + l.d / 2, z + base + pole);
      const [mx, my] = top;
      return (
        <>
          <IsoBox x={l.x} y={Y0} z={z} w={l.w} d={l.d} h={base} />
          <IsoBox x={l.x + l.w / 2 - 2} y={Y0 + l.d / 2 - 2} z={z + base} w={4} d={4} h={pole} outline={false} />
          <rect x={round2(mx - 9)} y={round2(my - 34)} width="18" height="34" rx="9" strokeWidth={1.2} className={cn(iso.fBg, iso.solid)} />
          <path
            d={[8, 13, 18, 23].map(o => `M${round2(mx - 7)} ${round2(my - 34 + o)}H${round2(mx + 7)}`).join('')}
            strokeWidth={0.5}
          />
          <rect x={round2(mx - 9)} y={round2(my - 8)} width="18" height="5" className={iso.fW} />
        </>
      );
    }
    case 'extras':
      return (
        <IsoBox
          x={l.x}
          y={Y0}
          z={z}
          w={l.w}
          d={l.d}
          h={l.h}
          left={
            <>
              {[10, 24, 38].map(y => (
                <g key={y}>
                  <rect x="7" y={y} width="34" height="8" className={iso.fW} />
                  <circle cx="47" cy={y + 4} r="2" className={y === 10 ? cn(iso.fAcc, iso.ns) : iso.fBg} />
                </g>
              ))}
              <path d="M7 60H49M7 66H49M7 72H49" strokeWidth={0.4} opacity={0.6} />
            </>
          }
          right={<path d="M8 12H48M8 18H48M8 24H48" strokeWidth={0.5} opacity={0.6} />}
        />
      );
  }
}

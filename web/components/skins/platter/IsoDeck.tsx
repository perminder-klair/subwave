'use client';

// Platter's focus-mode deck: the turntable lifted into 30° isometric, with the
// facts the folded column carried set onto the things round it — the cover on
// the sleeve propped behind, the next record's sleeve in the crate behind
// that, the title on the plinth's nameplate, the clock on its side display,
// and progress as a ring of ticks round the platter that the tonearm tracks
// inward. Geometry is iso.ts; colour is theme tokens in Platter.module.css,
// except the record and its label, which are the same in every theme.

import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import styles from './Platter.module.css';
import { cn } from '@/lib/cn';
import { round2 } from '@/components/iso/geometry';
import { useDynamicStyle } from '@/hooks/useDynamicStyle';
import { useSvgTextFit } from '../sharedHooks';
import {
  ARM, DECK, PLATTER, RECORD, RECORD_LIFT, REST_POST, VIEWBOX, armAngle, armSwings, clip, ringTicks, type ArmPose,
} from './iso';

/** How long the arm keeps its ease after a swing starts: the 1.1 s swing in
 *  Platter.module.css, and a little to spare. */
const SWING_MS = 1300;

export interface IsoDeckProps {
  /** The record turns and the stylus is down. */
  playing: boolean;
  /** Where the arm is: parked, cueing while the stream locks, or playing. */
  arm: ArmPose;
  /** 0..1 through the track, null when the length is unknown. */
  ratio: number | null;
  stationName: string;
  title: string;
  artist: string;
  /** Artist · album · year, for the nameplate's second line. */
  detail: string;
  elapsed: string;
  duration: string;
  /** Tempo and key, beside the display. */
  facts: string[];
  coverUrl: string | null;
  next: { title: string; artist: string; coverUrl: string | null } | null;
  /** What the whole scene says, for a screen reader: it's one image. */
  label: string;
}

export default function IsoDeck(props: IsoDeckProps) {
  const { playing, arm, ratio, stationName, title, artist, detail, elapsed, duration, facts, coverUrl, next, label } = props;
  const uid = `pl-${useId().replace(/[^\w-]/g, '')}`;
  const ids = { sheen: `${uid}-sheen`, sleeve: `${uid}-sleeve`, next: `${uid}-next` };

  // The arm's angle rides a custom property, so the CSS transition can swing
  // it (an SVG transform attribute snaps), set on the arm alone: on the
  // deck's root, its change every second restyled the whole drawing. The ease
  // is on only while the arm swings; restarted by every second's creep, it
  // never came to rest, and WebKit repainted the arm on every frame.
  const armRef = useRef<SVGGElement | null>(null);
  const angle = armAngle(arm, ratio);
  const swinging = useArmSwing(arm, angle);
  useDynamicStyle(armRef, { '--arm': `${angle}deg` });

  // The clock's row is fitted too, but in a mono face it can only outgrow
  // its room when it gains a digit, so that is all the key follows of it.
  const rootRef = useRef<HTMLDivElement | null>(null);
  useSvgTextFit(rootRef, [title, detail, elapsed.length, duration, facts.join(' '), next?.title ?? '', next?.artist ?? ''].join('\n'));

  const ring = ringTicks(ratio);
  const rec = { x: PLATTER.cx - RECORD_LIFT, y: PLATTER.cy - RECORD_LIFT };
  const { plinth, plinthBox, sleeve, sleeveBox, nextSleeve, nextSleeveBox } = DECK;

  return (
    <div ref={rootRef} className={cn(styles.iso, 'absolute inset-0')}>
      <svg
        viewBox={String(VIEWBOX)}
        preserveAspectRatio="xMidYMid meet"
        className="absolute inset-0 block size-full overflow-visible"
        role="img"
        aria-label={label}
      >
        <defs>
          <linearGradient id={ids.sheen} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" className={styles.sheen0} />
            <stop offset="0.5" className={styles.sheen1} />
            <stop offset="1" className={styles.sheen0} />
          </linearGradient>
          <clipPath id={ids.sleeve}>
            <rect width={sleeveBox.w} height={sleeveBox.h} />
          </clipPath>
          <clipPath id={ids.next}>
            <rect width={nextSleeveBox.w} height={nextSleeveBox.h} />
          </clipPath>
        </defs>

        <g className={styles.pen}>
          <path d={DECK.shadow} className={styles.floorShadow} />

          {/* The crate: the next record's sleeve first, furthest back. */}
          <Sleeve
            of={nextSleeve}
            w={nextSleeveBox.w}
            h={nextSleeveBox.h}
            d={nextSleeveBox.d}
            clipId={ids.next}
            coverUrl={next?.coverUrl ?? null}
            blank={stationName}
          >
            {next && (
              <>
                <rect x="0" y="10" width={nextSleeveBox.w} height="24" className={cn(styles.fAcc, styles.ns)} />
                <text x="7" y="19.5" fontSize={5} fontWeight={700} letterSpacing="0.22em" className={cn(styles.txOn, styles.mono)}>
                  CUED NEXT
                </text>
                <text
                  data-fit={nextSleeveBox.w - 14}
                  x="7"
                  y="29"
                  fontSize={6.5}
                  fontWeight={700}
                  letterSpacing="0.04em"
                  className={cn(styles.txOn, styles.mono)}
                >
                  {clip([next.title, next.artist].filter(Boolean).join(' — '), 30)}
                </text>
              </>
            )}
          </Sleeve>

          {/* The record playing: its sleeve, propped against the deck. */}
          <Sleeve
            of={sleeve}
            w={sleeveBox.w}
            h={sleeveBox.h}
            d={sleeveBox.d}
            clipId={ids.sleeve}
            coverUrl={coverUrl}
            blank={stationName}
          />

          {DECK.feet.map((f, i) => (
            <g key={i}>
              <path d={f.sil} className={cn(styles.fInk, styles.solid)} strokeWidth={0.8} />
            </g>
          ))}

          {/* Plinth: the nameplate on its long face, the display on its short. */}
          <g transform={plinth.L}>
            <rect width={plinthBox.w} height={plinthBox.h} className={styles.fL} />
            <path d={`M10 ${plinthBox.h - 5}H${plinthBox.w - 10}`} strokeWidth={0.5} opacity={0.4} />
            <text
              data-fit={196}
              x="14"
              y="20"
              fontSize={15}
              fontWeight={800}
              className={cn(styles.tx, styles.display)}
            >
              {clip(title, 25)}
            </text>
            <text
              data-fit={196}
              x="14"
              y="31"
              fontSize={5.5}
              fontWeight={500}
              letterSpacing="0.16em"
              className={cn(styles.txMuted, styles.mono)}
            >
              {clip(detail.toUpperCase(), 46)}
            </text>
            {/* Speed keys, 45 latched, and the pilot lamp. */}
            <Key x={226} y={12} w={18} h={11} lit={false}>33</Key>
            <Key x={248} y={12} w={18} h={11} lit>45</Key>
            <circle cx="278" cy="17.5" r="3" strokeWidth={0.6} className={playing ? cn(styles.fAcc, styles.ns) : styles.fBg} />
            <text x="278" y="31" fontSize={4} fontWeight={700} letterSpacing="0.16em" textAnchor="middle" className={cn(styles.txMuted, styles.mono)}>
              ON
            </text>
          </g>
          <g transform={plinth.R}>
            <rect width={plinthBox.d} height={plinthBox.h} className={styles.fR} />
            <rect x="16" y="8" width="104" height="24" className={cn(styles.fInk, styles.ns)} />
            <text data-fit={46} x="22" y="26" fontSize={13} fontWeight={700} className={cn(styles.txBg, styles.mono)}>
              {elapsed}
            </text>
            <text data-fit={48} x="114" y="26" fontSize={6.5} fontWeight={500} textAnchor="end" className={cn(styles.txDim, styles.mono)}>
              / {duration.toUpperCase()}
            </text>
            {facts[0] && (
              <text data-fit={100} x="130" y="19" fontSize={6.5} fontWeight={700} letterSpacing="0.1em" className={cn(styles.tx, styles.mono)}>
                {facts[0]}
              </text>
            )}
            {facts.length > 1 && (
              <text data-fit={100} x="130" y="29" fontSize={5} fontWeight={500} letterSpacing="0.14em" className={cn(styles.txMuted, styles.mono)}>
                {facts.slice(1).join(' · ')}
              </text>
            )}
          </g>

          <g transform={plinth.T}>
            <rect width={plinthBox.w} height={plinthBox.d} className={styles.fT} />
            <text x={plinthBox.w - 12} y={plinthBox.d - 12} fontSize={6} fontWeight={800} letterSpacing="0.2em" textAnchor="end" className={cn(styles.txMuted, styles.mono)}>
              {stationName.toUpperCase()} · DIRECT DRIVE
            </text>

            <path d={ring.unlit} className={cn(styles.ringOff, styles.solid)} />
            <path d={ring.lit} className={cn(styles.ringLit, styles.solid)} />

            {/* Platter, then the record lying on it, turning in the plane. */}
            <Cylinder cx={PLATTER.cx} cy={PLATTER.cy} r={PLATTER.r} t={PLATTER.t} className={styles.fMat} />
            <Cylinder cx={PLATTER.cx - PLATTER.t} cy={PLATTER.cy - PLATTER.t} r={RECORD.r} t={RECORD.t} className={styles.vinylFill} side={styles.vinylFill} />
            <g transform={`translate(${rec.x} ${rec.y})`}>
              {/* Only the label's printing turns: the grooves and the
                  label's paper look the same at any angle, and WebKit
                  restyles and repaints every node of a turning SVG group on
                  the CPU, every frame. */}
              <Record />
              <g className={cn(styles.isoSpin, playing && styles.playing)}>
                <Label stationName={stationName} title={title} artist={artist} />
              </g>
              {/* A reflection stays put while the record turns under it. */}
              <path d={sector(RECORD.r - 4, 40, 200, 248)} fill={`url(#${ids.sheen})`} className={styles.ns} />
              <path d={sector(RECORD.r - 4, 40, 20, 58)} fill={`url(#${ids.sheen})`} opacity={0.6} className={styles.ns} />
              <circle r="2.3" strokeWidth={0.5} className={styles.spindle} />
            </g>

            {/* Tonearm: the rest post, the pivot standing up to the arm, the
                arm's shadow down on the record, and the arm above it. */}
            <Cylinder cx={REST_POST.x} cy={REST_POST.y} r={4} t={10} className={styles.fW} />
            <Cylinder cx={ARM.px} cy={ARM.py} r={13} t={3} className={styles.fW} />
            <Cylinder cx={ARM.px - 3} cy={ARM.py - 3} r={6} t={ARM.lift - 3} className={styles.fBg} />
            <g ref={armRef} className={cn(swinging && styles.armSwing)}>
              <g transform={`translate(${ARM.px - RECORD_LIFT} ${ARM.py - RECORD_LIFT})`}>
                <g className={cn(styles.isoArm, styles.armShadow)}>
                  <ArmShape shadow />
                </g>
              </g>
              <g transform={`translate(${ARM.px - ARM.lift} ${ARM.py - ARM.lift})`}>
                <g className={styles.isoArm}>
                  <ArmShape />
                </g>
              </g>
            </g>
          </g>

          <path d={plinth.sil} strokeWidth={1.5} className={styles.solid} />
        </g>
      </svg>
    </div>
  );
}

/** Whether the arm eases to its angle, from the move that swings it
 *  (armSwings) for as long as the swing takes; otherwise it steps. Decided
 *  during the render that moves it, so the ease lands in the same commit as
 *  the new angle and the transition catches it. */
function useArmSwing(pose: ArmPose, angle: number): boolean {
  const [prev, setPrev] = useState({ pose, angle });
  // Swings started and finished, counted, so one starting mid-swing restarts
  // the clock.
  const [started, setStarted] = useState(0);
  const [finished, setFinished] = useState(0);
  if (prev.pose !== pose || prev.angle !== angle) {
    setPrev({ pose, angle });
    if (armSwings(prev, { pose, angle })) setStarted(started + 1);
  }
  useEffect(() => {
    if (started === 0) return;
    const id = window.setTimeout(() => setFinished(started), SWING_MS);
    return () => window.clearTimeout(id);
  }, [started]);
  return started > finished;
}

/** A sleeve standing on the floor: its cover on the face toward the viewer,
 *  its edge and top as thin faces. With no cover to show, a plain sleeve with
 *  the station printed on it. */
function Sleeve({ of: b, w, h, d, clipId, coverUrl, blank, children }: {
  of: typeof DECK.sleeve;
  w: number;
  h: number;
  d: number;
  clipId: string;
  coverUrl: string | null;
  blank: string;
  children?: ReactNode;
}) {
  return (
    <>
      <g transform={b.T}><rect width={w} height={d} className={styles.fT} /></g>
      <g transform={b.R}><rect width={d} height={h} className={styles.fR} /></g>
      <g transform={b.L}>
        <rect width={w} height={h} className={styles.fSleeve} />
        {coverUrl ? (
          <image
            href={coverUrl}
            width={w}
            height={h}
            preserveAspectRatio="xMidYMid slice"
            clipPath={`url(#${clipId})`}
          />
        ) : (
          <>
            <circle cx={w / 2} cy={h / 2} r={w * 0.36} className={cn(styles.vinylFill, styles.ns)} />
            <circle cx={w / 2} cy={h / 2} r={w * 0.12} className={styles.labelPaper} />
            <text x={w / 2} y={h - 12} fontSize={7} fontWeight={800} letterSpacing="0.24em" textAnchor="middle" className={cn(styles.txMuted, styles.mono)}>
              {blank.toUpperCase()}
            </text>
          </>
        )}
        {children}
        <rect width={w} height={h} className={styles.fNone} />
      </g>
      <path d={b.sil} strokeWidth={1.2} className={styles.solid} />
    </>
  );
}

/** A key on the nameplate; latched, it stays lit. */
function Key({ x, y, w, h, lit, children }: { x: number; y: number; w: number; h: number; lit: boolean; children: ReactNode }) {
  return (
    <>
      <rect x={x} y={y} width={w} height={h} strokeWidth={0.6} className={lit ? styles.fInk : styles.fBg} />
      <text
        x={x + w / 2}
        y={y + h / 2 + 1.9}
        fontSize={5}
        fontWeight={700}
        textAnchor="middle"
        className={cn(lit ? styles.txBg : styles.tx, styles.mono)}
      >
        {children}
      </text>
    </>
  );
}

/** A round thing standing `t` proud of the plinth's top: its side band
 *  between the two tangents, the base's near arc beneath it, and the cap.
 *  Height off a top face goes toward (−1, −1) in the face's own units, which
 *  is what (x, y, z + t) projects to. */
function Cylinder({ cx, cy, r, t, className, side }: {
  cx: number;
  cy: number;
  r: number;
  t: number;
  className?: string;
  /** Fill for the side band, when it isn't the face's darker shade. */
  side?: string;
}) {
  const k = round2(r / Math.SQRT2);
  const tx = cx - t, ty = cy - t;
  const band = `M${round2(cx + k)} ${round2(cy - k)}L${round2(tx + k)} ${round2(ty - k)}`
    + `L${round2(tx - k)} ${round2(ty + k)}L${round2(cx - k)} ${round2(cy + k)}Z`;
  return (
    <>
      <circle cx={cx} cy={cy} r={r} className={side ?? styles.fR} />
      <path d={band} className={cn(side ?? styles.fR, styles.ns)} />
      <path d={`M${round2(cx + k)} ${round2(cy - k)}L${round2(tx + k)} ${round2(ty - k)}M${round2(tx - k)} ${round2(ty + k)}L${round2(cx - k)} ${round2(cy + k)}`} />
      <circle cx={tx} cy={ty} r={r} className={className} />
    </>
  );
}

/** The record's face about its centre: grooves, the gaps between tracks, and
 *  the label's paper, all of which look the same turned. */
function Record() {
  const grooves: number[] = [];
  for (let r = 40; r <= RECORD.r - 3; r += 3) grooves.push(r);
  return (
    <>
      {grooves.map(r => <circle key={r} r={r} className={styles.groove} />)}
      {[56, 71, 83].map(r => <circle key={r} r={r} className={styles.grooveGap} />)}
      <circle r="36.5" strokeWidth={1.4} className={cn(styles.fNone, styles.sAcc)} />
      <circle r="34" strokeWidth={0.6} className={styles.labelPaper} />
    </>
  );
}

/** What's printed on the label, which turns with the record. */
function Label({ stationName, title, artist }: { stationName: string; title: string; artist: string }) {
  return (
    <>
      <text y="-19" fontSize={4} fontWeight={700} letterSpacing="0.26em" textAnchor="middle" className={cn(styles.txAcc, styles.mono)}>
        {clip(stationName.toUpperCase(), 16)}
      </text>
      <text y="-8" fontSize={7.5} fontWeight={800} textAnchor="middle" className={cn(styles.labelInk, styles.display)}>
        {clip(title, 15)}
      </text>
      <text y="10.5" fontSize={3.4} fontWeight={500} letterSpacing="0.2em" textAnchor="middle" className={cn(styles.labelMuted, styles.mono)}>
        {clip(artist.toUpperCase(), 22)}
      </text>
      <text y="18.5" fontSize={3} fontWeight={500} letterSpacing="0.22em" textAnchor="middle" className={cn(styles.labelMuted, styles.mono)}>
        SIDE A · 45 RPM
      </text>
    </>
  );
}

/** The tonearm laid along +x from its pivot: counterweight behind, the tube,
 *  the headshell and its stylus. Its shadow is the same outline, filled. */
function ArmShape({ shadow = false }: { shadow?: boolean }) {
  const L = ARM.len;
  if (shadow) {
    return (
      <>
        <rect x="-24" y="-5" width="14" height="10" />
        <path d={`M0 0H${L - 16}`} strokeWidth={4} />
        <rect x={L - 18} y="-5" width="20" height="10" />
      </>
    );
  }
  return (
    <>
      <rect x="-24" y="-5" width="14" height="10" rx="1" strokeWidth={0.6} className={styles.fInk} />
      <path d={`M-10 0H${L - 16}`} strokeWidth={4} className={cn(styles.sInk, styles.solid)} />
      <path d={`M-10 0H${L - 16}`} strokeWidth={1.6} className={cn(styles.sTube, styles.solid)} />
      <circle r="4" strokeWidth={0.7} className={styles.fBg} />
      <rect x={L - 18} y="-5" width="20" height="10" rx="1" strokeWidth={0.6} className={styles.fHead} />
      <path d={`M${L} -3V3`} strokeWidth={1.4} className={cn(styles.sAcc, styles.solid)} />
    </>
  );
}

/** An annulus sector about the origin, for the record's reflection. */
function sector(r1: number, r0: number, a0: number, a1: number): string {
  const p = (r: number, a: number) => `${round2(Math.cos((a * Math.PI) / 180) * r)} ${round2(Math.sin((a * Math.PI) / 180) * r)}`;
  return `M${p(r0, a0)}L${p(r1, a0)}A${r1} ${r1} 0 0 1 ${p(r1, a1)}L${p(r0, a1)}A${r0} ${r0} 0 0 0 ${p(r0, a0)}Z`;
}

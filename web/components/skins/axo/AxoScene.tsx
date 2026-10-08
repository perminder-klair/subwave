'use client';

// The drawn stack. The switch, knob and keys in the drawing ARE the controls:
// power tunes in, the knob sets volume, MUTE mutes, REC opens a request, KEEP
// likes the track. One rAF loop moves what the music moves (reels, platter,
// tonearm, cones, sound lines) by writing attributes straight to the nodes;
// lite mode and reduced motion stop it outright and the render paints one
// still frame instead, since neither the CSS animation kill nor the media
// query can reach a JS loop.

import { useEffect, useId, useRef } from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode, RefObject } from 'react';
import styles from './Axo.module.css';
import { cn } from '@/lib/cn';
import { useAnalyser } from '@/lib/hooks';
import { AXO, VIEWBOX, arcOpacity, arcPath, armAngle, knobAngle, type DrawnBlock } from './geometry';
import { foldBpm, isPowered, type ListenPhase } from '../shared';

export interface AxoSceneProps {
  variant: 'desk' | 'mobile';
  phase: ListenPhase;
  /** The DJ is on the mic right now. */
  talk: boolean;
  muted: boolean;
  volume: number;
  /** 0..1 through the track, null when the duration is unknown. */
  ratio: number | null;
  /** Tape counter, MM:SS. */
  counter: string;
  /** Dial end-stop legend: the track length, or "live". */
  duration: string;
  lcd: string;
  tapeLabel: string;
  djName: string;
  bpm: number | null;
  /** Lite or reduced motion: paint a still frame, run no loop. */
  calm: boolean;
  audioRef: RefObject<HTMLAudioElement | null>;
  like: { available: boolean; liked: boolean; count: number; pending: boolean };
  /** The tune-in overlay is up: the whole drawing takes the tap. */
  gateTap: boolean;
  onGateTap: () => void;
  onPower: () => void;
  onMute: () => void;
  onVolume: (v: number) => void;
  onRequest: () => void;
  onLike: () => void;
}

const SPIN_REEL = 140; // °/s
const SPIN_PLATTER = 200; // °/s, about 33⅓ rpm

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Enter/Space activation for SVG nodes acting as buttons. */
function keyActivate(fn: () => void) {
  return (e: KeyboardEvent<SVGElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn();
    }
  };
}

/** Kick-drum period for the simulated level, folded into one comfortable
 *  octave of tempo. */
function beatSeconds(bpm: number | null): number {
  return 60 / foldBpm(bpm, 70, 150);
}

export default function AxoScene(props: AxoSceneProps) {
  const {
    variant, phase, talk, muted, volume, ratio, counter, duration, lcd, tapeLabel,
    djName, calm, audioRef, like, gateTap, onGateTap, onPower, onMute, onVolume,
    onRequest, onLike,
  } = props;
  const mob = variant === 'mobile';
  const rootRef = useRef<HTMLDivElement | null>(null);
  // useId's punctuation varies across React versions; keep url(#…) plain.
  const wobId = `axo-wob-${useId().replace(/[^\w-]/g, '')}`;

  const powered = isPowered(phase);
  const live = phase === 'live';
  const connecting = phase === 'connecting';
  const standby = phase === 'standby';
  const audible = live && !muted && volume > 0;

  // The loop reads the latest props without re-subscribing every render.
  const latest = useRef(props);
  latest.current = props;

  const { ready, read } = useAnalyser(audioRef, audible && !calm);
  const analyser = useRef({ ready, read });
  analyser.current = { ready, read };

  useEffect(() => {
    const root = rootRef.current;
    if (calm || !root) return;
    const all = <E extends Element>(sel: string) => Array.from(root.querySelectorAll<E>(sel));
    const spin = all<SVGGElement>('[data-spin]').map(el => ({ el, v: Number(el.dataset.spin) }));
    const cones = all<SVGGElement>('[data-cone]').map(el => ({ el, big: el.dataset.cone === 'big' }));
    const arcs = all<SVGPathElement>('[data-arc]').map(el => {
      const [s, k] = (el.dataset.arc ?? '0:0').split(':').map(Number);
      return { el, s: s ?? 0, k: k ?? 0 };
    });
    const arms = all<SVGGElement>('[data-arm]');
    const needles = all<SVGLineElement>('[data-needle]');
    const lcds = all<SVGTextElement>('[data-lcd]');
    const pulses = all<SVGCircleElement>('[data-pulse]');
    const boils = all<SVGFETurbulenceElement>('[data-boil]');

    let visible = true;
    const io = 'IntersectionObserver' in window
      ? new IntersectionObserver(es => { visible = es.some(e => e.isIntersecting); })
      : null;
    io?.observe(root);

    const t0 = performance.now();
    let last = t0;
    let ang = 0;
    let arm = armAngle('rest', null);
    let lv = 0;
    let vo = 0;
    let nextBoil = 0;
    let raf = 0;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (!visible) { last = now; return; }
      const p = latest.current;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const t = (now - t0) / 1000;
      const isLive = p.phase === 'live';
      const isTalk = isLive && p.talk;
      const loud = isLive && !p.muted && p.volume > 0;

      // Level: the real signal where the analyser can hear it, otherwise a
      // kick on the track's own tempo so the speakers still breathe.
      const kick = Math.exp(-((t / beatSeconds(p.bpm)) % 1) * 5);
      let target = 0;
      let real: number | null = null;
      if (loud) {
        const bins = analyser.current.ready ? analyser.current.read() : null;
        if (bins && bins.length) {
          const span = Math.max(4, Math.floor(bins.length / 8));
          let sum = 0;
          for (let i = 0; i < span; i++) sum += bins[i] ?? 0;
          if (sum > 0) real = clamp01((sum / span / 255) * 1.25);
        }
        if (real != null) {
          target = real;
        } else {
          target = Math.min(1, (0.3 + 0.5 * kick + 0.1 * Math.sin(t * 5.7) + Math.random() * 0.1)
            * (isTalk ? 0.4 : 1) * (0.5 + p.volume * 0.6));
        }
      }
      lv += (target - lv) * (target > lv ? 0.55 : 0.12);
      // A real signal already pumps; the simulated one needs the kick shape.
      const excite = loud ? (real != null ? lv : kick * lv) : 0;
      const vt = isTalk
        ? Math.abs(Math.sin(t * 8.5)) * (0.55 + 0.45 * Math.sin(t * 1.9)) * (0.7 + Math.random() * 0.3)
        : 0;
      vo += (vt - vo) * 0.3;

      if (isLive) ang += dt;
      for (const s of spin) s.el.setAttribute('transform', `rotate(${((ang * s.v) % 360).toFixed(1)})`);

      const armTarget = armAngle(isLive ? 'play' : p.phase === 'connecting' ? 'cue' : 'rest', p.ratio);
      arm += (armTarget - arm) * Math.min(1, dt * 1.6);
      for (const el of arms) el.setAttribute('transform', `rotate(${arm.toFixed(2)} 190 24)`);

      for (const c of cones) {
        c.el.setAttribute('transform', `scale(${(1 + excite * (c.big ? 0.1 : 0.05)).toFixed(3)})`);
      }

      const energy = isTalk ? Math.max(vo, lv * 0.6) : lv * 0.6;
      for (const a of arcs) {
        a.el.setAttribute('d', arcPath(a.s, a.k, energy));
        a.el.style.opacity = loud || isTalk ? arcOpacity(a.k, energy).toFixed(2) : '0';
      }

      if (p.phase === 'connecting') {
        const x = (16 + 104 * (0.5 + 0.5 * Math.sin(t * 1.7))).toFixed(1);
        for (const el of needles) { el.setAttribute('x1', x); el.setAttribute('x2', x); }
        for (const el of lcds) el.style.opacity = Math.floor(t * 2) % 2 === 0 ? '1' : '0.25';
      } else {
        for (const el of lcds) el.style.removeProperty('opacity');
      }

      for (const el of pulses) {
        if (p.phase === 'standby') {
          const ph = (t % 1.6) / 1.6;
          el.setAttribute('r', (10 + ph * 12).toFixed(1));
          el.style.opacity = ((1 - ph) * 0.9).toFixed(2);
        } else if (p.phase === 'connecting') {
          el.setAttribute('r', '12');
          el.style.opacity = (0.25 + 0.75 * Math.abs(Math.cos(t * Math.PI))).toFixed(2);
        } else {
          el.style.opacity = '0';
        }
      }

      // Line boil: re-seed the wobble in steps, quicker while the DJ talks.
      if (now > nextBoil) {
        for (const el of boils) el.setAttribute('seed', String(1 + Math.floor(Math.random() * 90)));
        nextBoil = now + (isTalk ? 220 : 520);
      }
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      io?.disconnect();
      // Hand every node back to the still frame the render paints.
      for (const s of spin) s.el.removeAttribute('transform');
      for (const c of cones) c.el.removeAttribute('transform');
      for (const a of arcs) a.el.style.removeProperty('opacity');
      for (const el of lcds) el.style.removeProperty('opacity');
      for (const el of pulses) el.style.removeProperty('opacity');
    };
  }, [calm]);

  // Still-frame values, used only while calm; otherwise the loop owns these
  // attributes and React must leave them alone (an undefined prop is never
  // written, so a one-second re-render can't snap the arm back).
  const staticArm = `rotate(${armAngle(live ? 'play' : connecting ? 'cue' : 'rest', ratio)} 190 24)`;
  const staticEnergy = talk && live ? 0.6 : audible ? 0.36 : 0;
  const needleX = (16 + 104 * (live ? (ratio ?? 0.5) : connecting ? 0.5 : 0)).toFixed(2);
  const needleOwned = calm || !connecting;
  const r = ratio ?? 0.5;
  const sigLit = live ? 4 : connecting ? 1 : 0;

  const drag = useRef<{ y: number; v: number } | null>(null);
  const setVol = (v: number) => onVolume(Math.round(clamp01(v) * 100) / 100);
  const knobDown = (e: PointerEvent<SVGCircleElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { y: e.clientY, v: volume };
  };
  const knobMove = (e: PointerEvent<SVGCircleElement>) => {
    if (drag.current) setVol(drag.current.v + (drag.current.y - e.clientY) / 160);
  };
  const knobUp = () => { drag.current = null; };
  const knobKey = (e: KeyboardEvent<SVGCircleElement>) => {
    const step = { ArrowUp: 0.05, ArrowRight: 0.05, ArrowDown: -0.05, ArrowLeft: -0.05 }[e.key];
    if (step != null) { e.preventDefault(); setVol(volume + step); }
    else if (e.key === 'Home') { e.preventDefault(); setVol(0); }
    else if (e.key === 'End') { e.preventDefault(); setVol(1); }
  };

  const likeLabel = like.available ? `♥ ${like.count}` : '♥';
  const canLike = like.available && !like.liked && !like.pending;

  return (
    <div ref={rootRef} className={cn(styles.scene, 'absolute inset-0')}>
      <svg
        viewBox={mob ? VIEWBOX.mobile : VIEWBOX.desk}
        preserveAspectRatio="xMidYMid meet"
        className="absolute inset-0 block size-full overflow-hidden"
        role="group"
        aria-label="Hi-fi stack: receiver, tape deck and turntable"
      >
        <defs>
          <filter id={wobId} x="-10%" y="-10%" width="120%" height="120%">
            <feTurbulence data-boil="" type="fractalNoise" baseFrequency="0.03" numOctaves={2} seed={2} result="n" />
            <feDisplacementMap in="SourceGraphic" in2="n" scale={1.8} xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </defs>

        <g className={cn(styles.draw, !powered && styles.drawOff)} aria-hidden="true">
          <path d={AXO.hatch} strokeWidth={0.5} opacity={0.5} />

          <Speaker block={AXO.spL} />

          <Post block={AXO.pBL} />
          <Post block={AXO.pBR} />

          <Shelf block={AXO.s0} />

          {/* Receiver */}
          <Face of={AXO.rcv} side="T" className={styles.fBg}>
            <path d="M14 20H206M14 28H206M14 36H206" strokeWidth={0.4} opacity={0.5} />
          </Face>
          <Face of={AXO.rcv} side="R" className={styles.fR} />
          <Face of={AXO.rcv} side="L" className={styles.fL}>
            <rect x="12" y="10" width="112" height="26" className={styles.fBg} />
            <path d={AXO.dialTicks} strokeWidth={0.6} className={styles.solid} />
            <text x="15" y="32" fontSize={5.5} fontWeight={500} className={cn(styles.tx, styles.mono)}>0:00</text>
            <text x="121" y="32" fontSize={5.5} fontWeight={500} textAnchor="end" className={cn(styles.tx, styles.mono)}>
              {duration}
            </text>
            <line
              data-needle=""
              x1={needleOwned ? needleX : undefined}
              x2={needleOwned ? needleX : undefined}
              y1="11"
              y2="35"
              strokeWidth={1.6}
              className={cn(styles.sAcc, styles.solid)}
            />
            <rect x="12" y="42" width="112" height="20" className={cn(styles.fInk, styles.ns)} />
            <text
              data-lcd=""
              x="17"
              y="55"
              fontSize={6.5}
              fontWeight={700}
              letterSpacing="0.12em"
              className={cn(styles.txBg, styles.mono)}
            >
              {lcd}
            </text>
            <text x="12" y="74" fontSize={5} fontWeight={500} letterSpacing="0.18em" className={cn(styles.txMuted, styles.mono)}>AXO-1</text>
            <text x="46" y="74" fontSize={4.5} fontWeight={700} letterSpacing="0.16em" className={cn(styles.tx, styles.mono)}>SIG</text>
            {AXO.sigBars.map((b, i) => (
              <rect
                key={b.x}
                x={b.x}
                y={b.y}
                width="2.6"
                height={b.h}
                strokeWidth={i < sigLit ? undefined : 0.4}
                className={i < sigLit ? cn(styles.fInk, styles.ns) : cn(styles.fNone, styles.solid)}
              />
            ))}
            <circle
              cx="90"
              cy="72.4"
              r="2.2"
              strokeWidth={0.5}
              className={live ? cn(styles.fAcc, styles.ns) : cn(styles.fBg, styles.solid)}
            />
            <text x="95" y="74" fontSize={4.5} fontWeight={700} letterSpacing="0.16em" className={cn(styles.tx, styles.mono)}>STEREO</text>

            <circle
              data-pulse=""
              cx="142"
              cy="24"
              r={calm ? (standby ? 13 : 12) : undefined}
              opacity={calm ? (standby || connecting ? 0.8 : 0) : undefined}
              strokeWidth={1.3}
              className={cn(styles.fNone, styles.sAcc, styles.solid)}
            />
            <circle cx="142" cy="24" r="9" className={styles.fW} />
            <path
              d="M138.82 20.82A4.5 4.5 0 1 0 145.18 20.82M142 18V23.5"
              strokeWidth={1.6}
              className={cn(powered ? styles.sAcc : styles.sInk, styles.solid)}
            />
            <text x="142" y="41" fontSize={5} fontWeight={700} letterSpacing="0.14em" textAnchor="middle" className={cn(styles.tx, styles.mono)}>
              POWER
            </text>

            <rect x="130" y="48" width="24" height="14" className={muted ? styles.fAcc : styles.fBg} />
            <text
              x="142"
              y="57.2"
              fontSize={5}
              fontWeight={700}
              letterSpacing="0.1em"
              textAnchor="middle"
              className={cn(muted ? styles.txOn : styles.tx, styles.mono)}
            >
              {muted ? 'MUTED' : 'MUTE'}
            </text>

            <path d={AXO.volTicks} strokeWidth={0.8} className={styles.solid} />
            <circle cx="186" cy="38" r="22" className={styles.fW} />
            <circle cx="186" cy="38" r="13" className={styles.fBg} />
            <g transform={`rotate(${knobAngle(volume).toFixed(1)} 186 38)`}>
              <line x1="186" y1="19" x2="186" y2="25" strokeWidth={2.4} className={cn(styles.sAcc, styles.solid)} />
            </g>
            <text x="186" y="75" fontSize={5} fontWeight={700} letterSpacing="0.14em" textAnchor="middle" className={cn(styles.tx, styles.mono)}>
              VOLUME
            </text>
          </Face>
          <path d={AXO.rcv.sil} strokeWidth={1.5} className={styles.solid} />

          <Shelf block={AXO.s1} />

          {/* Tape deck */}
          <Face of={AXO.tape} side="T" className={styles.fBg} />
          <Face of={AXO.tape} side="R" className={styles.fR} />
          <Face of={AXO.tape} side="L" className={styles.fL}>
            <rect x="12" y="8" width="110" height="46" className={styles.fW} />
            <rect x="18" y="12" width="98" height="38" className={styles.fBg} />
            {/* Tape packs: the left spool empties onto the right as the song plays. */}
            <circle cx="44" cy="34" r={(9 + 7 * (1 - r)).toFixed(2)} strokeWidth={0.5} className={styles.fL} />
            <circle cx="90" cy="34" r={(9 + 7 * r).toFixed(2)} strokeWidth={0.5} className={styles.fL} />
            <rect x="56" y="28" width="22" height="12" strokeWidth={0.5} />
            <rect x="24" y="14" width="86" height="9" strokeWidth={0.5} className={styles.fBg} />
            <text x="27" y="20.6" fontSize={5} fontWeight={700} letterSpacing="0.14em" className={cn(styles.tx, styles.mono)}>
              {tapeLabel}
            </text>
            <Reel cx={44} />
            <Reel cx={90} />
            <rect x="134" y="8" width="44" height="14" className={cn(styles.fInk, styles.ns)} />
            <text x="156" y="18" fontSize={8} fontWeight={700} letterSpacing="0.06em" textAnchor="middle" className={cn(styles.txBg, styles.mono)}>
              {counter}
            </text>
            <text x="186" y="18" fontSize={5} fontWeight={500} letterSpacing="0.16em" className={cn(styles.txMuted, styles.mono)}>TAPE</text>
            <rect x="134" y="30" width="44" height="16" className={styles.fBg} />
            <circle cx="143" cy="38" r="3" className={cn(styles.fAcc, styles.ns)} />
            <text x="149" y="40.4" fontSize={6.5} fontWeight={700} letterSpacing="0.16em" className={cn(styles.tx, styles.mono)}>REC</text>
            <text x="156" y="55" fontSize={5} fontWeight={700} letterSpacing="0.16em" textAnchor="middle" className={cn(styles.txAcc, styles.mono)}>
              REQUEST
            </text>
            <rect x="184" y="30" width="28" height="16" className={like.liked ? styles.fAcc : styles.fBg} />
            <text
              x="198"
              y="40.6"
              fontSize={6.5}
              fontWeight={700}
              textAnchor="middle"
              className={cn(like.liked ? styles.txOn : like.available ? styles.tx : styles.txMuted, styles.mono)}
            >
              {likeLabel}
            </text>
            <text
              x="198"
              y="55"
              fontSize={5}
              fontWeight={700}
              letterSpacing="0.16em"
              textAnchor="middle"
              className={cn(like.available ? styles.tx : styles.txMuted, styles.mono)}
            >
              KEEP
            </text>
          </Face>
          <path d={AXO.tape.sil} strokeWidth={1.5} className={styles.solid} />

          <Shelf block={AXO.s2} />

          {/* Turntable */}
          <path d={AXO.lid} strokeWidth={0.8} className={styles.fLid} />
          <path d={AXO.lidInner} strokeWidth={0.4} opacity={0.6} />
          <path d={AXO.lidGlint} strokeWidth={0.5} opacity={0.45} />
          <Face of={AXO.tt} side="L" className={styles.fL}>
            <text x="12" y="15" fontSize={5} fontWeight={500} letterSpacing="0.18em" className={cn(styles.txMuted, styles.mono)}>
              AXO-1 · DIRECT DRIVE · 33⅓
            </text>
          </Face>
          <Face of={AXO.tt} side="R" className={styles.fR} />
          <Face of={AXO.tt} side="T" className={styles.fBg}>
            <rect x="40" y="0" width="14" height="4" className={styles.fW} />
            <rect x="166" y="0" width="14" height="4" className={styles.fW} />
            <circle cx="96" cy="66" r="59" className={styles.fW} />
            <g transform="translate(96 66)">
              <g data-spin={SPIN_PLATTER}>
                <circle r="57" strokeWidth={1.6} strokeDasharray="0.8 2.6" strokeLinecap="butt" />
                <circle r="54" className={styles.fL} />
                <circle r="49" strokeWidth={0.35} />
                <circle r="45" strokeWidth={0.35} />
                <circle r="38" strokeWidth={0.7} />
                <circle r="33" strokeWidth={0.35} />
                <circle r="27" strokeWidth={0.7} />
                <circle r="23" strokeWidth={0.35} />
                <circle r="18" className={cn(styles.fAcc, styles.ns)} />
                <line x1="0" y1="-17" x2="0" y2="-7" strokeWidth={1.8} className={cn(styles.sBg, styles.solid)} />
                <line x1="0" y1="-54" x2="0" y2="-45" strokeWidth={1.4} className={styles.solid} />
              </g>
              <circle r="2" className={cn(styles.fInk, styles.ns)} />
            </g>
            <circle cx="182" cy="104" r="3.5" className={styles.fW} />
            <rect x="203" y="34" width="6" height="14" className={styles.fW} />
            <circle cx="190" cy="24" r="10" className={styles.fW} />
            <circle cx="190" cy="24" r="4" className={styles.fBg} />
            <g data-arm="" transform={calm ? staticArm : undefined}>
              <rect x="186" y="3" width="8" height="11" className={styles.fInk} />
              <line x1="190" y1="24" x2="190" y2="102" strokeWidth={3} />
              <line x1="190" y1="24" x2="190" y2="102" strokeWidth={1.2} className={cn(styles.sBg, styles.solid)} />
              <rect x="185" y="100" width="10" height="12" className={styles.fInk} />
            </g>
            <rect x="12" y="108" width="16" height="12" className={styles.fInk} />
            <text x="20" y="116.4" fontSize={5.5} fontWeight={700} textAnchor="middle" className={cn(styles.txBg, styles.mono)}>33</text>
            <rect x="32" y="108" width="16" height="12" className={styles.fBg} />
            <text x="40" y="116.4" fontSize={5.5} fontWeight={700} textAnchor="middle" className={cn(styles.tx, styles.mono)}>45</text>
          </Face>
          <path d={AXO.tt.sil} strokeWidth={1.5} className={styles.solid} />

          <Post block={AXO.pFL} />
          <Post block={AXO.pFR} />

          <Speaker block={AXO.spR} />
        </g>

        {/* The inked layer: sound lines, and notes only where they help. */}
        <g filter={`url(#${wobId})`} className={styles.ink} strokeWidth={mob ? 1.6 : 1.3} aria-hidden="true">
          {AXO.arcs.map(([s, k]) => (
            <path
              key={`${s}:${k}`}
              data-arc={`${s}:${k}`}
              d={calm ? arcPath(s, k, staticEnergy) : undefined}
              opacity={calm ? arcOpacity(k, staticEnergy) : undefined}
            />
          ))}
          {standby && <path d={AXO.loopPower} />}
          {standby && !mob && (
            <>
              <path d={AXO.arrowPress} />
              <text x="-238" y="212" fontSize={22} fontWeight={600} className={cn(styles.txAcc, styles.display)}>
                press to listen
              </text>
            </>
          )}
          {live && muted && !mob && (
            <>
              <path d={AXO.loopMute} />
              <path d={AXO.arrowMute} />
              <text x="-226" y="196" fontSize={18} fontWeight={600} className={cn(styles.txAcc, styles.display)}>
                you’re muted
              </text>
            </>
          )}
          {phase === 'offline' && <path d={AXO.crossLcd} />}
          {live && talk && (
            <g transform={mob ? 'translate(62 -150) rotate(-8) scale(0.9)' : 'translate(258 -322) rotate(-8)'}>
              <rect x="-54" y="-18" width="108" height="36" strokeWidth={1.6} />
              <rect x="-49" y="-13" width="98" height="26" strokeWidth={0.6} />
              <text y="6" fontSize={15} fontWeight={700} letterSpacing="0.22em" textAnchor="middle" className={cn(styles.txAcc, styles.mono)}>
                ON AIR
              </text>
              <text y="40" fontSize={15} fontWeight={600} textAnchor="middle" className={cn(styles.txAcc, styles.display)}>
                — {djName}
              </text>
            </g>
          )}
        </g>

        {/* With the tune-in overlay up, a tap anywhere on the drawing tunes in
            (oversized, so a letterboxed frame's margins count too). It sits
            beneath the controls, so each drawn key still does what it
            says and keeps its place in the tab order (power first). */}
        {gateTap && (
          <rect
            x="-4000"
            y="-4000"
            width="8000"
            height="8000"
            aria-hidden="true"
            onClick={onGateTap}
            className={styles.hit}
          />
        )}

        {/* Hit areas over the drawn controls. Each lives in its face's own
            matrix so it lines up with what's drawn, and reaches into the bare
            panel around its key: on a short landscape phone the drawing is
            small, and the key alone is under a fingertip. Where two overlap,
            the later one (the knob) wins. */}
        <g transform={AXO.rcv.L}>
          <circle
            cx="142"
            cy="24"
            r="24"
            role="button"
            tabIndex={0}
            aria-label={phase === 'offline' ? 'Power — station off air' : powered ? 'Power — tune out' : 'Power — tune in'}
            aria-disabled={phase === 'offline'}
            onClick={phase === 'offline' ? undefined : onPower}
            onKeyDown={phase === 'offline' ? undefined : keyActivate(onPower)}
            className={cn(styles.hit, phase === 'offline' && styles.hitOff)}
          />
          <rect
            x="104"
            y="46"
            width="56"
            height="34"
            role="button"
            tabIndex={0}
            aria-label={muted ? 'Unmute' : 'Mute'}
            aria-pressed={muted}
            onClick={onMute}
            onKeyDown={keyActivate(onMute)}
            className={styles.hit}
          />
          <circle
            cx="186"
            cy="38"
            r="34"
            role="slider"
            tabIndex={0}
            aria-label="Volume"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(volume * 100)}
            onPointerDown={knobDown}
            onPointerMove={knobMove}
            onPointerUp={knobUp}
            onPointerCancel={knobUp}
            onWheel={e => setVol(volume - Math.sign(e.deltaY) * 0.03)}
            onKeyDown={knobKey}
            className={cn(styles.hit, styles.knob)}
          />
        </g>
        <g transform={AXO.tape.L}>
          <rect
            x="124"
            y="22"
            width="54"
            height="40"
            role="button"
            tabIndex={0}
            aria-label="Request a song"
            onClick={onRequest}
            onKeyDown={keyActivate(onRequest)}
            className={styles.hit}
          />
          <rect
            x="178"
            y="20"
            width="42"
            height="42"
            role="button"
            tabIndex={like.available ? 0 : -1}
            aria-label={like.liked ? 'Kept — you liked this track' : 'Keep — like this track'}
            aria-pressed={like.liked}
            aria-disabled={!canLike}
            onClick={canLike ? onLike : undefined}
            onKeyDown={canLike ? keyActivate(onLike) : undefined}
            className={cn(styles.hit, !canLike && styles.hitOff)}
          />
        </g>
      </svg>
    </div>
  );
}

/** One face of a block: its plane, and a rect sized from the block filling it
 *  (top w × d, front-left w × h, front-right d × h), with whatever is drawn
 *  on it laid out in that plane. */
function Face({ of: b, side, className, children }: {
  of: DrawnBlock;
  side: 'T' | 'L' | 'R';
  className?: string;
  children?: ReactNode;
}) {
  const width = side === 'R' ? b.d : b.w;
  const height = side === 'T' ? b.d : b.h;
  return (
    <g transform={b[side]}>
      <rect width={width} height={height} className={className} />
      {children}
    </g>
  );
}

function Speaker({ block }: { block: DrawnBlock }) {
  return (
    <>
      <Face of={block} side="T" className={styles.fBg}>
        <rect x="8" y="8" width="64" height="84" strokeWidth={0.4} opacity={0.6} />
      </Face>
      <Face of={block} side="R" className={styles.fR} />
      <Face of={block} side="L" className={styles.fL}>
        <rect x="6" y="6" width="68" height="238" strokeWidth={0.4} />
        <circle cx="40" cy="36" r="10" className={styles.fBg} />
        <circle cx="40" cy="36" r="4" className={styles.fW} />
        <circle cx="40" cy="92" r="22" className={styles.fBg} />
        <g transform="translate(40 92)">
          <g data-cone="mid">
            <circle r="18" className={styles.fW} />
            <circle r="6" className={styles.fBg} />
          </g>
        </g>
        <circle cx="40" cy="178" r="34" className={styles.fBg} />
        <g transform="translate(40 178)">
          <g data-cone="big">
            <circle r="29" className={styles.fW} />
            <circle r="19" strokeWidth={0.4} />
            <circle r="10" className={styles.fBg} />
          </g>
        </g>
        <rect x="30" y="226" width="20" height="6" opacity={0.55} className={cn(styles.fInk, styles.ns)} />
      </Face>
      <path d={block.sil} strokeWidth={1.5} className={styles.solid} />
    </>
  );
}

function Shelf({ block }: { block: DrawnBlock }) {
  return (
    <>
      <Face of={block} side="T" className={styles.fBg} />
      <Face of={block} side="L" className={styles.fL} />
      <Face of={block} side="R" className={styles.fR} />
    </>
  );
}

/** A rack post: only its sides show, the shelves cover its ends. */
function Post({ block }: { block: DrawnBlock }) {
  return (
    <>
      <Face of={block} side="L" className={styles.fL} />
      <Face of={block} side="R" className={styles.fR} />
    </>
  );
}

function Reel({ cx }: { cx: number }) {
  return (
    <>
      <circle cx={cx} cy="34" r="8" className={styles.fBg} />
      <g transform={`translate(${cx} 34)`}>
        <g data-spin={SPIN_REEL}>
          <path d="M0 -3V-7M2.6 1.5L6.06 3.5M-2.6 1.5L-6.06 3.5" strokeWidth={1.2} className={styles.solid} />
          <circle r="3" strokeWidth={0.8} />
        </g>
      </g>
    </>
  );
}

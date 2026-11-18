'use client';

// The drawn stack. The switch, knob and keys in the drawing ARE the controls:
// power tunes in, the knob sets volume, MUTE mutes, REC opens a request, KEEP
// likes the track. It is drawn in pen at 30°: every box its three faces in
// the theme's paper shaded toward its ink, hairlines where faces meet and a
// heavier silhouette round each unit. Unpowered, the hairlines fall back to
// dashed construction lines in a faded pen, and tuning in inks them. One rAF
// loop moves what the music moves (reels, record, tonearm, cones, sound
// lines) by writing attributes straight to the nodes, and only the ones that
// changed (loop.ts); lite mode and reduced motion stop it outright and the
// render paints one still frame instead, since neither the CSS animation kill
// nor the media query can reach a JS loop. The drawing itself is memoised
// (Stack): the skin re-renders every second, and only the few parts that read
// the song's progress (TickCtx) re-render with it.

import { createContext, memo, useContext, useEffect, useId, useMemo, useRef, useSyncExternalStore } from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode, RefObject } from 'react';
import { Heart } from 'lucide-react';
import styles from './Axo.module.css';
import { cn } from '@/lib/cn';
import { useAnalyser } from '@/lib/hooks';
import { isIOSDevice } from '@/lib/platform';
import { round2 } from '@/components/iso/geometry';
import { AXO, LID_SHEET, VIEWBOX, arcOpacity, arcPath, armAngle, knobAngle, type DrawnBlock, type RackLevel } from './geometry';
import { TOUCH_FRAME_MS, createWriter, frameGate } from './loop';
import { ROW, SCREEN, SEGMENTS, screenLayout, type LidScreenInfo } from './screen';
import { foldBpm, isPowered, type ListenPhase } from '../shared';
import { useSvgTextFit } from '../sharedHooks';

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
  /** The display line; one longer than the window scrolls through it. */
  lcd: string;
  tapeLabel: string;
  djName: string;
  bpm: number | null;
  /** Lite or reduced motion: paint a still frame, run no loop. */
  calm: boolean;
  audioRef: RefObject<HTMLAudioElement | null>;
  like: { available: boolean; liked: boolean; count: number; pending: boolean };
  /** Focus mode: the dust cover is a screen carrying the now-playing card. */
  screen?: LidScreenInfo | null;
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

// The receiver's display window: how much of a line fits, as width and as
// characters. A longer line scrolls through the window the way an RDS
// display does — held, run across at a reading pace, held at its end — and
// a still frame ends it with an ellipsis instead.
const LCD_ROOM = 101;
const LCD_CHARS = 21;
const MARQUEE_HOLD = 2.2; // s
const MARQUEE_SPEED = 16; // units/s

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

const noSubscribe = () => () => {};

// The scene's gradients: a side panel receding, a top falling into the shadow
// of the shelf above, the contact shadow a unit leaves on its shelf, and the
// light a lit lamp spills. Ids are unique per mounted scene (desktop and
// mobile both render, so a fixed id would collide), and every part reads them
// from context.
const PAINTS = ['shade', 'fall', 'dropX', 'dropY', 'glow'] as const;
type PaintKey = (typeof PAINTS)[number];
type PaintIds = Record<PaintKey, string>;
const paintIds = (uid: string) => Object.fromEntries(PAINTS.map(k => [k, `${uid}-${k}`])) as PaintIds;
const url = (id: string) => `url(#${id})`;
const PaintCtx = createContext<PaintIds>(paintIds('axo'));

/** What changes every second while a song plays. Stack is memoised against
 *  it, so a tick re-renders only the parts that read this. */
interface Tick {
  ratio: number | null;
  counter: string;
  screen: LidScreenInfo | null;
}
const TickCtx = createContext<Tick>({ ratio: null, counter: '', screen: null });

function AxoScene(props: AxoSceneProps) {
  const { ratio, counter, screen = null, ...drawn } = props;
  const { phase, muted, volume, calm, audioRef } = drawn;
  const rootRef = useRef<HTMLDivElement | null>(null);
  // useId's punctuation varies across React versions; keep url(#…) plain.
  const uid = `axo-${useId().replace(/[^\w-]/g, '')}`;
  const paint = useMemo(() => paintIds(uid), [uid]);
  const screenIds = useMemo<ScreenIds>(() => ({
    clip: `${uid}-scrclip`, scan: `${uid}-scan`, bloom: `${uid}-bloom`, sweep: `${uid}-sweep`,
  }), [uid]);

  // The screen's rows are laid out by character budget; once drawn, any
  // still overflowing its window is squeezed. Its clock is never squeezed,
  // so a tick of it doesn't refit the rest.
  const screenText = screen
    ? [screen.eyebrow, screen.title, screen.artist, screen.detail, screen.foot?.text ?? ''].join('\n')
    : '';
  useSvgTextFit(rootRef, screenText);

  const audible = phase === 'live' && !muted && volume > 0;

  // The loop reads the latest props without re-subscribing every render.
  const latest = useRef(props);
  latest.current = props;

  const { ready, read } = useAnalyser(audioRef, audible && !calm);
  const analyser = useRef({ ready, read });
  analyser.current = { ready, read };

  useEffect(() => {
    const root = rootRef.current;
    if (calm || !root) return;
    // Every iPhone and iPad browser is WebKit, which repaints SVG on the CPU:
    // there the loop runs every other frame, and the platter's strobe ring
    // holds still.
    const touch = isIOSDevice();
    const all = <E extends Element>(sel: string) => Array.from(root.querySelectorAll<E>(sel));
    const spin = all<SVGGElement>('[data-spin]')
      .filter(el => !(touch && el.dataset.touchStill != null))
      .map(el => ({ el, v: Number(el.dataset.spin) }));
    const cones = all<SVGGElement>('[data-cone]').map(el => ({ el, big: el.dataset.cone === 'big' }));
    const arcs = all<SVGPathElement>('[data-arc]').map(el => {
      const [s, k] = (el.dataset.arc ?? '0:0').split(':').map(Number);
      return { el, s: s ?? 0, k: k ?? 0 };
    });
    const arms = all<SVGGElement>('[data-arm]');
    const needles = all<SVGLineElement>('[data-needle]');
    const lcds = all<SVGTextElement>('[data-lcd]');
    const marquees = lcds.map(el => ({ el, text: '', len: 0, measured: -Infinity, t0: 0 }));
    const pulses = all<SVGCircleElement>('[data-pulse]');
    const w = createWriter();
    const due = frameGate(touch ? TOUCH_FRAME_MS : 0);

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
    let raf = 0;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (!visible) { last = now; return; }
      if (!due(now)) return;
      const p = latest.current;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const t = (now - t0) / 1000;
      // The smoothing below is set per 60 Hz frame; this keeps its pace in
      // seconds at any frame rate.
      const ease = (k: number) => 1 - (1 - k) ** (dt * 60);
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
      lv += (target - lv) * ease(target > lv ? 0.55 : 0.12);
      // A real signal already pumps; the simulated one needs the kick shape.
      const excite = loud ? (real != null ? lv : kick * lv) : 0;
      const vt = isTalk
        ? Math.abs(Math.sin(t * 8.5)) * (0.55 + 0.45 * Math.sin(t * 1.9)) * (0.7 + Math.random() * 0.3)
        : 0;
      vo += (vt - vo) * ease(0.3);

      if (isLive) ang += dt;
      for (const s of spin) w.attr(s.el, 'transform', `rotate(${((ang * s.v) % 360).toFixed(1)})`);

      // The arm comes to rest on its mark. A playing arm's mark creeps a
      // hair each second, and chasing it to the hundredth of a degree kept
      // the arm repainting every frame of every song.
      const armTarget = armAngle(isLive ? 'play' : p.phase === 'connecting' ? 'cue' : 'rest', p.ratio);
      arm += (armTarget - arm) * Math.min(1, dt * 1.6);
      if (Math.abs(armTarget - arm) < 0.05) arm = armTarget;
      const armAt = `rotate(${arm.toFixed(1)} 190 24)`;
      for (const el of arms) w.attr(el, 'transform', armAt);

      for (const c of cones) {
        w.attr(c.el, 'transform', `scale(${(1 + excite * (c.big ? 0.1 : 0.05)).toFixed(3)})`);
      }

      // An unlit line keeps its old shape: nobody sees it.
      const energy = isTalk ? Math.max(vo, lv * 0.6) : lv * 0.6;
      for (const a of arcs) {
        const o = loud || isTalk ? arcOpacity(a.k, energy) : 0;
        w.style(a.el, 'opacity', o > 0 ? o.toFixed(2) : '0');
        if (o > 0) w.attr(a.el, 'd', arcPath(a.s, a.k, energy));
      }

      if (p.phase === 'connecting') {
        // The needle sweeps every frame while tuning, and outside it React
        // prints the needle's x, so a remembered write could be stale:
        // these go straight to the node.
        const x = (16 + 104 * (0.5 + 0.5 * Math.sin(t * 1.7))).toFixed(1);
        for (const el of needles) { el.setAttribute('x1', x); el.setAttribute('x2', x); }
        const blink = Math.floor(t * 2) % 2 === 0 ? '1' : '0.25';
        for (const el of lcds) w.style(el, 'opacity', blink);
      } else {
        for (const el of lcds) w.style(el, 'opacity', null);
      }

      for (const m of marquees) {
        // Re-measure on a new line, and now and then besides: the web font
        // may land after the first measure, and a tree that was hidden
        // measures zero.
        const text = m.el.textContent ?? '';
        if (text !== m.text) { m.text = text; m.t0 = t; m.measured = -Infinity; }
        if (t - m.measured > 3) { m.len = m.el.getComputedTextLength(); m.measured = t; }
        const over = m.len - LCD_ROOM;
        if (over <= 0) { w.attr(m.el, 'transform', null); continue; }
        const run = over / MARQUEE_SPEED;
        const u = (t - m.t0) % (MARQUEE_HOLD * 2 + run);
        const x = u < MARQUEE_HOLD ? 0 : Math.min(over, (u - MARQUEE_HOLD) * MARQUEE_SPEED);
        w.attr(m.el, 'transform', `translate(${(-x).toFixed(1)} 0)`);
      }

      for (const el of pulses) {
        if (p.phase === 'standby') {
          const ph = (t % 1.6) / 1.6;
          w.attr(el, 'r', (10 + ph * 12).toFixed(1));
          w.style(el, 'opacity', ((1 - ph) * 0.9).toFixed(2));
        } else if (p.phase === 'connecting') {
          w.attr(el, 'r', '12');
          w.style(el, 'opacity', (0.25 + 0.75 * Math.abs(Math.cos(t * Math.PI))).toFixed(2));
        } else {
          w.style(el, 'opacity', '0');
        }
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
      for (const el of lcds) {
        el.style.removeProperty('opacity');
        el.removeAttribute('transform');
      }
      for (const el of pulses) el.style.removeProperty('opacity');
    };
  }, [calm]);

  const tick = useMemo(() => ({ ratio, counter, screen }), [ratio, counter, screen]);

  return (
    <TickCtx.Provider value={tick}>
      <Stack {...drawn} rootRef={rootRef} uid={uid} paint={paint} screenIds={screenIds} focus={screen != null} />
    </TickCtx.Provider>
  );
}

export default memo(AxoScene);

/** What the drawing is drawn from: everything but what TickCtx carries. */
type StackProps = Omit<AxoSceneProps, 'ratio' | 'counter' | 'screen'> & {
  /** The scene's root, which the loop and the screen's fit search. */
  rootRef: RefObject<HTMLDivElement | null>;
  uid: string;
  paint: PaintIds;
  screenIds: ScreenIds;
  /** Focus mode: the cover is a screen, whose card TickCtx carries. */
  focus: boolean;
};

/** The drawing and the hit areas over its controls. */
const Stack = memo(function Stack(props: StackProps) {
  const {
    variant, phase, talk, muted, volume, duration, lcd, tapeLabel, djName, calm, like,
    gateTap, onGateTap, onPower, onMute, onVolume, onRequest, onLike, rootRef, uid, paint, screenIds, focus,
  } = props;
  const mob = variant === 'mobile';

  // False through SSR and hydration. `calm` can differ between the two (the
  // reduced-motion query only answers in the browser), so nothing printed
  // may hang off it until hydration is done.
  const hydrated = useSyncExternalStore(noSubscribe, () => true, () => false);

  const powered = isPowered(phase);
  const live = phase === 'live';
  const connecting = phase === 'connecting';
  const standby = phase === 'standby';
  const audible = live && !muted && volume > 0;

  // The sound lines' still frame, used only while calm; otherwise the loop
  // owns them and React must leave them alone.
  const staticEnergy = talk && live ? 0.6 : audible ? 0.36 : 0;
  const sigLit = live ? 4 : connecting ? 1 : 0;
  // The loop scrolls a long line; a still frame ends it with an ellipsis.
  const lcdStill = lcd.length > LCD_CHARS ? `${lcd.slice(0, LCD_CHARS - 1)}…` : lcd;

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

  // The KEEP legend: a heart and the count, centred as a pair on the key.
  const likeCount = like.available ? String(like.count) : '';
  const likeX = 198 - (6 + (likeCount ? 1.5 + likeCount.length * 3.9 : 0)) / 2;
  const likeInk = like.liked ? styles.icOn : like.available ? styles.icTx : styles.icMuted;
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
          <Paints ids={paint} />
          {focus && <ScreenDefs ids={screenIds} />}
        </defs>

        <PaintCtx.Provider value={paint}>
          <g className={cn(styles.draw, !powered && styles.drawOff)} aria-hidden="true">
            <path d={AXO.hatch} strokeWidth={0.5} opacity={0.5} />

            <Speaker block={AXO.spL} />

            <Bay level={AXO.rack[0]} />

            {/* Receiver */}
            <Face of={AXO.rcv} side="T" className={styles.fBg} shade="fall">
              <path d="M14 20H206M14 28H206M14 36H206" strokeWidth={0.4} opacity={0.5} />
            </Face>
            <Face of={AXO.rcv} side="R" className={styles.fR} shade="shade" />
            <Face of={AXO.rcv} side="L" className={styles.fL}>
              <Well id={`${uid}-dial`} x={12} y={10} w={112} h={26} t={2.5} className={styles.fBg}>
                <path d={AXO.dialTicks} strokeWidth={0.6} className={styles.solid} />
                <text x="15" y="34" fontSize={5.5} fontWeight={500} className={cn(styles.tx, styles.mono)}>0:00</text>
                <text x="121" y="34" fontSize={5.5} fontWeight={500} textAnchor="end" className={cn(styles.tx, styles.mono)}>
                  {duration}
                </text>
                <DialNeedle phase={phase} calm={calm} />
              </Well>
              <Well id={`${uid}-lcd`} x={12} y={42} w={112} h={20} t={2} className={styles.fInk}>
                <text data-lcd="" x="17" y="56" fontSize={6.5} fontWeight={700} letterSpacing="0.12em" className={cn(styles.txBg, styles.mono)}>
                  {hydrated && !calm ? lcd : lcdStill}
                </text>
              </Well>
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
              <Lamp cx={90} cy={72.4} r={2.2} lit={live} />
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
              <Boss on="L" cx={142} cy={24} r={9} t={3} className={styles.fW}>
                <path
                  d="M-3.18 -3.18A4.5 4.5 0 1 0 3.18 -3.18M0 -6V-0.5"
                  strokeWidth={1.6}
                  className={cn(powered ? styles.sAcc : styles.sInk, styles.solid)}
                />
              </Boss>
              <text x="142" y="41" fontSize={5} fontWeight={700} letterSpacing="0.14em" textAnchor="middle" className={cn(styles.tx, styles.mono)}>
                POWER
              </text>

              {/* A latching key: muted, it stays pressed in and lit. */}
              <Key on="L" x={130} y={48} w={24} h={14} t={muted ? 1 : 3} className={muted ? styles.fAcc : styles.fBg}>
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
              </Key>

              <path d={AXO.volTicks} strokeWidth={0.8} className={styles.solid} />
              {/* The knob: a flange, then a cap standing proud of it with the pointer on its face. */}
              <Boss on="L" cx={186} cy={38} r={22} t={2.5} className={styles.fW} />
              <Boss on="L" cx={183.5} cy={40.5} r={15} t={5} className={styles.fBg}>
                <g transform={`rotate(${knobAngle(volume).toFixed(1)})`}>
                  <line x1="0" y1="-13" x2="0" y2="-5" strokeWidth={2.4} className={cn(styles.sAcc, styles.solid)} />
                </g>
              </Boss>
              <text x="186" y="75" fontSize={5} fontWeight={700} letterSpacing="0.14em" textAnchor="middle" className={cn(styles.tx, styles.mono)}>
                VOLUME
              </text>
            </Face>
            <path d={AXO.rcv.sil} strokeWidth={1.5} className={styles.solid} />

            <Posts of={AXO.rack[0]} />
            <Bay level={AXO.rack[1]} />

            {/* Tape deck */}
            <Face of={AXO.tape} side="T" className={styles.fBg} shade="fall" />
            <Face of={AXO.tape} side="R" className={styles.fR} shade="shade" />
            <Face of={AXO.tape} side="L" className={styles.fL}>
              <Well id={`${uid}-tape`} x={12} y={8} w={110} h={46} t={3} className={styles.fW}>
                {/* The cassette sits in the well, its shell proud of the floor. */}
                <Key on="L" x={18} y={12} w={98} h={38} t={2} className={styles.fBg}>
                  <Spools />
                  <rect x="56" y="28" width="22" height="12" strokeWidth={0.5} />
                  <rect x="24" y="14" width="86" height="9" strokeWidth={0.5} className={styles.fBg} />
                  <text x="27" y="20.6" fontSize={5} fontWeight={700} letterSpacing="0.14em" className={cn(styles.tx, styles.mono)}>
                    {tapeLabel}
                  </text>
                  <Reel cx={44} />
                  <Reel cx={90} />
                </Key>
              </Well>
              <Well id={`${uid}-count`} x={134} y={8} w={44} h={14} t={1.5} className={styles.fInk}>
                <Counter />
              </Well>
              <text x="186" y="18" fontSize={5} fontWeight={500} letterSpacing="0.16em" className={cn(styles.txMuted, styles.mono)}>TAPE</text>
              <Key on="L" x={134} y={30} w={44} h={16} t={3} className={styles.fBg}>
                <circle cx="143" cy="38" r="3" className={cn(styles.fAcc, styles.ns)} />
                <text x="149" y="40.4" fontSize={6.5} fontWeight={700} letterSpacing="0.16em" className={cn(styles.tx, styles.mono)}>REC</text>
              </Key>
              <text x="156" y="55" fontSize={5} fontWeight={700} letterSpacing="0.16em" textAnchor="middle" className={cn(styles.txAcc, styles.mono)}>
                REQUEST
              </text>
              {/* Latching too: a kept track leaves KEEP pressed in and lit. */}
              <Key on="L" x={184} y={30} w={28} h={16} t={like.liked ? 1 : 3} className={like.liked ? styles.fAcc : styles.fBg}>
                <Heart
                  x={likeX}
                  y={35}
                  width={6}
                  height={6}
                  strokeWidth={3.5}
                  className={cn(styles.icon, likeInk, like.liked && styles.icFill)}
                />
                {likeCount && (
                  <text
                    x={likeX + 7.5}
                    y="40.6"
                    fontSize={6.5}
                    fontWeight={700}
                    className={cn(like.liked ? styles.txOn : styles.tx, styles.mono)}
                  >
                    {likeCount}
                  </text>
                )}
              </Key>
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

            <Posts of={AXO.rack[1]} />
            <Bay level={AXO.rack[2]} />

            {/* Turntable. The cover leans back past upright, wholly behind the
                plinth, so it goes down first and the plinth covers its foot. */}
            <DustCover powered={powered} ids={screenIds} />
            <Face of={AXO.tt} side="L" className={styles.fL}>
              <text x="12" y="15" fontSize={5} fontWeight={500} letterSpacing="0.18em" className={cn(styles.txMuted, styles.mono)}>
                AXO-1 · DIRECT DRIVE · 33⅓
              </text>
            </Face>
            <Face of={AXO.tt} side="R" className={styles.fR} shade="shade" />
            <Face of={AXO.tt} side="T" className={styles.fBg}>
              {/* The platter stands proud of the plinth and the record lies on
                  it. Only what looks different turned is turned (WebKit
                  repaints a turning node on the CPU every frame): the cylinder
                  sides, the grooves and the label stay put. On iOS so do the
                  strobe dots round the platter's rim, as a strobe's do at
                  speed; turning, they repainted the whole platter. */}
              <Boss on="T" cx={96} cy={66} r={58} t={5} className={styles.fW}>
                <g data-spin={SPIN_PLATTER} data-touch-still="">
                  <circle r="56.5" strokeWidth={1.6} strokeDasharray="0.8 2.6" strokeLinecap="butt" />
                </g>
              </Boss>
              <Boss on="T" cx={91} cy={61} r={53} t={1.5} className={styles.fL}>
                <circle r="49" strokeWidth={0.35} />
                <circle r="45" strokeWidth={0.35} />
                <circle r="38" strokeWidth={0.7} />
                <circle r="33" strokeWidth={0.35} />
                <circle r="27" strokeWidth={0.7} />
                <circle r="23" strokeWidth={0.35} />
                <circle r="18" className={cn(styles.fAcc, styles.ns)} />
                <g data-spin={SPIN_PLATTER}>
                  <line x1="0" y1="-17" x2="0" y2="-7" strokeWidth={1.8} className={cn(styles.sBg, styles.solid)} />
                  <line x1="0" y1="-53" x2="0" y2="-45" strokeWidth={1.4} className={styles.solid} />
                </g>
                <circle r="2" className={cn(styles.fInk, styles.ns)} />
              </Boss>
              <Key on="T" x={203} y={34} w={6} h={14} t={3} className={styles.fW} />
              <Boss on="T" cx={182} cy={104} r={3.5} t={7} className={styles.fW} />
              <Boss on="T" cx={190} cy={24} r={11} t={3} className={styles.fW} />
              <Boss on="T" cx={187} cy={21} r={4.5} t={6} className={styles.fBg} />
              <Tonearm phase={phase} calm={calm} />
              <Key on="T" x={12} y={108} w={16} h={12} t={2} className={styles.fInk}>
                <text x="20" y="116.4" fontSize={5.5} fontWeight={700} textAnchor="middle" className={cn(styles.txBg, styles.mono)}>33</text>
              </Key>
              <Key on="T" x={32} y={108} w={16} h={12} t={2} className={styles.fBg}>
                <text x="40" y="116.4" fontSize={5.5} fontWeight={700} textAnchor="middle" className={cn(styles.tx, styles.mono)}>45</text>
              </Key>
              {/* The pilot lamp: lit while the platter turns. */}
              <Lamp cx={57} cy={114} r={2.4} lit={live} />
            </Face>
            <path d={AXO.tt.sil} strokeWidth={1.5} className={styles.solid} />
            {AXO.hinges.map((h, i) => <Box key={i} block={h} />)}

            <Speaker block={AXO.spR} />
          </g>

          {/* The inked layer: the sound coming off the speakers, and the ON
              AIR stamp while the DJ is on the mic. */}
          <g className={styles.ink} strokeWidth={mob ? 1.6 : 1.3} aria-hidden="true">
            {AXO.arcs.map(([s, k]) => (
              <path
                key={`${s}:${k}`}
                data-arc={`${s}:${k}`}
                d={calm ? arcPath(s, k, staticEnergy) : undefined}
                opacity={calm ? arcOpacity(k, staticEnergy) : undefined}
              />
            ))}
            {live && talk && (
              <OnAirStamp djName={djName} transform={mob ? 'translate(250 -330) rotate(-8) scale(0.9)' : 'translate(258 -322) rotate(-8)'} />
            )}
          </g>
        </PaintCtx.Provider>

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
});

/** The dial's needle, where the song has got to. While tuning in the loop
 *  sweeps it, and React leaves its x alone. */
function DialNeedle({ phase, calm }: { phase: ListenPhase; calm: boolean }) {
  const { ratio } = useContext(TickCtx);
  const live = phase === 'live';
  const connecting = phase === 'connecting';
  const x = (16 + 104 * (live ? (ratio ?? 0.5) : connecting ? 0.5 : 0)).toFixed(2);
  const owned = calm || !connecting;
  return (
    <line
      data-needle=""
      x1={owned ? x : undefined}
      x2={owned ? x : undefined}
      y1="10"
      y2="38"
      strokeWidth={1.6}
      className={cn(styles.sAcc, styles.solid)}
    />
  );
}

/** The tape counter, in its window. */
function Counter() {
  const { counter } = useContext(TickCtx);
  return (
    <text x="156" y="18" fontSize={8} fontWeight={700} letterSpacing="0.06em" textAnchor="middle" className={cn(styles.txBg, styles.mono)}>
      {counter}
    </text>
  );
}

/** The tape packed on each spool: the left emptying onto the right as the
 *  song plays. */
function Spools() {
  const { ratio } = useContext(TickCtx);
  const r = ratio ?? 0.5;
  return (
    <>
      <circle cx="44" cy="34" r={(9 + 7 * (1 - r)).toFixed(2)} strokeWidth={0.5} className={styles.fL} />
      <circle cx="90" cy="34" r={(9 + 7 * r).toFixed(2)} strokeWidth={0.5} className={styles.fL} />
    </>
  );
}

/** The tonearm. It floats above the record, so its shadow lands a little
 *  below it; both swing on the same angle. The loop owns that angle, and a
 *  still frame prints it here: an undefined transform is never written, so
 *  a one-second re-render can't snap a moving arm back. */
function Tonearm({ phase, calm }: { phase: ListenPhase; calm: boolean }) {
  const { ratio } = useContext(TickCtx);
  const pose = phase === 'live' ? 'play' : phase === 'connecting' ? 'cue' : 'rest';
  const still = calm ? `rotate(${armAngle(pose, ratio)} 190 24)` : undefined;
  return (
    <>
      <g transform="translate(-3 -3)">
        <g data-arm="" transform={still} className={styles.shadow}>
          <line x1="190" y1="24" x2="190" y2="102" strokeWidth={3} />
          <rect x="185" y="100" width="10" height="12" />
        </g>
      </g>
      <g transform="translate(-9 -9)">
        <g data-arm="" transform={still}>
          <rect x="186" y="3" width="8" height="11" className={styles.fInk} />
          <line x1="190" y1="24" x2="190" y2="102" strokeWidth={3} />
          <line x1="190" y1="24" x2="190" y2="102" strokeWidth={1.2} className={cn(styles.sBg, styles.solid)} />
          <rect x="185" y="100" width="10" height="12" className={styles.fInk} />
        </g>
      </g>
    </>
  );
}

/** The scene's gradients. Light comes from above and a little to the left:
 *  a side panel deepens toward the back, a top tucked under the shelf above
 *  darkens toward it, each unit leaves a contact shadow on its shelf, and a
 *  lit lamp glows. */
function Paints({ ids }: { ids: PaintIds }) {
  const lin = (id: string, vertical: boolean, stops: Array<[number, string | undefined]>) => (
    <linearGradient id={id} x1="0" y1="0" x2={vertical ? 0 : 1} y2={vertical ? 1 : 0}>
      {stops.map(([o, c]) => <stop key={o} offset={o} className={c} />)}
    </linearGradient>
  );
  return (
    <>
      {lin(ids.shade, false, [[0, styles.shade0], [1, styles.shade1]])}
      {lin(ids.fall, true, [[0, styles.fall0], [1, styles.fall1]])}
      {lin(ids.dropX, false, [[0, styles.drop0], [1, styles.drop1]])}
      {lin(ids.dropY, true, [[0, styles.drop0], [1, styles.drop1]])}
      <radialGradient id={ids.glow}>
        <stop offset="0" className={styles.glow0} />
        <stop offset="1" className={styles.glow1} />
      </radialGradient>
    </>
  );
}

/** One face of a block: its plane, and a rect sized from the block filling it
 *  (top w × d, front-left w × h, front-right d × h), with whatever is drawn
 *  on it laid out in that plane. `shade` lays one of the scene's gradients
 *  over it — a side panel receding, a top falling into the shadow of the
 *  shelf above. */
function Face({ of: b, side, className, shade, children }: {
  of: DrawnBlock;
  side: 'T' | 'L' | 'R';
  className?: string;
  shade?: PaintKey;
  children?: ReactNode;
}) {
  const p = useContext(PaintCtx);
  const width = side === 'R' ? b.d : b.w;
  const height = side === 'T' ? b.d : b.h;
  return (
    <g transform={b[side]}>
      <rect width={width} height={height} className={className} />
      {shade && <rect width={width} height={height} fill={url(p[shade])} className={styles.ns} />}
      {children}
    </g>
  );
}

/** A whole small box: its three faces and silhouette. */
function Box({ block }: { block: DrawnBlock }) {
  return (
    <>
      <Face of={block} side="T" className={styles.fBg} />
      <Face of={block} side="L" className={styles.fL} />
      <Face of={block} side="R" className={styles.fR} />
      <path d={block.sil} strokeWidth={0.9} className={styles.solid} />
    </>
  );
}

/** Where height off a face goes in that face's own coordinates, per unit of
 *  world depth: out of a front panel toward (−1, 1), up off a top toward
 *  (−1, −1). Everything raised or sunk below is drawn with it. */
const OUT = { L: [-1, 1], T: [-1, -1] } as const;
type Surface = keyof typeof OUT;

/** A key standing `t` proud of its face. Of its four sides only the two
 *  turned toward the viewer show (a front panel's key: its top and right; a
 *  top's key: its front and right), and what's printed on it rides on its
 *  cap. A smaller `t` is a key held pressed in. */
function Key({ on, x, y, w, h, t, className, children }: {
  on: Surface;
  x: number;
  y: number;
  w: number;
  h: number;
  t: number;
  className?: string;
  children?: ReactNode;
}) {
  const dx = OUT[on][0] * t;
  const dy = OUT[on][1] * t;
  const edge = dy > 0 ? y : y + h;
  return (
    <>
      <path d={`M${x} ${edge}H${x + w}l${dx} ${dy}H${x + dx}Z`} strokeWidth={0.5} className={on === 'L' ? styles.fBg : styles.fL} />
      <path d={`M${x + w} ${y}V${y + h}l${dx} ${dy}V${y + dy}Z`} strokeWidth={0.5} className={styles.fR} />
      <g transform={`translate(${dx} ${dy})`}>
        <rect x={x} y={y} width={w} height={h} className={className} />
        {children}
      </g>
    </>
  );
}

/** A round boss — knob, button, platter, driver surround — standing `t`
 *  proud of its face: the side band between the two tangents, the base
 *  circle's near arc beneath it, and the cap on top. Children are laid out
 *  about the cap's centre. */
function Boss({ on, cx, cy, r, t, className, children }: {
  on: Surface;
  cx: number;
  cy: number;
  r: number;
  t: number;
  className?: string;
  children?: ReactNode;
}) {
  const [ox, oy] = OUT[on];
  const tx = round2(cx + ox * t);
  const ty = round2(cy + oy * t);
  // The tangents run at right angles to the way the cap moved off the base.
  const px = round2((-oy * r) / Math.SQRT2);
  const py = round2((ox * r) / Math.SQRT2);
  const a = `${round2(cx + px)} ${round2(cy + py)}`, b = `${round2(tx + px)} ${round2(ty + py)}`;
  const c = `${round2(tx - px)} ${round2(ty - py)}`, d = `${round2(cx - px)} ${round2(cy - py)}`;
  return (
    <>
      <circle cx={cx} cy={cy} r={r} className={styles.fR} />
      <path d={`M${a}L${b}L${c}L${d}Z`} className={cn(styles.fR, styles.ns)} />
      <path d={`M${a}L${b}M${c}L${d}`} />
      <g transform={`translate(${tx} ${ty})`}>
        <circle r={r} className={className} />
        {children}
      </g>
    </>
  );
}

/** A window sunk `t` into a front panel. Its floor shows shifted up and to
 *  the right; of its walls only the left and the bottom face the viewer.
 *  What sits in it lies on the floor, clipped to the opening. */
function Well({ id, x, y, w, h, t, className, children }: {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  t: number;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <>
      <clipPath id={id}>
        <rect x={x + t} y={y} width={w - t} height={h - t} />
      </clipPath>
      <rect x={x + t} y={y} width={w - t} height={h - t} className={cn(className, styles.ns)} />
      <g clipPath={`url(#${id})`}>
        <g transform={`translate(${t} ${-t})`}>{children}</g>
      </g>
      <path d={`M${x} ${y}H${x + t}V${y + h - t}L${x} ${y + h}Z`} strokeWidth={0.4} className={styles.fR} />
      <path d={`M${x} ${y + h}L${x + t} ${y + h - t}H${x + w}V${y + h}Z`} strokeWidth={0.4} className={styles.fBg} />
      <rect x={x} y={y} width={w} height={h} className={styles.fNone} />
    </>
  );
}

/** An indicator lamp; lit, it throws a little light on the panel round it. */
function Lamp({ cx, cy, r, lit }: { cx: number; cy: number; r: number; lit: boolean }) {
  const p = useContext(PaintCtx);
  return (
    <>
      {lit && <circle cx={cx} cy={cy} r={r * 3.2} fill={url(p.glow)} className={styles.ns} />}
      <circle
        cx={cx}
        cy={cy}
        r={r}
        strokeWidth={0.5}
        className={lit ? cn(styles.fAcc, styles.ns) : cn(styles.fBg, styles.solid)}
      />
    </>
  );
}

/** The ON AIR stamp, inked beside the stack, and whose mic it is. */
function OnAirStamp({ djName, transform }: { djName: string; transform: string }) {
  return (
    <g transform={transform}>
      <rect x="-54" y="-18" width="108" height="36" strokeWidth={1.6} />
      <rect x="-49" y="-13" width="98" height="26" strokeWidth={0.6} />
      <text y="6" fontSize={15} fontWeight={700} letterSpacing="0.22em" textAnchor="middle" className={cn(styles.txAcc, styles.mono)}>
        ON AIR
      </text>
      <text y="40" fontSize={15} fontWeight={600} textAnchor="middle" className={cn(styles.txAcc, styles.display)}>
        — {djName}
      </text>
    </g>
  );
}

/** The open dust cover, in smoked acrylic: every wall shows through the
 *  others. The panel faces away and is seen from inside, so it takes the
 *  faintest tint; the walls are seen edge-on through more of the plastic,
 *  and the one turned toward the viewer reads darkest. In focus mode the
 *  panel is a screen: it goes on the panel itself, so the walls still stand
 *  in front of its edges, and it takes the glint's place — those strokes run
 *  straight through the card's rows, and the lit glass reads as glass without
 *  them. */
function DustCover({ powered, ids }: { powered: boolean; ids: ScreenIds }) {
  const { screen } = useContext(TickCtx);
  const { lid } = AXO;
  return (
    <>
      <path d={lid.back} strokeWidth={0.4} className={styles.fLidWall} />
      <path d={lid.panel} strokeWidth={0.5} className={styles.fLid} />
      {screen
        ? <LidScreen screen={screen} powered={powered} ids={ids} />
        : <path d={lid.glint} strokeWidth={0.6} opacity={0.4} />}
      <path d={lid.left} strokeWidth={0.5} className={styles.fLidWall} />
      <path d={lid.front} strokeWidth={0.5} className={styles.fLidWall} />
      <path d={lid.right} strokeWidth={0.6} className={styles.fLidSide} />
      <path d={lid.rim} strokeWidth={0.9} />
      <path d={lid.sil} strokeWidth={1.3} className={styles.solid} />
    </>
  );
}

/** Ids of the screen's clip, scanlines, bloom and sweep, unique per scene. */
interface ScreenIds { clip: string; scan: string; bloom: string; sweep: string }

/** The glass the screen lights: the sheet's clear part, a hair inside the
 *  walls. The card itself keeps to SCREEN, within it. */
const GLASS = (() => {
  const { x0, y0, x1, y1 } = LID_SHEET.clear;
  return { x: x0 + 2, y: y0 + 2, w: x1 - x0 - 4, h: y1 - y0 - 4 };
})();

/** HUD corner marks round the glass: inked when lit, construction lines in
 *  standby, as everything unpowered is. */
const GLASS_CORNERS = (() => {
  const { x, y, w, h } = GLASS;
  const a = 7, x1 = x + w, y1 = y + h;
  return `M${x} ${y + a}V${y}H${x + a}M${x1 - a} ${y}H${x1}V${y + a}`
    + `M${x1} ${y1 - a}V${y1}H${x1 - a}M${x + a} ${y1}H${x}V${y1 - a}`;
})();

function ScreenDefs({ ids }: { ids: ScreenIds }) {
  return (
    <>
      <clipPath id={ids.clip}>
        <rect x={GLASS.x} y={GLASS.y} width={GLASS.w} height={GLASS.h} />
      </clipPath>
      {/* Scanlines in the sheet's own units, so they lean back with it. */}
      <pattern id={ids.scan} width="4" height="1.8" patternUnits="userSpaceOnUse">
        <line x1="0" y1="0.9" x2="4" y2="0.9" className={styles.scanLine} />
      </pattern>
      <linearGradient id={ids.sweep} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" className={styles.sweep0} />
        <stop offset="0.5" className={styles.sweep1} />
        <stop offset="1" className={styles.sweep0} />
      </linearGradient>
      {/* The bloom is an accent halo behind each legend, not a blur of the
          legend itself: a halo of the ink would read as a smudge on a pale
          theme, where one of the accent reads as light. */}
      <filter id={ids.bloom} x="-5%" y="-20%" width="110%" height="140%">
        <feGaussianBlur in="SourceAlpha" stdDeviation="1.1" result="blur" />
        <feFlood className={styles.bloomFlood} result="tint" />
        <feComposite in="tint" in2="blur" operator="in" result="halo" />
        <feMerge>
          <feMergeNode in="halo" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </>
  );
}

/** The now-playing card on the cover's panel, laid out flat by screen.ts and
 *  set into the panel's plane by LID_SHEET, so it leans back with the glass.
 *  Powered, the glass lights (tint, scanlines, a sweep as it comes on, the
 *  bloom); in standby the card stays printed in the faded pen. Every row
 *  that could run long carries data-fit, which the scene's measure reads. */
function LidScreen({ screen, powered, ids }: { screen: LidScreenInfo; powered: boolean; ids: ScreenIds }) {
  const L = screenLayout(screen);
  const { x, w } = SCREEN;
  const right = x + w;
  const pitch = L.bar.w / SEGMENTS;
  const lit = screen.ratio == null ? 0 : Math.round(screen.ratio * SEGMENTS);
  return (
    <g transform={LID_SHEET.transform}>
      <g clipPath={`url(#${ids.clip})`}>
        {powered && (
          <>
            <rect x={GLASS.x} y={GLASS.y} width={GLASS.w} height={GLASS.h} className={cn(styles.glass, styles.ns)} />
            <rect x={GLASS.x} y={GLASS.y} width={GLASS.w} height={GLASS.h} fill={`url(#${ids.scan})`} className={styles.ns} />
            <g className={styles.sweep}>
              <rect x={GLASS.x} y={GLASS.y - 26} width={GLASS.w} height={26} fill={`url(#${ids.sweep})`} className={styles.ns} />
            </g>
          </>
        )}
        {/* Keyed by the song, so a new one flickers on rather than swapping.
            The flicker rides a group round the bloom, not the bloomed group
            itself: restyling a filtered node re-runs its filter in WebKit,
            and the group's opacity lands after the filter either way. */}
        <g key={screen.title} className={styles.screenIn}>
          <g filter={powered ? `url(#${ids.bloom})` : undefined}>
            {screen.onAir && <circle cx={x + 2.2} cy={L.eyebrow.y - 2.3} r={2.2} className={cn(styles.fAcc, styles.ns)} />}
            <text
              data-fit={screen.onAir ? w - 7 : w}
              x={screen.onAir ? x + 7 : x}
              y={L.eyebrow.y}
              fontSize={ROW.eyebrow.size}
              fontWeight={700}
              letterSpacing={`${ROW.eyebrow.tracking}em`}
              className={cn(styles.txAcc, styles.mono)}
            >
              {L.eyebrow.text}
            </text>
            {L.title.rows.map(r => (
              <text
                key={r.y}
                data-fit={w}
                x={x}
                y={r.y}
                fontSize={L.title.size}
                fontWeight={800}
                className={cn(styles.tx, styles.display)}
              >
                {r.text}
              </text>
            ))}
            {L.artist && (
              <text
                data-fit={w}
                x={x}
                y={L.artist.y}
                fontSize={ROW.artist.size}
                fontWeight={700}
                letterSpacing={`${ROW.artist.tracking}em`}
                className={cn(styles.tx, styles.mono)}
              >
                {L.artist.text}
              </text>
            )}
            {L.detail && (
              <text
                data-fit={w}
                x={x}
                y={L.detail.y}
                fontSize={ROW.detail.size}
                fontWeight={500}
                letterSpacing={`${ROW.detail.tracking}em`}
                className={cn(styles.txMuted, styles.mono)}
              >
                {L.detail.text}
              </text>
            )}
            {Array.from({ length: SEGMENTS }, (_, i) => (
              <rect
                key={i}
                x={round2(L.bar.x + i * pitch)}
                y={L.bar.y}
                width={round2(pitch * 0.62)}
                height={L.bar.h}
                className={cn(i < lit ? styles.fAcc : styles.seg, styles.ns)}
              />
            ))}
            <text
              x={x}
              y={L.timeY}
              fontSize={ROW.time.size}
              fontWeight={700}
              letterSpacing={`${ROW.time.tracking}em`}
              className={cn(styles.tx, styles.mono)}
            >
              {screen.elapsed}
            </text>
            <text
              x={right}
              y={L.timeY}
              fontSize={ROW.time.size}
              fontWeight={500}
              letterSpacing={`${ROW.time.tracking}em`}
              textAnchor="end"
              className={cn(styles.txMuted, styles.mono)}
            >
              {screen.duration.toUpperCase()}
            </text>
            {L.foot?.kind === 'next' && (
              <text
                data-fit={w}
                x={x}
                y={L.foot.y}
                fontSize={ROW.next.size}
                letterSpacing={`${ROW.next.tracking}em`}
                className={styles.mono}
              >
                <tspan fontWeight={700} className={styles.txAcc}>NEXT</tspan>
                <tspan dx="4" fontWeight={500} className={styles.tx}>{L.foot.text}</tspan>
              </text>
            )}
            {L.foot?.kind === 'quote' && (
              <text data-fit={w} x={x} y={L.foot.y} fontSize={ROW.quote.size} fontWeight={500} className={cn(styles.tx, styles.display)}>
                {L.foot.text}
              </text>
            )}
          </g>
        </g>
      </g>
      <path d={GLASS_CORNERS} strokeWidth={0.9} className={cn(powered && styles.sAcc, powered && styles.solid)} />
    </g>
  );
}

/** A floor-standing speaker: the cabinet, a bevel round its baffle and its
 *  top, and the drivers set in the baffle. */
function Speaker({ block }: { block: DrawnBlock }) {
  return (
    <>
      <Face of={block} side="T" className={styles.fBg}>
        <rect x="8" y="8" width="64" height="84" strokeWidth={0.4} opacity={0.6} />
      </Face>
      <Face of={block} side="R" className={styles.fR} shade="shade" />
      <Face of={block} side="L" className={styles.fL}>
        <rect x="6" y="6" width="68" height="238" strokeWidth={0.4} />
        {/* Each driver: a surround standing off the baffle, and the cone
            sunk into it, its inner wall showing as a crescent. */}
        <Boss on="L" cx={40} cy={36} r={10} t={2} className={styles.fBg}>
          <Boss on="L" cx={0} cy={0} r={4} t={1.5} className={styles.fW} />
        </Boss>
        <Boss on="L" cx={40} cy={92} r={22} t={2.5} className={styles.fBg}>
          <circle r="18" strokeWidth={0.5} className={styles.fR} />
          <g transform="translate(1.4 -1.4)">
            <g data-cone="mid">
              <circle r="16.5" className={styles.fW} />
              <circle r="5.5" className={styles.fBg} />
            </g>
          </g>
        </Boss>
        <Boss on="L" cx={40} cy={178} r={34} t={3} className={styles.fBg}>
          <circle r="29" strokeWidth={0.5} className={styles.fR} />
          <g transform="translate(1.8 -1.8)">
            <g data-cone="big">
              <circle r="27" className={styles.fW} />
              <circle r="18" strokeWidth={0.4} />
              <circle r="9.5" className={styles.fBg} />
            </g>
          </g>
        </Boss>
        <rect x="30" y="226" width="20" height="6" opacity={0.55} className={cn(styles.fInk, styles.ns)} />
      </Face>
      <path d={block.sil} strokeWidth={1.5} className={styles.solid} />
    </>
  );
}

/** A shelf, with the contact shadow of the unit standing on it along the
 *  strips of it that show: in front of the unit and to its right. */
function Shelf({ block }: { block: DrawnBlock }) {
  const p = useContext(PaintCtx);
  return (
    <>
      <Face of={block} side="T" className={styles.fBg}>
        <rect x="10" y="142" width="220" height="6" fill={url(p.dropY)} className={styles.ns} />
        <rect x="230" y="10" width="6" height="138" fill={url(p.dropX)} className={styles.ns} />
      </Face>
      <Face of={block} side="L" className={styles.fL} />
      <Face of={block} side="R" className={styles.fR} />
    </>
  );
}

/** A rack post segment: only its sides show, the shelves cover its ends. */
function Post({ block }: { block: DrawnBlock }) {
  return (
    <>
      <Face of={block} side="L" className={styles.fL} />
      <Face of={block} side="R" className={styles.fR} />
    </>
  );
}

/** A shelf, then the back post segments standing on it — before the unit it
 *  carries, which hides most of them. */
function Bay({ level }: { level: RackLevel }) {
  return (
    <>
      <Shelf block={level.shelf} />
      {level.back.map((p, i) => <Post key={i} block={p} />)}
    </>
  );
}

/** A bay's front post segments, which stand in front of its unit. */
function Posts({ of: level }: { of: RackLevel }) {
  return level.front.map((p, i) => <Post key={i} block={p} />);
}

/** A cassette hub: three spokes in a ring. Only the spokes turn; the ring
 *  looks the same at any angle. */
function Reel({ cx }: { cx: number }) {
  return (
    <>
      <circle cx={cx} cy="34" r="8" className={styles.fBg} />
      <g transform={`translate(${cx} 34)`}>
        <g data-spin={SPIN_REEL}>
          <path d="M0 -3V-7M2.6 1.5L6.06 3.5M-2.6 1.5L-6.06 3.5" strokeWidth={1.2} className={styles.solid} />
        </g>
        <circle r="3" strokeWidth={0.8} />
      </g>
    </>
  );
}

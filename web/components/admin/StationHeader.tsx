'use client';

// Station Header — the unified "what's on air + is it healthy" card at the top
// of /admin/dash. One card: a now-playing title row (track, DJ, show, ON AIR,
// Skip) over a single status strip of four cells, left to right:
//   01 Listeners      — analog needle + vermilion peak-hold tick
//   02 DJ Latency     — analog needle, redlines past 3000 ms
//   03 TTS Fallback   — inverted linear bar (low = good)
//   04 On Air         — pilot lamp + stream bitrate, with weather + picker context
//
// This merges the old standalone health strip with the on-air hero so Listeners
// and On-Air are shown once, not twice. Instrument type follows data shape, like
// a real console. Built to the SUB/WAVE design system (square corners, mono
// numerals, one accent) through a Braun / Dieter Rams lens; all colour comes
// from theme tokens so it tracks light + dark.
//
// The meters animate via a single critically-damped (zeta≈1) rAF loop that
// writes straight to the DOM — no per-frame re-render. Structure + state styling
// live in globals.css under `.admin-root .hs-*`. Collapses under
// prefers-reduced-motion.
import { useEffect, useRef } from 'react';
import type { NowPlayingTrack } from '../../lib/types';
import { Btn } from './ui';

export interface HealthMetrics {
  /** current listeners */
  listeners: number;
  /** session peak listeners (authoritative, from the server) */
  listenersPeak: number;
  /** DJ think→speak p95 latency in ms, or null when unknown (stats not loaded) */
  latencyMs: number | null;
  /** TTS fallback rate as a percentage, or null when unknown */
  ttsFallbackPct: number | null;
  /** broadcast online? null before the first poll resolves */
  online: boolean | null;
  /** stream bitrate (kbps), or null when offline / unknown */
  bitrateKbps: number | null;
}

const SCALE = {
  listenersMax: 50,
  latencyMax: 5000,
  latencyRedline: 3000, // needle goes red past this
  ttsMidPct: 12, // fallback above this = caution (muted)
  ttsBadPct: 25, // fallback above this = redline
} as const;

// ── geometry: a gauge sweeps the TOP semicircle, t=0→left, t=1→right ──
const SVGNS = 'http://www.w3.org/2000/svg';
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const rad = (d: number) => (d * Math.PI) / 180;
const tToDeg = (t: number) => 180 - clamp(t, 0, 1) * 180;
const pol = (cx: number, cy: number, r: number, deg: number): [number, number] => [
  cx + r * Math.cos(rad(deg)),
  cy - r * Math.sin(rad(deg)),
];
function arcPath(cx: number, cy: number, r: number, d0: number, d1: number): string {
  const [x0, y0] = pol(cx, cy, r, d0);
  const [x1, y1] = pol(cx, cy, r, d1);
  const large = Math.abs(d1 - d0) > 180 ? 1 : 0;
  const sweep = d0 > d1 ? 1 : 0; // decreasing angle = over the top
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} ${sweep} ${x1} ${y1}`;
}

// gauge canvas constants (shared by the listeners + latency needles)
const G = { W: 150, H: 64, cx: 75, cy: 60, rArc: 52, rTickIn: 44, rTickOut: 52, needleLen: 46, tailLen: 10 };

// ── critically-damped spring (zeta = 1): eases, settles, NO overshoot ──
interface Spring {
  x: number;
  v: number;
}
function springStep(s: Spring, target: number, dt: number, omega: number): void {
  const a = omega * omega * (target - s.x) - 2 * omega * s.v;
  s.v += a * dt;
  s.x += s.v * dt;
}

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const n = document.createElementNS(SVGNS, tag);
  for (const k in attrs) n.setAttribute(k, String(attrs[k]));
  return n;
}

// Draw the static face of a gauge (arc, ticks, optional redline + peak tick),
// append a needle <g>, and return imperative handles the rAF loop drives.
function buildGauge(
  svg: SVGSVGElement,
  opts: { redlineFrom?: number | null; withPeak?: boolean } = {},
): { setNeedle: (t: number) => void; setPeak: (t: number) => void } {
  const { cx, cy, rArc, rTickIn, rTickOut, needleLen, tailLen } = G;
  svg.setAttribute('viewBox', `0 0 ${G.W} ${G.H}`);
  svg.replaceChildren();

  // base scale arc
  svg.appendChild(
    el('path', { d: arcPath(cx, cy, rArc, 180, 0), fill: 'none', stroke: 'var(--hs-arc)', 'stroke-width': 1.5 }),
  );
  // redline band on the outer edge
  if (opts.redlineFrom != null) {
    const d0 = tToDeg(opts.redlineFrom);
    svg.appendChild(
      el('path', { d: arcPath(cx, cy, rArc, d0, 0), fill: 'none', stroke: 'var(--danger)', 'stroke-width': 2.5 }),
    );
  }
  // ticks: 6 majors, a minor between each
  const majors = 5;
  for (let i = 0; i <= majors; i++) {
    const deg = tToDeg(i / majors);
    const [ax, ay] = pol(cx, cy, rTickIn - 3, deg);
    const [bx, by] = pol(cx, cy, rTickOut, deg);
    svg.appendChild(el('line', { x1: ax, y1: ay, x2: bx, y2: by, stroke: 'var(--hs-tick)', 'stroke-width': 1.4 }));
    if (i < majors) {
      const dm = tToDeg((i + 0.5) / majors);
      const [mx, my] = pol(cx, cy, rTickIn + 2, dm);
      const [nx, ny] = pol(cx, cy, rTickOut, dm);
      svg.appendChild(
        el('line', { x1: mx, y1: my, x2: nx, y2: ny, stroke: 'var(--hs-tick)', 'stroke-width': 0.8, opacity: 0.7 }),
      );
    }
  }
  // peak-hold tick (listeners only)
  let peak: SVGLineElement | null = null;
  if (opts.withPeak) {
    peak = el('line', {
      x1: cx,
      y1: cy - rTickIn,
      x2: cx,
      y2: cy - rTickOut - 2,
      stroke: 'var(--accent)',
      'stroke-width': 2.4,
    });
    svg.appendChild(peak);
  }
  // needle + hub
  const needle = el('g', {});
  needle.appendChild(
    el('line', { x1: cx, y1: cy, x2: cx, y2: cy - needleLen, stroke: 'var(--ink)', 'stroke-width': 2.2, 'stroke-linecap': 'round' }),
  );
  needle.appendChild(
    el('line', { x1: cx, y1: cy, x2: cx, y2: cy + tailLen, stroke: 'var(--ink)', 'stroke-width': 2.2, 'stroke-linecap': 'round' }),
  );
  svg.appendChild(needle);
  svg.appendChild(el('circle', { cx, cy, r: 3.4, fill: 'var(--ink)' }));

  return {
    setNeedle: (t: number) => needle.setAttribute('transform', `rotate(${90 - tToDeg(t)} ${cx} ${cy})`),
    setPeak: (t: number) => peak && peak.setAttribute('transform', `rotate(${90 - tToDeg(t)} ${cx} ${cy})`),
  };
}

export interface StationHeaderProps {
  metrics: HealthMetrics;
  np: NowPlayingTrack | null | undefined;
  djName: string;
  showName: string;
  weatherText: string;
  pickerBusy: boolean;
  busy: string | null;
  onSkip: () => void;
}

export default function StationHeader({
  metrics,
  np,
  djName,
  showName,
  weatherText,
  pickerBusy,
  busy,
  onSkip,
}: StationHeaderProps) {
  // Latest targets, read by the animation loop without re-subscribing.
  const targets = useRef(metrics);
  targets.current = metrics;

  // animated nodes (filled on mount)
  const listenersSvg = useRef<SVGSVGElement>(null);
  const latencySvg = useRef<SVGSVGElement>(null);
  const listenersV = useRef<HTMLSpanElement>(null);
  const peakV = useRef<HTMLElement>(null);
  const latencyV = useRef<HTMLSpanElement>(null);
  const latencyRead = useRef<HTMLDivElement>(null);
  const zone = useRef<HTMLDivElement>(null);
  const ttsV = useRef<HTMLSpanElement>(null);
  const ttsRead = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

    const lG = listenersSvg.current ? buildGauge(listenersSvg.current, { withPeak: true }) : null;
    const aG = latencySvg.current
      ? buildGauge(latencySvg.current, { redlineFrom: SCALE.latencyRedline / SCALE.latencyMax })
      : null;

    // needles power up from zero on load (instrument warm-up)
    const sListeners: Spring = { x: 0, v: 0 };
    const sLatency: Spring = { x: 0, v: 0 };
    const sTts: Spring = { x: 0, v: 0 };
    const sPeak: Spring = { x: 0, v: 0 };

    let raf = 0;
    let last = performance.now();

    const render = () => {
      const t = targets.current;

      // listeners
      lG?.setNeedle(sListeners.x / SCALE.listenersMax);
      lG?.setPeak(sPeak.x / SCALE.listenersMax);
      if (listenersV.current) listenersV.current.textContent = String(Math.round(sListeners.x));
      if (peakV.current) peakV.current.textContent = String(Math.round(sPeak.x));

      // latency
      aG?.setNeedle(sLatency.x / SCALE.latencyMax);
      const redlined = sLatency.x >= SCALE.latencyRedline;
      if (latencyV.current) latencyV.current.textContent = t.latencyMs == null ? '—' : String(Math.round(sLatency.x));
      latencyRead.current?.classList.toggle('warn', redlined);
      if (zone.current) {
        zone.current.textContent =
          t.latencyMs == null
            ? 'no data'
            : redlined
              ? 'redline'
              : sLatency.x > SCALE.latencyRedline * 0.8
                ? 'rising'
                : 'nominal';
      }

      // tts inverted bar
      const ttsPct = sTts.x;
      if (fill.current) {
        fill.current.className =
          ttsPct >= SCALE.ttsBadPct ? 'hs-fill bad' : ttsPct >= SCALE.ttsMidPct ? 'hs-fill mid' : 'hs-fill';
        fill.current.style.width = clamp(ttsPct, 0, 100) + '%';
      }
      if (ttsV.current)
        ttsV.current.textContent = t.ttsFallbackPct == null ? '—' : ttsPct.toFixed(ttsPct < 10 ? 1 : 0);
      ttsRead.current?.classList.toggle('warn', t.ttsFallbackPct != null && ttsPct >= SCALE.ttsBadPct);
    };

    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const t = targets.current;
      const lat = t.latencyMs ?? 0;
      const tts = t.ttsFallbackPct ?? 0;
      if (reduceMotion) {
        sListeners.x = t.listeners;
        sLatency.x = lat;
        sTts.x = tts;
        sPeak.x = t.listenersPeak;
      } else {
        springStep(sListeners, t.listeners, dt, 7);
        springStep(sLatency, lat, dt, 6);
        springStep(sTts, tts, dt, 7);
        springStep(sPeak, t.listenersPeak, dt, 9);
      }
      render();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const online = metrics.online === true;
  const offline = metrics.online === false;

  return (
    <section className="card border-ink">
      {/* now-playing header row */}
      <div className="stack-mobile grid grid-cols-[1fr_auto] items-center gap-6 border-b border-ink p-[18px]">
        <div>
          {np?.title ? (
            <>
              <div className="text-[18px] leading-[1.2] font-bold tracking-[-0.01em]">
                {np.title} <span className="font-semibold text-muted">— {np.artist}</span>
              </div>
              <div className="caption mt-1.5">
                {np.album ? `album · ${np.album} · ` : ''}DJ {djName} · {showName}
              </div>
            </>
          ) : (
            <div className="text-[22px] font-bold text-muted">nothing reported playing</div>
          )}
        </div>
        <div className="flex gap-2">
          <Btn lg tone="danger" disabled={!!busy || !np?.title} onClick={onSkip}>
            {busy === 'skip' ? 'skipping…' : 'Skip track'}
          </Btn>
        </div>
      </div>

      {/* unified status strip */}
      <div className="hs-strip">
        {/* 01 — listeners needle */}
        <div className="hs-cell">
          <div className="hs-head">
            <div className="hs-lbl">
              <span className="idx">01</span>Listeners
            </div>
          </div>
          <svg ref={listenersSvg} className="hs-gauge" />
          <div className="hs-read">
            <span className="hs-v" ref={listenersV}>
              0
            </span>
            <span className="hs-u">now</span>
            <span className="hs-x">
              peak <b ref={peakV}>0</b>
            </span>
          </div>
        </div>

        {/* 02 — DJ latency needle */}
        <div className="hs-cell">
          <div className="hs-head">
            <div className="hs-lbl">
              <span className="idx">02</span>DJ&nbsp;Latency
            </div>
            <div className="hs-sub" ref={zone}>
              nominal
            </div>
          </div>
          <svg ref={latencySvg} className="hs-gauge" />
          <div className="hs-read" ref={latencyRead}>
            <span className="hs-v" ref={latencyV}>
              0
            </span>
            <span className="hs-u">ms</span>
            <span className="hs-x">
              redline <b>{SCALE.latencyRedline / 1000}k</b>
            </span>
          </div>
        </div>

        {/* 03 — TTS fallback inverted bar */}
        <div className="hs-cell">
          <div className="hs-head">
            <div className="hs-lbl">
              <span className="idx">03</span>TTS&nbsp;Fallback
            </div>
            <div className="hs-sub">lower&nbsp;=&nbsp;better</div>
          </div>
          <div className="hs-barwrap">
            <div className="hs-track">
              <div className="hs-fill" ref={fill} />
              <div className="hs-mark" />
            </div>
            <div className="hs-scale">
              <span>0%</span>
              <span>50%</span>
              <span>100%</span>
            </div>
          </div>
          <div className="hs-read" ref={ttsRead}>
            <span className="hs-v" ref={ttsV}>
              0
            </span>
            <span className="hs-u">%&nbsp;fallback</span>
          </div>
        </div>

        {/* 04 — On Air pilot lamp + station context (weather · picker) */}
        <div className="hs-cell hs-lamp">
          <div className="hs-head">
            <div className="hs-lbl">
              <span className="idx">04</span>On&nbsp;Air
            </div>
            <div className="hs-sub">stream</div>
          </div>
          <div className="hs-lampbody">
            <div className={online ? 'hs-bulb hs-on' : 'hs-bulb'}>
              <span className="hs-ring" />
              <span className="hs-core" />
            </div>
            <div className="hs-lampmeta">
              <div className={online ? 'hs-state' : 'hs-state hs-off'}>
                {online ? 'Live' : offline ? 'Off Air' : '…'}
              </div>
              <div className="hs-rate">
                <b>{online && metrics.bitrateKbps != null ? metrics.bitrateKbps : '—'}</b> kbps
              </div>
            </div>
          </div>
          <div className="hs-lampctx">
            <div className="hs-ctxrow">
              <span className="hs-ctxk">weather</span>
              <span className="hs-ctxv">{weatherText}</span>
            </div>
            <div className="hs-ctxrow">
              <span className="hs-ctxk">picker</span>
              <span className={pickerBusy ? 'hs-ctxv hs-busy' : 'hs-ctxv'}>
                {pickerBusy ? 'thinking' : 'idle'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

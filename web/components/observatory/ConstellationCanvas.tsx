/* ============================================================================
   SUB/WAVE — Library Observatory · constellation (CANVAS renderer)
   The large-library renderer (auto-selected above ~3k nodes; see ObservatoryApp
   CANVAS_THRESHOLD). The bulk node + link layers are drawn to a single <canvas>
   in one pass per frame — no per-node DOM, so pan / zoom / filter / colour-by
   are a redraw (a few ms) instead of an O(n) React reconcile. Only the handful
   of *highlighted* elements (selection wiring, ripple, hover) live in a thin SVG
   overlay on top, where CSS theming and animation are easy.

   Draw is bucketed: nodes are grouped by quantised colour + alpha tier and each
   bucket fills one Path2D in a single call, so 50k nodes cost a few hundred fill
   calls, not 50k. Entrance fades nodes in from the centre (matching the SVG
   renderer); a MutationObserver repaints on light/dark theme switches so the
   canvas (which reads CSS vars manually) never goes stale.

   Coordinate model mirrors the SVG renderer exactly so the overlay aligns:
   a 1000×1000 user space is fit with `meet` letterboxing (S = min(W,H), centred),
   then the pan/zoom view {tx,ty,k} is applied in that 0..1000 space.
   Screen px = origin + (t + user·k)·f, where f = S/1000.
   ============================================================================ */
'use client';

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  buildSynapseLinks,
  nodeColor,
  nodeFilled,
  type ColorBy,
  type ObsTrack,
  type LibraryData,
} from './data';

interface Props {
  lib: LibraryData;
  matchSet: Set<number>;
  colorBy: ColorBy;
  selected: ObsTrack | null;
  neighbours: ObsTrack[];
  hovered: ObsTrack | null;
  onHover: (t: ObsTrack | null, e?: React.MouseEvent) => void;
  onSelect: (t: ObsTrack | null) => void;
}

interface View {
  k: number;
  tx: number;
  ty: number;
}

const TAU = Math.PI * 2;
const ENTRANCE_SPREAD = 620; // ms of stagger from centre to rim
const ENTRANCE_FADE = 450; // ms each node takes to fade+grow in
const ENTRANCE_TOTAL = ENTRANCE_SPREAD + ENTRANCE_FADE;

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);

// meet-fit transform for a given stage size: how 0..1000 maps to CSS px.
function fit(w: number, h: number) {
  const S = Math.min(w, h);
  return { S, ox: (w - S) / 2, oy: (h - S) / 2, f: S / 1000 };
}

// parse 'rgb(r,g,b)' or '#rgb'/'#rrggbb' → [r,g,b]
function parseRGB(c: string): [number, number, number] {
  if (c[0] === '#') {
    const h = c.slice(1);
    const n = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
    const v = parseInt(n, 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  const m = c.match(/\d+/g);
  return m && m.length >= 3 ? [Number(m[0]), Number(m[1]), Number(m[2])] : [74, 68, 61];
}
// quantise a colour so near-identical ramp shades share a draw bucket
function quantColor(c: string): string {
  const [r, g, b] = parseRGB(c);
  const q = (v: number) => Math.round(v / 10) * 10;
  return `rgb(${q(r)},${q(g)},${q(b)})`;
}

export default function ConstellationCanvas({
  lib,
  matchSet,
  colorBy,
  selected,
  neighbours,
  hovered,
  onHover,
  onSelect,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState<View>({ k: 1, tx: 0, ty: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);
  const drag = useRef<{ sx: number; sy: number; tx: number; ty: number } | null>(null);
  const pending = useRef<View | null>(null);
  const moveRaf = useRef<number | null>(null);

  const links = useMemo(() => buildSynapseLinks(lib.tracks), [lib]);
  const neighbourSet = useMemo(() => new Set((neighbours || []).map((t) => t.idx)), [neighbours]);
  const filtering = matchSet.size < lib.tracks.length;

  // Keep the backing store sized to the element.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  // ----- the scene paint (bucketed). Memoised on every scene input; the rAF
  // driver calls the freshest version via renderRef (synced in an effect, not
  // mutated during render — which the React Compiler would mis-memoise). -----
  const renderScene = useCallback((elapsed: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { w, h } = size;
    if (w === 0 || h === 0) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const v = viewRef.current;
    const { ox, oy, f } = fit(w, h);
    const sc = v.k * f;
    const toX = (x: number) => ox + (v.tx + x * v.k) * f;
    const toY = (y: number) => oy + (v.ty + y * v.k) * f;
    const entering = elapsed < ENTRANCE_TOTAL;

    const css = getComputedStyle(wrapRef.current!);
    const ink = css.getPropertyValue('--ink').trim() || '#222';
    const bg = css.getPropertyValue('--bg').trim() || '#fff';
    const tracks = lib.tracks;

    // links — one batched stroked path (faded harder during entrance)
    ctx.globalAlpha = (filtering ? 0.18 : 0.4) * (entering ? clamp01(elapsed / ENTRANCE_TOTAL) : 1);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (let i = 0; i < links.length; i++) {
      const a = tracks[links[i]![0]]!;
      const b = tracks[links[i]![1]]!;
      ctx.moveTo(toX(a.x), toY(a.y));
      ctx.lineTo(toX(b.x), toY(b.y));
    }
    ctx.stroke();

    // nodes — bucketed by (quantised colour, alpha tier). Filled non-emphasis
    // nodes batch into Path2Ds; hollow nodes batch per colour; the handful of
    // selected/neighbour nodes draw individually on top.
    type Bucket = { fill: string; alpha: number; path: Path2D };
    const filledBuckets = new Map<string, Bucket>();
    const hollowBuckets = new Map<string, Bucket>();
    const emphasis: Array<{ sx: number; sy: number; r: number; col: string; filled: boolean; op: number }> = [];

    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i]!;
      const sx = toX(t.x);
      const sy = toY(t.y);
      const matched = matchSet.has(t.idx);
      const isSel = selected != null && selected.idx === t.idx;
      const isNb = neighbourSet.has(t.idx);
      const base = 3.4 + (t.confidence ?? 0.5) * 2.2;
      let rUser = isSel ? base + 4 : isNb ? base + 1.6 : base;
      let op = matched ? 1 : 0.07;
      if (selected && matched && !isSel && !isNb) op = filtering ? 0.5 : 0.32;

      if (entering) {
        const delay = Math.min(ENTRANCE_SPREAD, Math.hypot(t.x - 500, t.y - 500) * 0.9);
        const np = clamp01((elapsed - delay) / ENTRANCE_FADE);
        if (np <= 0) continue;
        rUser *= easeOut(np);
        op *= np;
      }
      const rPx = rUser * sc;
      if (sx < -rPx || sx > w + rPx || sy < -rPx || sy > h + rPx) continue; // cull

      const col = isSel ? '#d94b2a' : nodeColor(t, colorBy);
      const filled = nodeFilled(t, colorBy) || isSel || isNb;
      if (isSel || isNb) {
        emphasis.push({ sx, sy, r: Math.max(0.5, rPx), col, filled, op });
        continue;
      }
      const alpha = Math.round(op * 20) / 20;
      const key = quantColor(col) + '@' + alpha;
      const map = filled ? filledBuckets : hollowBuckets;
      let bk = map.get(key);
      if (!bk) {
        bk = { fill: filled ? quantColor(col) : col, alpha, path: new Path2D() };
        map.set(key, bk);
      }
      const r = Math.max(0.5, rPx);
      bk.path.moveTo(sx + r, sy);
      bk.path.arc(sx, sy, r, 0, TAU);
    }

    // filled buckets: one fill per bucket
    for (const bk of filledBuckets.values()) {
      ctx.globalAlpha = bk.alpha;
      ctx.fillStyle = bk.fill;
      ctx.fill(bk.path);
    }
    // hollow buckets: bg fill + coloured stroke per bucket
    ctx.lineWidth = 1.4;
    for (const bk of hollowBuckets.values()) {
      ctx.globalAlpha = bk.alpha;
      ctx.fillStyle = bg;
      ctx.fill(bk.path);
      ctx.strokeStyle = bk.fill;
      ctx.stroke(bk.path);
    }
    // emphasis (selected / neighbour) on top
    for (const e of emphasis) {
      ctx.globalAlpha = e.op;
      ctx.beginPath();
      ctx.arc(e.sx, e.sy, e.r, 0, TAU);
      if (e.filled) {
        ctx.fillStyle = e.col;
        ctx.fill();
      } else {
        ctx.fillStyle = bg;
        ctx.fill();
      }
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = e.col;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }, [size, lib, links, matchSet, colorBy, selected, neighbourSet, filtering]);
  const renderRef = useRef(renderScene);
  useEffect(() => {
    renderRef.current = renderScene;
  }, [renderScene]);

  // ----- repaint driver -----
  // One effect owns the rAF. It repaints on every scene/view/size change and,
  // while the entrance is still playing, keeps looping until it finishes. Each
  // run cancels its own frame on cleanup, so there's no shared guard that can
  // wedge across StrictMode remounts (an earlier shared-`rafRef===0` guard did).
  const entranceStart = useRef(0);
  const prevLib = useRef<LibraryData | null>(null);
  useEffect(() => {
    if (prevLib.current !== lib) {
      entranceStart.current = 0; // re-enter on a new dataset / new cap
      prevLib.current = lib;
    }
    if (size.w > 0 && size.h > 0 && entranceStart.current === 0) {
      entranceStart.current = performance.now();
    }
    // Paint synchronously now (guarantees pixels), then advance the entrance.
    const elapsed0 = entranceStart.current ? performance.now() - entranceStart.current : Infinity;
    renderScene(elapsed0);
    if (elapsed0 >= ENTRANCE_TOTAL) return;
    let raf = requestAnimationFrame(function loop() {
      const e = entranceStart.current ? performance.now() - entranceStart.current : Infinity;
      renderScene(e);
      if (e < ENTRANCE_TOTAL) raf = requestAnimationFrame(loop);
    });
    // rAF is paused while the tab is hidden, so the entrance loop won't run there.
    // This timer fires regardless and guarantees the final full-state paint, so a
    // map that mounted in a background tab isn't left half-entered.
    const settle = setTimeout(() => renderScene(Infinity), ENTRANCE_TOTAL + 60);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(settle);
    };
  }, [renderScene, view, size, lib]);

  // Repaint on theme switches (canvas reads CSS vars manually) and when the tab
  // becomes visible again (rAF was paused while hidden).
  useEffect(() => {
    const obs = new MutationObserver(() => renderRef.current(Infinity));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    const onVis = () => {
      if (!document.hidden) renderRef.current(Infinity);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      obs.disconnect();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  // Cancel a dangling drag-commit frame on unmount.
  useEffect(
    () => () => {
      if (moveRaf.current != null) cancelAnimationFrame(moveRaf.current);
    },
    [],
  );

  // ---- hit testing (uniform spatial grid; a mousemove checks only the cells
  // under the pick tolerance instead of every node — a linear scan was fine at
  // 50k but every pointer move pays it, and the cap now reaches 100k) ----
  const PICK_CELL = 32; // user-space units; tolerance is ≤ ~36 at min zoom
  const pickGrid = useMemo(() => {
    const g = new Map<string, number[]>();
    lib.tracks.forEach((t, i) => {
      const k = `${Math.floor(t.x / PICK_CELL)}|${Math.floor(t.y / PICK_CELL)}`;
      const bucket = g.get(k);
      if (bucket) bucket.push(i);
      else g.set(k, [i]);
    });
    return g;
  }, [lib]);
  const pick = useCallback(
    (clientX: number, clientY: number): ObsTrack | null => {
      const r = wrapRef.current!.getBoundingClientRect();
      const { ox, oy, f } = fit(r.width, r.height);
      const v = viewRef.current;
      const ux = ((clientX - r.left - ox) / f - v.tx) / v.k;
      const uy = ((clientY - r.top - oy) / f - v.ty) / v.k;
      const tolUser = Math.max(6, 7 / (v.k * f));
      let best: ObsTrack | null = null;
      let bd = tolUser * tolUser;
      const tracks = lib.tracks;
      const gx0 = Math.floor((ux - tolUser) / PICK_CELL);
      const gx1 = Math.floor((ux + tolUser) / PICK_CELL);
      const gy0 = Math.floor((uy - tolUser) / PICK_CELL);
      const gy1 = Math.floor((uy + tolUser) / PICK_CELL);
      for (let gx = gx0; gx <= gx1; gx++) {
        for (let gy = gy0; gy <= gy1; gy++) {
          const cell = pickGrid.get(`${gx}|${gy}`);
          if (!cell) continue;
          for (const i of cell) {
            const t = tracks[i]!;
            const dx = t.x - ux;
            const dy = t.y - uy;
            const d = dx * dx + dy * dy;
            if (d < bd) {
              bd = d;
              best = t;
            }
          }
        }
      }
      return best;
    },
    [lib, pickGrid],
  );

  // ---- pan + zoom ----
  const onWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const r = wrapRef.current!.getBoundingClientRect();
    const { ox, oy, f } = fit(r.width, r.height);
    const vbx = (e.clientX - r.left - ox) / f;
    const vby = (e.clientY - r.top - oy) / f;
    setView((v) => {
      const k2 = Math.max(0.65, Math.min(6, v.k * (e.deltaY < 0 ? 1.12 : 0.893)));
      const ux = (vbx - v.tx) / v.k;
      const uy = (vby - v.ty) / v.k;
      return { k: k2, tx: vbx - ux * k2, ty: vby - uy * k2 };
    });
  }, []);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onWheel]);

  const onPointerDown = (e: React.PointerEvent) => {
    const v = viewRef.current;
    drag.current = { sx: e.clientX, sy: e.clientY, tx: v.tx, ty: v.ty };
    draggingRef.current = true;
    setDragging(true);
    onHover(null);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d) {
      const r = wrapRef.current!.getBoundingClientRect();
      const { f } = fit(r.width, r.height);
      const next = { k: viewRef.current.k, tx: d.tx + (e.clientX - d.sx) / f, ty: d.ty + (e.clientY - d.sy) / f };
      viewRef.current = next; // immediate, for the canvas
      pending.current = next;
      renderRef.current(Infinity); // paint this frame straight away
      if (moveRaf.current == null) {
        moveRaf.current = requestAnimationFrame(() => {
          moveRaf.current = null;
          if (pending.current) setView(pending.current); // commit (drives the overlay)
        });
      }
      return;
    }
    const hit = pick(e.clientX, e.clientY);
    onHover(hit || null, hit ? e : undefined);
  };
  const endDrag = () => {
    if (moveRaf.current != null) {
      cancelAnimationFrame(moveRaf.current);
      moveRaf.current = null;
    }
    if (drag.current && pending.current) setView(pending.current);
    drag.current = null;
    pending.current = null;
    draggingRef.current = false;
    setDragging(false);
  };
  const onClick = (e: React.MouseEvent) => {
    const hit = pick(e.clientX, e.clientY);
    onSelect(hit && selected && hit.idx === selected.idx ? null : hit);
  };

  const reset = () => setView({ k: 1, tx: 0, ty: 0 });
  const zoom = (factor: number) =>
    setView((v) => {
      const k2 = Math.max(0.65, Math.min(6, v.k * factor));
      const ux = (500 - v.tx) / v.k;
      const uy = (500 - v.ty) / v.k;
      return { k: k2, tx: 500 - ux * k2, ty: 500 - uy * k2 };
    });

  const transform = `translate(${view.tx} ${view.ty}) scale(${view.k})`;

  return (
    <div
      className="cmap"
      ref={wrapRef}
      style={{ cursor: dragging ? 'grabbing' : 'grab' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerLeave={endDrag}
      onClick={onClick}
    >
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />

      {/* highlight overlay — wiring, ripple, hover (a few elements at most) */}
      <svg
        viewBox="0 0 1000 1000"
        preserveAspectRatio="xMidYMid meet"
        className="cmap-svg"
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
      >
        <g transform={transform}>
          {selected && (
            <g className="cmap-wire">
              {neighbours.map((n, i) => (
                <line
                  key={i}
                  x1={selected.x}
                  y1={selected.y}
                  x2={n.x}
                  y2={n.y}
                  stroke="var(--accent)"
                  strokeWidth={1.1}
                  vectorEffect="non-scaling-stroke"
                  strokeDasharray="3 2.5"
                  className="wire-line"
                  style={{ animationDelay: i * 60 + 'ms' }}
                />
              ))}
            </g>
          )}
          {hovered && (!selected || selected.idx !== hovered.idx) && (
            <circle
              cx={hovered.x}
              cy={hovered.y}
              r={3.4 + (hovered.confidence ?? 0.5) * 2.2 + 2.4}
              fill="none"
              stroke="var(--accent)"
              strokeWidth={1.3}
              vectorEffect="non-scaling-stroke"
              style={{ transition: 'r .15s cubic-bezier(.2,.7,.2,1)' }}
            />
          )}
          {selected && (
            <circle
              cx={selected.x}
              cy={selected.y}
              r={14}
              fill="none"
              stroke="var(--accent)"
              strokeWidth={1.4}
              vectorEffect="non-scaling-stroke"
              className="cmap-ripple"
            />
          )}
        </g>
      </svg>

      {/* zoom controls */}
      <div className="cmap-zoom">
        <button onClick={() => zoom(1.3)} aria-label="zoom in">
          +
        </button>
        <button onClick={() => zoom(0.77)} aria-label="zoom out">
          −
        </button>
        <button onClick={reset} aria-label="reset" className="cmap-reset">
          RESET
        </button>
      </div>

      {/* legend (mirrors the SVG renderer) */}
      <div className="cmap-legend">
        <span className="t-caption ad-muted">{legendLabel(colorBy)}</span>
        {colorBy === 'energy' || colorBy === 'confidence' ? (
          <div className="legend-ramp">
            <span className="lr-bar" />
            <span className="t-caption ad-muted">{colorBy === 'energy' ? 'LOW' : '0.0'}</span>
            <span className="t-caption ad-muted" style={{ marginLeft: 'auto' }}>
              {colorBy === 'energy' ? 'HIGH' : '1.0'}
            </span>
          </div>
        ) : colorBy === 'source' ? (
          <div className="legend-keys">
            <span>
              <i className="lk" style={{ background: '#d94b2a' }} />
              MANUAL
            </span>
            <span>
              <i className="lk" style={{ background: '#9a5b1f' }} />
              LLM
            </span>
            <span>
              <i className="lk" style={{ background: '#4a443d' }} />
              PROPAGATED
            </span>
            <span>
              <i className="lk hollow" style={{ borderColor: '#9b948a' }} />
              UNCERTAIN · LEGACY
            </span>
          </div>
        ) : (
          <div className="legend-keys">
            <span>
              <i className="lk" style={{ background: '#d94b2a' }} />
              ANALYSED
            </span>
            <span>
              <i className="lk hollow" style={{ borderColor: '#9b948a' }} />
              NOT ANALYSED
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function legendLabel(c: ColorBy): string {
  return c === 'energy'
    ? 'NODE COLOUR · ENERGY'
    : c === 'confidence'
      ? 'NODE COLOUR · TAG CONFIDENCE'
      : c === 'source'
        ? 'NODE COLOUR · TAG SOURCE'
        : 'NODE COLOUR · ACOUSTIC ANALYSIS';
}

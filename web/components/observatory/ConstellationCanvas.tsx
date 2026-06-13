/* ============================================================================
   SUB/WAVE — Library Observatory · constellation (CANVAS spike)
   A hybrid renderer for large libraries (10k–50k+ tracks), gated behind the
   `?renderer=canvas` flag (see ObservatoryApp). The bulk node + link layers
   are drawn to a single <canvas> in one pass per frame — no per-node DOM, so
   pan / zoom / filter / colour-by are a redraw (a few ms) instead of an O(n)
   React reconcile. Only the handful of *highlighted* elements (selection
   wiring, ripple, hover) live in a thin SVG overlay on top, where CSS theming
   and animation are easy.

   Coordinate model mirrors the SVG renderer exactly so the overlay aligns:
   a 1000×1000 user space is fit into the stage with `meet` letterboxing
   (S = min(W,H), centred), then the pan/zoom view {tx,ty,k} is applied in
   that 0..1000 space. Screen px = origin + (t + user·k)·f, where f = S/1000.
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

// meet-fit transform for a given stage size: how 0..1000 maps to CSS px.
function fit(w: number, h: number) {
  const S = Math.min(w, h);
  return { S, ox: (w - S) / 2, oy: (h - S) / 2, f: S / 1000 };
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
  const rafId = useRef<number | null>(null);

  const links = useMemo(() => buildSynapseLinks(lib.tracks), [lib]);
  const neighbourSet = useMemo(() => new Set((neighbours || []).map((t) => t.idx)), [neighbours]);

  // Keep the backing store sized to the element × DPR.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    const r = el.getBoundingClientRect();
    setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    return () => ro.disconnect();
  }, []);

  const filtering = matchSet.size < lib.tracks.length;

  // The single draw pass. Reads everything fresh each call.
  const draw = useCallback(() => {
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
    const sc = v.k * f; // user→screen scale
    const toX = (x: number) => ox + (v.tx + x * v.k) * f;
    const toY = (y: number) => oy + (v.ty + y * v.k) * f;

    const css = getComputedStyle(wrapRef.current!);
    const ink = css.getPropertyValue('--ink').trim() || '#222';
    const bg = css.getPropertyValue('--bg').trim() || '#fff';
    const tracks = lib.tracks;

    // links — batched into one stroked path
    ctx.globalAlpha = filtering ? 0.18 : 0.4;
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

    // nodes
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i]!;
      const sx = toX(t.x);
      const sy = toY(t.y);
      const matched = matchSet.has(t.idx);
      const isSel = selected != null && selected.idx === t.idx;
      const isNb = neighbourSet.has(t.idx);
      const base = 3.4 + (t.confidence ?? 0.5) * 2.2;
      const rUser = isSel ? base + 4 : isNb ? base + 1.6 : base;
      const rPx = rUser * sc;
      if (sx < -rPx || sx > w + rPx || sy < -rPx || sy > h + rPx) continue; // cull
      let op = matched ? 1 : 0.07;
      if (selected && matched && !isSel && !isNb) op = filtering ? 0.5 : 0.32;
      const col = isSel ? '#d94b2a' : nodeColor(t, colorBy);
      const filled = nodeFilled(t, colorBy) || isSel || isNb;
      ctx.globalAlpha = op;
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(0.5, rPx), 0, TAU);
      if (filled) {
        ctx.fillStyle = col;
        ctx.fill();
      } else {
        ctx.fillStyle = bg;
        ctx.fill();
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = col;
        ctx.stroke();
      }
      if (isSel || isNb) {
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = col;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }, [size, lib, links, matchSet, colorBy, selected, neighbourSet, filtering]);

  // Redraw on any state the picture depends on (view included).
  useEffect(() => {
    draw();
  }, [draw, view]);

  // ---- hit testing (linear scan; ~n distance checks, fine at 50k) ----
  const pick = useCallback(
    (clientX: number, clientY: number): ObsTrack | null => {
      const r = wrapRef.current!.getBoundingClientRect();
      const { ox, oy, f } = fit(r.width, r.height);
      const v = viewRef.current;
      // screen → user space
      const ux = ((clientX - r.left - ox) / f - v.tx) / v.k;
      const uy = ((clientY - r.top - oy) / f - v.ty) / v.k;
      const tolUser = Math.max(6, 7 / (v.k * f)); // ~7px in user units, min 6
      const tol2 = tolUser * tolUser;
      let best: ObsTrack | null = null;
      let bd = tol2;
      const tracks = lib.tracks;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i]!;
        const dx = t.x - ux;
        const dy = t.y - uy;
        const d = dx * dx + dy * dy;
        if (d < bd) {
          bd = d;
          best = t;
        }
      }
      return best;
    },
    [lib],
  );

  // ---- pan + zoom ----
  const onWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const r = wrapRef.current!.getBoundingClientRect();
    const { ox, oy, f } = fit(r.width, r.height);
    const vbx = (e.clientX - r.left - ox) / f; // pointer in 0..1000 space
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
  useEffect(
    () => () => {
      if (rafId.current != null) cancelAnimationFrame(rafId.current);
    },
    [],
  );

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
      pending.current = {
        k: viewRef.current.k,
        tx: d.tx + (e.clientX - d.sx) / f,
        ty: d.ty + (e.clientY - d.sy) / f,
      };
      if (rafId.current == null) {
        rafId.current = requestAnimationFrame(() => {
          rafId.current = null;
          if (pending.current) setView(pending.current);
        });
      }
      return;
    }
    // not dragging → hover hit-test
    const hit = pick(e.clientX, e.clientY);
    if (hit) onHover(hit, e);
    else onHover(null);
  };
  const endDrag = () => {
    if (rafId.current != null) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
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

  // overlay transform (SVG, viewBox handles the meet mapping)
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

      {/* spike marker */}
      <div
        className="t-caption ad-muted"
        style={{ position: 'absolute', top: 10, right: 14, letterSpacing: '0.18em', opacity: 0.7 }}
      >
        CANVAS · {lib.tracks.length.toLocaleString()} NODES
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

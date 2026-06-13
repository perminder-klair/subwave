/* ============================================================================
   SUB/WAVE — Library Observatory · the constellation
   Ported from the prototype's viz.jsx. Every track is a node placed by genre
   cluster (see data.ts layoutTracks). Monochrome ink→vermilion ramp encodes
   energy; faint synapse links wire intra-cluster neighbours; vermilion dashed
   wiring marks the mix-next set on selection. Zoom, pan, hover, select.

   Scale note: the node + link layers are memoised on everything *except* the
   pan/zoom `view`, and all strokes use `vector-effect="non-scaling-stroke"`,
   so a pan or zoom only patches the parent <g transform> — React skips the
   (potentially thousands of) memoised children rather than reconciling them
   each frame. Pan state updates are coalesced to one per animation frame.
   ============================================================================ */
'use client';

import { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import { nodeColor, nodeFilled, type ColorBy, type ObsTrack, type LibraryData } from './data';

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

export default function ConstellationMap({
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
  const [view, setView] = useState<View>({ k: 1, tx: 0, ty: 0 });
  // Live mirror of the committed view, so gesture math can read the latest
  // value without adding `view` to handler deps.
  const viewRef = useRef(view);
  viewRef.current = view;
  const [ready, setReady] = useState(false);
  const drag = useRef<{ sx: number; sy: number; tx: number; ty: number } | null>(null);
  const pending = useRef<View | null>(null);
  const rafId = useRef<number | null>(null);
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // baseline synapse links: 1 nearest intra-cluster neighbour per node
  const links = useMemo(() => {
    const byGenre: Record<string, ObsTrack[]> = {};
    lib.tracks.forEach((t) => {
      const g = t.genre || '—';
      (byGenre[g] ||= []).push(t);
    });
    const out: [ObsTrack, ObsTrack][] = [];
    const seen = new Set<string>();
    Object.values(byGenre).forEach((group) => {
      group.forEach((t) => {
        let best: ObsTrack | null = null;
        let bd = Infinity;
        for (const o of group) {
          if (o.idx === t.idx) continue;
          const dx = t.x - o.x;
          const dy = t.y - o.y;
          const d = dx * dx + dy * dy;
          if (d < bd) {
            bd = d;
            best = o;
          }
        }
        if (best) {
          const key = t.idx < best.idx ? t.idx + '-' + best.idx : best.idx + '-' + t.idx;
          if (!seen.has(key)) {
            seen.add(key);
            out.push([t, best]);
          }
        }
      });
    });
    return out;
  }, [lib]);

  const neighbourSet = useMemo(() => new Set((neighbours || []).map((t) => t.idx)), [neighbours]);

  // ---- pointer: pan + zoom ----
  const onWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const r = wrapRef.current!.getBoundingClientRect();
    const p = { x: ((e.clientX - r.left) / r.width) * 1000, y: ((e.clientY - r.top) / r.height) * 1000 };
    setView((v) => {
      const k2 = Math.max(0.65, Math.min(6, v.k * (e.deltaY < 0 ? 1.12 : 0.893)));
      const wx = (p.x - v.tx) / v.k;
      const wy = (p.y - v.ty) / v.k;
      return { k: k2, tx: p.x - wx * k2, ty: p.y - wy * k2 };
    });
  }, []);
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).dataset?.node) return; // let node clicks through
    const v = viewRef.current;
    drag.current = { sx: e.clientX, sy: e.clientY, tx: v.tx, ty: v.ty };
    draggingRef.current = true;
    setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const r = wrapRef.current!.getBoundingClientRect();
    const dx = ((e.clientX - d.sx) / r.width) * 1000;
    const dy = ((e.clientY - d.sy) / r.height) * 1000;
    pending.current = { k: viewRef.current.k, tx: d.tx + dx, ty: d.ty + dy };
    // Coalesce: at most one state commit per frame regardless of pointer rate.
    if (rafId.current == null) {
      rafId.current = requestAnimationFrame(() => {
        rafId.current = null;
        if (pending.current) setView(pending.current);
      });
    }
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

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onWheel]);
  // Clean up a dangling pan frame on unmount.
  useEffect(
    () => () => {
      if (rafId.current != null) cancelAnimationFrame(rafId.current);
    },
    [],
  );

  const reset = () => setView({ k: 1, tx: 0, ty: 0 });
  const zoom = (f: number) =>
    setView((v) => {
      const k2 = Math.max(0.65, Math.min(6, v.k * f));
      const wx = (500 - v.tx) / v.k;
      const wy = (500 - v.ty) / v.k;
      return { k: k2, tx: 500 - wx * k2, ty: 500 - wy * k2 };
    });

  const filtering = matchSet.size < lib.tracks.length;

  const transform = `translate(${view.tx} ${view.ty}) scale(${view.k})`;

  // Synapse links — memoised on the link set alone. Stroke width is screen-space
  // (non-scaling-stroke), so zoom never recomputes these.
  const linkEls = useMemo(
    () =>
      links.map(([a, b], i) => (
        <line
          key={i}
          x1={a.x}
          y1={a.y}
          x2={b.x}
          y2={b.y}
          stroke="var(--ink)"
          strokeWidth={0.5}
          vectorEffect="non-scaling-stroke"
        />
      )),
    [links],
  );

  // Node layer — the heavy one. Memoised on data + selection/filter state but
  // NOT on `view` or `hovered`, so pan/zoom AND hover skip it entirely (hover is
  // drawn as a single overlay below). `dragging` is read from a ref inside the
  // handlers so it isn't a dependency either.
  const nodeEls = useMemo(() => {
    return lib.tracks.map((t) => {
      const matched = matchSet.has(t.idx);
      const isSel = selected != null && selected.idx === t.idx;
      const isNb = neighbourSet.has(t.idx);
      const base = 3.4 + (t.confidence ?? 0.5) * 2.2;
      const r = isSel ? base + 4 : isNb ? base + 1.6 : base;
      let op = matched ? 1 : 0.07;
      if (selected && matched && !isSel && !isNb) op = filtering ? 0.5 : 0.32;
      const col = isSel ? '#d94b2a' : nodeColor(t, colorBy);
      const filled = nodeFilled(t, colorBy) || isSel || isNb;
      // entrance: spread from centre
      const delay = ready ? 0 : Math.min(620, Math.hypot(t.x - 500, t.y - 500) * 0.9);
      return (
        <circle
          key={t.idx}
          data-node="1"
          cx={t.x}
          cy={t.y}
          r={ready ? r : 0}
          fill={filled ? col : 'var(--bg)'}
          stroke={col}
          strokeWidth={(filled ? 0 : 1.4) + (isSel || isNb ? 1.2 : 0)}
          vectorEffect="non-scaling-stroke"
          style={{
            opacity: ready ? op : 0,
            transition: `r .22s cubic-bezier(.2,.7,.2,1), opacity .45s ease ${delay}ms, fill .25s, stroke-width .2s`,
            cursor: 'pointer',
          }}
          onMouseEnter={(e) => {
            if (!draggingRef.current) onHover(t, e);
          }}
          onMouseMove={(e) => {
            if (!draggingRef.current) onHover(t, e);
          }}
          onMouseLeave={() => onHover(null)}
          onClick={(e) => {
            e.stopPropagation();
            onSelect(isSel ? null : t);
          }}
        />
      );
    });
  }, [lib.tracks, matchSet, colorBy, selected, neighbourSet, ready, filtering, onHover, onSelect]);

  // Hover highlight — one overlay circle on top of the static node layer, so
  // hovering doesn't rebuild all N nodes (was the O(N) reconcile path). Purely
  // decorative (pointer-events: none); the base node underneath keeps the
  // pointer handlers. Skipped when the hovered node is the selected one (the
  // selection ripple already marks it).
  const hoverEl = useMemo(() => {
    if (!hovered || (selected && selected.idx === hovered.idx)) return null;
    const t = hovered;
    const matched = matchSet.has(t.idx);
    const isNb = neighbourSet.has(t.idx);
    const base = 3.4 + (t.confidence ?? 0.5) * 2.2;
    let op = matched ? 1 : 0.07;
    if (selected && matched && !isNb) op = filtering ? 0.5 : 0.32;
    const col = nodeColor(t, colorBy);
    const filled = nodeFilled(t, colorBy) || isNb;
    return (
      <circle
        cx={t.x}
        cy={t.y}
        r={base + 2.4}
        fill={filled ? col : 'var(--bg)'}
        stroke={col}
        strokeWidth={(filled ? 0 : 1.4) + (isNb ? 1.2 : 0)}
        vectorEffect="non-scaling-stroke"
        style={{ opacity: op, pointerEvents: 'none' }}
      />
    );
  }, [hovered, selected, matchSet, neighbourSet, colorBy, filtering]);

  return (
    <div
      className="cmap"
      ref={wrapRef}
      style={{ cursor: dragging ? 'grabbing' : 'grab' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerLeave={endDrag}
    >
      <svg viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid meet" className="cmap-svg">
        <g transform={transform}>
          {/* synapse links */}
          <g className="cmap-links" style={{ opacity: filtering ? 0.18 : 0.4 }}>
            {linkEls}
          </g>

          {/* selection wiring → mix-next */}
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

          {/* nodes */}
          {nodeEls}

          {/* hover highlight (single overlay, not a node-layer rebuild) */}
          {hoverEl}

          {/* selected ripple */}
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

      {/* legend */}
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

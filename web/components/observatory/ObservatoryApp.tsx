/* ============================================================================
   SUB/WAVE — Library Observatory · app shell
   Ported from the prototype's app.jsx. Full-bleed top bar + 3-column grid
   (filter rail · constellation · stats/dossier), wired to the real library
   via useObservatory()/useTrackDetail().
   ============================================================================ */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useObservatory, useTrackDetail } from '../../lib/observatory';
import ConstellationMap from './ConstellationMap';
import ConstellationCanvas from './ConstellationCanvas';
import { StatsView, Dossier } from './panels';
import { nearest, sourceStyle, tally, type ColorBy, type ObsTrack } from './data';

type AdminFetch = (path: string, init?: RequestInit) => Promise<Response>;

// Spinning vinyl disc mark, inline so it follows the theme via currentColor
// (an <img> SVG can't read the page's light/dark tokens). Faithful to the
// prototype's disc-mark-ink.svg: sunburst spokes + a vermilion hub.
function DiscMark() {
  const cx = 48;
  const cy = 48;
  const R = 47;
  const N = 20;
  const span = (360 / N) * 0.5; // half-gap wedges → classic sunburst
  const spokes: string[] = [];
  for (let i = 0; i < N; i++) {
    const a0 = ((-90 + i * (360 / N)) * Math.PI) / 180;
    const a1 = a0 + (span * Math.PI) / 180;
    const x0 = cx + R * Math.cos(a0);
    const y0 = cy + R * Math.sin(a0);
    const x1 = cx + R * Math.cos(a1);
    const y1 = cy + R * Math.sin(a1);
    spokes.push(`M${cx} ${cy} L${x0.toFixed(2)} ${y0.toFixed(2)} A${R} ${R} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`);
  }
  return (
    <svg viewBox="0 0 96 96" className="obs-disc" style={{ color: 'var(--ink)' }} aria-hidden="true">
      <circle cx={cx} cy={cy} r={R} fill="none" stroke="currentColor" strokeWidth="1" />
      {spokes.map((d, i) => (
        <path key={i} d={d} fill="currentColor" />
      ))}
      <circle cx={cx} cy={cy} r={16.32} fill="#d94b2a" stroke="var(--bg)" strokeWidth="1" />
    </svg>
  );
}

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button className={'flt-tog' + (on ? ' on' : '')} onClick={onClick}>
      {children}
    </button>
  );
}

interface TipState {
  track: ObsTrack;
  x: number;
  y: number;
}

function Tooltip({ data }: { data: TipState | null }) {
  if (!data) return null;
  const { track, x, y } = data;
  const flip = typeof window !== 'undefined' && x > window.innerWidth - 260;
  return (
    <div
      className="obs-tip"
      style={{ left: x + (flip ? -16 : 16), top: y + 16, transform: flip ? 'translateX(-100%)' : 'none' }}
    >
      <div className="tip-genre t-caption ad-muted">
        {(track.genre || 'UNFILED')}
        {track.year ? ` · ${track.year}` : ''}
      </div>
      <div className="tip-title">{track.title || 'Untitled'}</div>
      <div className="tip-artist">{track.artist || 'Unknown'}</div>
      <div className="tip-meta">
        <span>{track.bpm ?? '—'} BPM</span>
        <span className="acc">{track.musicalKey ?? '—'}</span>
        <span>{(track.energy ?? '—').toUpperCase()}</span>
      </div>
      {track.moods.length > 0 && (
        <div className="tip-moods">
          {track.moods.map((m) => (
            <span key={m}>{m}</span>
          ))}
        </div>
      )}
    </div>
  );
}

// Node-cap ladder offered in the MAP SIZE control. Values above ~3k render on
// the canvas renderer (see CANVAS_THRESHOLD). Clamped to the server's hardMax.
const MAX_LADDER = [2000, 4000, 8000, 10000, 16000, 32000, 50000];
const CANVAS_THRESHOLD = 3000; // node count above which the canvas renderer wins
const DEFAULT_MAX = 10000; // matches the controller's OBSERVATORY_DEFAULT_MAX
const MAX_STORAGE_KEY = 'subwave_obs_max';

export default function ObservatoryApp({ adminFetch }: { adminFetch: AdminFetch }) {
  // Persisted node cap (MAP SIZE control). Read once from localStorage; falls
  // back to DEFAULT_MAX, which mirrors the server default so a fresh browser and
  // a direct API caller see the same cap.
  const [maxNodes, setMaxNodes] = useState<number>(() => {
    if (typeof window === 'undefined') return DEFAULT_MAX;
    const stored = Number(window.localStorage.getItem(MAX_STORAGE_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_MAX;
  });
  const { data: lib, loading, error } = useObservatory(adminFetch, true, maxNodes);
  const { detail, loadingId, fetchDetail } = useTrackDetail(adminFetch);

  const [q, setQ] = useState('');
  const [colorBy, setColorBy] = useState<ColorBy>('energy');
  const [energy, setEnergy] = useState<Set<string>>(new Set());
  const [moods, setMoods] = useState<Set<string>>(new Set());
  const [genres, setGenres] = useState<Set<string>>(new Set());
  const [sources, setSources] = useState<Set<string>>(new Set());
  const [analysedOnly, setAnalysedOnly] = useState(false);
  const [selected, setSelected] = useState<ObsTrack | null>(null);
  const [tip, setTip] = useState<TipState | null>(null);

  // Renderer override: `?renderer=canvas|svg` forces a renderer; otherwise it
  // auto-switches to canvas above CANVAS_THRESHOLD nodes (small libraries keep
  // the animated, accessible SVG path; big ones get the fast canvas one).
  const [rendererOverride] = useState<'svg' | 'canvas' | null>(() => {
    if (typeof window === 'undefined') return null;
    const r = new URLSearchParams(window.location.search).get('renderer');
    return r === 'canvas' || r === 'svg' ? r : null;
  });

  const setMax = (n: number) => {
    setMaxNodes(n);
    setSelected(null);
    try {
      window.localStorage.setItem(MAX_STORAGE_KEY, String(n));
    } catch {
      /* ignore quota/availability */
    }
  };

  const toggleIn =
    (setter: React.Dispatch<React.SetStateAction<Set<string>>>) =>
    (v: string) =>
      setter((s) => {
        const n = new Set(s);
        if (n.has(v)) n.delete(v);
        else n.add(v);
        return n;
      });

  // Lazy-load the rich dossier whenever the selected node changes.
  useEffect(() => {
    fetchDetail(selected?.id ?? null);
  }, [selected, fetchDetail]);

  const moodOptions = useMemo(() => (lib ? tally(lib.tracks, (t) => t.moods).slice(0, 12).map((m) => m[0]) : []), [lib]);
  const genreOptions = useMemo(() => (lib ? lib.genres.filter((g) => g !== '—') : []), [lib]);
  const sourceOptions = useMemo(() => (lib ? Object.keys(lib.stats.bySource || {}) : []), [lib]);

  const matched = useMemo(() => {
    if (!lib) return [];
    const qq = q.trim().toLowerCase();
    return lib.tracks.filter((t) => {
      if (energy.size && !(t.energy && energy.has(t.energy))) return false;
      if (sources.size && !(t.source && sources.has(t.source))) return false;
      if (genres.size && !(t.genre && genres.has(t.genre))) return false;
      if (moods.size && !t.moods.some((m) => moods.has(m))) return false;
      if (analysedOnly && !t.analysed) return false;
      if (
        qq &&
        !(
          (t.title || '').toLowerCase().includes(qq) ||
          (t.artist || '').toLowerCase().includes(qq) ||
          (t.album || '').toLowerCase().includes(qq) ||
          (t.genre || '').toLowerCase().includes(qq) ||
          t.moods.some((m) => m.includes(qq))
        )
      )
        return false;
      return true;
    });
  }, [lib, q, energy, moods, genres, sources, analysedOnly]);

  const matchSet = useMemo(() => new Set(matched.map((t) => t.idx)), [matched]);

  const byId = useMemo(() => new Map((lib?.tracks || []).map((t) => [t.id, t])), [lib]);

  // Mix-next nodes (for both the map wiring and the dossier list). Prefer the
  // server's real KNN neighbours; fall back to spatial nearest until the detail
  // fetch lands (or when the seed has no embedding).
  const mixNodes = useMemo(() => {
    if (!selected || !lib) return [];
    if (detail && detail.track.id === selected.id && detail.mixNext.length) {
      const nodes = detail.mixNext.map((m) => byId.get(m.id)).filter(Boolean) as ObsTrack[];
      if (nodes.length) return nodes;
    }
    const pool = matched.filter((t) => t.idx !== selected.idx);
    return nearest(selected, pool.length >= 6 ? pool : lib.tracks, 6);
  }, [selected, detail, matched, lib, byId]);

  const onReset = () => {
    setQ('');
    setEnergy(new Set());
    setMoods(new Set());
    setGenres(new Set());
    setSources(new Set());
    setAnalysedOnly(false);
  };

  // Stable identities so ConstellationMap's memoised node layer survives the
  // parent re-render that a hover (tip state) triggers — otherwise new callback
  // refs would invalidate the memo and reconcile every node on each hover.
  const onHover = useCallback((t: ObsTrack | null, e?: React.MouseEvent) => {
    if (!t || !e) {
      setTip(null);
      return;
    }
    setTip({ track: t, x: e.clientX, y: e.clientY });
  }, []);
  const onSelect = useCallback((t: ObsTrack | null) => setSelected(t), []);

  const total = lib?.tracks.length ?? 0;
  const useCanvas = rendererOverride === 'canvas' || (rendererOverride !== 'svg' && total > CANVAS_THRESHOLD);

  // Cap options: the ladder up to the server's hardMax, plus the current value.
  const hardMax = lib?.hardMax ?? 50000;
  const maxOptions = Array.from(new Set([...MAX_LADDER.filter((n) => n <= hardMax), maxNodes])).sort(
    (a, b) => a - b,
  );

  return (
    <div className="observatory-root">
      {/* top bar */}
      <header className="obs-top">
        <div className="obs-top-l">
          <Link href="/admin/library" className="obs-back">
            ← ADMIN
          </Link>
          <DiscMark />
          <span className="obs-wordmark">
            SUB<span className="acc">/</span>WAVE
          </span>
          <span className="obs-vsep" />
          <span className="obs-crumb">LIBRARY OBSERVATORY</span>
        </div>
        <div className="obs-top-r">
          <span className="obs-live">
            <span className="obs-live-dot" />
            THE DJ&apos;S MIND
          </span>
          <span className="obs-vsep" />
          <span className="obs-stat t-nums">{total} TRACKS</span>
          {lib?.mock && (
            <>
              <span className="obs-vsep" />
              <span className="obs-stat" style={{ color: 'var(--accent)' }}>
                SAMPLE DATA
              </span>
            </>
          )}
          {lib?.truncated && (
            <>
              <span className="obs-vsep" />
              <span className="obs-stat">
                {lib.sampled ? 'SAMPLED' : 'CAPPED'} · {total.toLocaleString()} / {lib.stats.total.toLocaleString()}
              </span>
            </>
          )}
        </div>
      </header>

      <div className="obs-main">
        {/* filter rail */}
        <aside className="obs-rail">
          <div className="rail-search">
            <span className="rail-search-ico">♪</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="scanning the dial…" />
          </div>

          <div className="rail-sec">
            <div className="rail-label">COLOUR BY</div>
            <div className="flt-grid2">
              {(
                [
                  ['energy', 'ENERGY'],
                  ['confidence', 'CONF'],
                  ['source', 'SOURCE'],
                  ['analysis', 'ANALYSIS'],
                  ['loudness', 'LOUDNESS'],
                  ['pace', 'PACE'],
                  ['vocal', 'VOICE'],
                ] as [ColorBy, string][]
              ).map(([k, l]) => (
                <button key={k} className={'flt-tog' + (colorBy === k ? ' on' : '')} onClick={() => setColorBy(k)}>
                  {l}
                </button>
              ))}
            </div>
          </div>

          <div className="rail-sec">
            <div className="rail-label">ENERGY</div>
            <div className="flt-grid3">
              {['low', 'medium', 'high'].map((e) => (
                <Toggle key={e} on={energy.has(e)} onClick={() => toggleIn(setEnergy)(e)}>
                  {e === 'medium' ? 'MED' : e.toUpperCase()}
                </Toggle>
              ))}
            </div>
          </div>

          {genreOptions.length > 0 && (
            <div className="rail-sec">
              <div className="rail-label">SCENE</div>
              <div className="flt-chips">
                {genreOptions.map((g) => (
                  <button key={g} className={'flt-chip' + (genres.has(g) ? ' on' : '')} onClick={() => toggleIn(setGenres)(g)}>
                    {g}
                  </button>
                ))}
              </div>
            </div>
          )}

          {moodOptions.length > 0 && (
            <div className="rail-sec">
              <div className="rail-label">MOOD</div>
              <div className="flt-chips">
                {moodOptions.map((m) => (
                  <button key={m} className={'flt-chip' + (moods.has(m) ? ' on' : '')} onClick={() => toggleIn(setMoods)(m)}>
                    {m}
                  </button>
                ))}
              </div>
            </div>
          )}

          {sourceOptions.length > 0 && (
            <div className="rail-sec">
              <div className="rail-label">TAG SOURCE</div>
              <div className="flt-chips">
                {sourceOptions.map((s) => (
                  <button key={s} className={'flt-chip' + (sources.has(s) ? ' on' : '')} onClick={() => toggleIn(setSources)(s)}>
                    {sourceStyle(s).label.toLowerCase()}
                  </button>
                ))}
              </div>
              <button
                className={'flt-tog wide' + (analysedOnly ? ' on' : '')}
                onClick={() => setAnalysedOnly(!analysedOnly)}
                style={{ marginTop: 8 }}
              >
                ANALYSED ONLY
              </button>
            </div>
          )}

          {!lib?.mock && (
            <div className="rail-sec">
              <div className="rail-label">
                MAP SIZE
                {lib?.sampled && <span className="ad-muted"> · SAMPLED OF {lib.stats.total.toLocaleString()}</span>}
              </div>
              <div className="obs-maxrow">
                <select
                  className="obs-maxsel"
                  value={maxNodes}
                  onChange={(e) => setMax(Number(e.target.value))}
                  aria-label="maximum nodes on the map"
                >
                  {maxOptions.map((n) => (
                    <option key={n} value={n}>
                      {n.toLocaleString()} nodes
                    </option>
                  ))}
                </select>
              </div>
              <div className="ad-muted t-caption">
                {total > CANVAS_THRESHOLD ? 'CANVAS RENDERER' : 'VECTOR RENDERER'}
              </div>
            </div>
          )}

          <div className="rail-foot">
            <div className="rail-count">
              <span className="t-nums acc">{matched.length}</span> <span className="ad-muted">/ {total} IN VIEW</span>
            </div>
            <button className="rail-reset" onClick={onReset}>
              RESET DIAL
            </button>
          </div>
        </aside>

        {/* stage */}
        <section className="obs-stage">
          <div className="stage-head">
            <div>
              <div className="t-eyebrow accent">THE SHAPE OF THE LIBRARY</div>
              <h1 className="stage-title">Every track the DJ knows, mapped by how it sounds.</h1>
            </div>
            <div className="stage-hint t-caption ad-muted">SCROLL TO ZOOM · DRAG TO PAN · CLICK A NODE</div>
          </div>
          {lib ? (
            useCanvas ? (
              <ConstellationCanvas
                lib={lib}
                matchSet={matchSet}
                colorBy={colorBy}
                selected={selected}
                neighbours={mixNodes}
                hovered={tip ? tip.track : null}
                onHover={onHover}
                onSelect={onSelect}
              />
            ) : (
              <ConstellationMap
                lib={lib}
                matchSet={matchSet}
                colorBy={colorBy}
                selected={selected}
                neighbours={mixNodes}
                hovered={tip ? tip.track : null}
                onHover={onHover}
                onSelect={onSelect}
              />
            )
          ) : (
            <div className="cmap" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span className="t-caption ad-muted">{loading ? 'mapping the library…' : error || 'no data'}</span>
            </div>
          )}
        </section>

        {/* side panel */}
        <aside className="obs-side">
          {lib &&
            (selected ? (
              <Dossier
                track={selected}
                detail={detail && detail.track.id === selected.id ? detail : null}
                loading={loadingId === selected.id}
                mixNodes={mixNodes}
                onSelect={setSelected}
                onClose={() => setSelected(null)}
              />
            ) : (
              <StatsView stats={lib.stats} list={matched} filtered={matched.length !== lib.tracks.length} />
            ))}
        </aside>
      </div>

      <Tooltip data={tip} />
    </div>
  );
}

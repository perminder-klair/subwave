/* ============================================================================
   SUB/WAVE — Library Observatory · app shell
   Ported from the prototype's app.jsx. Full-bleed top bar + 3-column grid
   (filter rail · constellation · stats/dossier), wired to the real library
   via useObservatory()/useTrackDetail().
   ============================================================================ */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useObservatory, useTrackDetail } from '../../lib/observatory';
import { StatsView, Dossier } from './panels';
import Tooltip, { type TipState } from './Tooltip';
import { nearest, sourceStyle, tally, type ColorBy, type ObsTrack } from './data';

// The galaxy renderer pulls in three.js + the bloom pipeline — client-only and
// heavy, so it's split out and never server-rendered.
const ConstellationGalaxy = dynamic(() => import('./ConstellationGalaxy'), {
  ssr: false,
  loading: () => (
    <div className="cmap cmap-galaxy" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <span className="t-caption ad-muted">warming the telescope…</span>
    </div>
  ),
});

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

// Node-cap ladder offered in the MAP SIZE control, clamped to the server's
// hardMax. The WebGL galaxy renderer draws the whole ladder comfortably.
const MAX_LADDER = [2000, 4000, 8000, 10000, 16000, 25000, 50000, 100000];
// Display fallback for the MAP SIZE selector before the first load resolves.
// The real default lives on the server (OBSERVATORY_MAX): with nothing stored
// we fetch without ?max= and adopt the cap the response reports, so an
// operator's env override actually reaches the UI.
const DEFAULT_MAX = 25000;
const MAX_STORAGE_KEY = 'subwave_obs_max';

export default function ObservatoryApp({ adminFetch }: { adminFetch: AdminFetch }) {
  // Persisted node cap (MAP SIZE control). Read once from localStorage; null
  // means "follow the server default" — useObservatory then omits ?max=.
  const [maxNodes, setMaxNodes] = useState<number | null>(() => {
    if (typeof window === 'undefined') return null;
    const stored = Number(window.localStorage.getItem(MAX_STORAGE_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  });
  const { data: lib, loading, error } = useObservatory(adminFetch, true, maxNodes);
  const { detail, loadingId, fetchDetail } = useTrackDetail(adminFetch);

  const [q, setQ] = useState('');
  // Debounced copy of the search query — `matched` scans every node, so at
  // large caps filtering on each keystroke makes typing lag. 150ms is under
  // perception but coalesces a burst of keys into one scan.
  const [qDebounced, setQDebounced] = useState('');
  useEffect(() => {
    if (q === '') {
      setQDebounced(''); // clearing (incl. RESET DIAL) applies instantly
      return;
    }
    const id = setTimeout(() => setQDebounced(q), 150);
    return () => clearTimeout(id);
  }, [q]);
  const [colorBy, setColorBy] = useState<ColorBy>('energy');
  const [energy, setEnergy] = useState<Set<string>>(new Set());
  const [moods, setMoods] = useState<Set<string>>(new Set());
  const [genres, setGenres] = useState<Set<string>>(new Set());
  const [sources, setSources] = useState<Set<string>>(new Set());
  const [analysedOnly, setAnalysedOnly] = useState(false);
  const [selected, setSelected] = useState<ObsTrack | null>(null);
  const [tip, setTip] = useState<TipState | null>(null);

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
    const qq = qDebounced.trim().toLowerCase();
    return lib.tracks.filter((t) => {
      if (energy.size && !(t.energy && energy.has(t.energy))) return false;
      if (sources.size && !(t.source && sources.has(t.source))) return false;
      if (genres.size && !(t.genre && genres.has(t.genre))) return false;
      if (moods.size && !t.moods.some((m) => moods.has(m))) return false;
      if (analysedOnly && !t.analysed) return false;
      if (qq && !t.searchText.includes(qq)) return false;
      return true;
    });
  }, [lib, qDebounced, energy, moods, genres, sources, analysedOnly]);

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

  // Stable identities so the galaxy's attribute-refresh effects don't re-run
  // on the parent re-render a hover (tip state) triggers.
  const onHover = useCallback((t: ObsTrack | null, e?: React.MouseEvent) => {
    if (!t || !e) {
      setTip(null);
      return;
    }
    setTip({ track: t, x: e.clientX, y: e.clientY });
  }, []);
  const onSelect = useCallback((t: ObsTrack | null) => setSelected(t), []);

  const total = lib?.tracks.length ?? 0;

  // Cap options: the ladder up to the server's hardMax, plus the current value
  // (which, with nothing stored, is whatever cap the server applied).
  const hardMax = lib?.hardMax ?? 50000;
  const effectiveMax = maxNodes ?? lib?.max ?? DEFAULT_MAX;
  const maxOptions = Array.from(new Set([...MAX_LADDER.filter((n) => n <= hardMax), effectiveMax])).sort(
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
                  value={effectiveMax}
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
              <div className="ad-muted t-caption">GALAXY RENDERER · WEBGL</div>
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
            <ConstellationGalaxy
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

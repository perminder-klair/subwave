/* ============================================================================
   SUB/WAVE — Library Observatory · app shell
   Ported from the prototype's app.jsx. Full-bleed top bar + 3-column grid
   (filter rail · constellation · stats/dossier), wired to the real library
   via useObservatory()/useTrackDetail().
   ============================================================================ */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useObservatory, useTrackDetail } from '../../lib/observatory';
import { StatsView, Dossier } from './panels';
import Tooltip, { type TipState } from './Tooltip';
import {
  nearest,
  sourceStyle,
  tally,
  type ColorBy,
  type MapProjectionStatus,
  type ObsTrack,
} from './data';

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
// hardMax. The WebGL galaxy renderer draws the whole ladder comfortably —
// stress-measured at 60 fps up to 500k (one-time geometry stall on load:
// ~2 s at 200k, ~6 s at 500k).
const MAX_LADDER = [2000, 4000, 8000, 10000, 16000, 25000, 50000, 100000, 200000, 500000];
// Display fallback for the MAP SIZE selector before the first load resolves.
// The real default lives on the server (OBSERVATORY_MAX): with nothing stored
// we fetch without ?max= and adopt the cap the response reports, so an
// operator's env override actually reaches the UI.
const DEFAULT_MAX = 25000;
const MAX_STORAGE_KEY = 'subwave_obs_max';

const COLOR_MODES: [ColorBy, string][] = [
  ['energy', 'ENERGY'],
  ['confidence', 'CONF'],
  ['source', 'SOURCE'],
  ['analysis', 'ANALYSIS'],
  ['loudness', 'LOUDNESS'],
  ['pace', 'PACE'],
  ['vocal', 'VOICE'],
];
const COLOR_IDS = new Set(COLOR_MODES.map(([k]) => k));

// Genre chips shown before the +N MORE toggle expands the full list — a real
// library can carry hundreds of genres, which otherwise wall off the rail.
const GENRE_CHIP_CAP = 24;

// A projection needs at least this many audio vectors to be worth offering —
// mirrors MIN_VECTORS in the controller's map-projection.ts.
const PROJECTION_MIN_VECTORS = 50;

export default function ObservatoryApp({ adminFetch }: { adminFetch: AdminFetch }) {
  // Persisted node cap (MAP SIZE control). Read once from localStorage; null
  // means "follow the server default" — useObservatory then omits ?max=.
  const [maxNodes, setMaxNodes] = useState<number | null>(() => {
    if (typeof window === 'undefined') return null;
    const stored = Number(window.localStorage.getItem(MAX_STORAGE_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  });
  const { data: lib, loading, error, reload } = useObservatory(adminFetch, true, maxNodes);
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
  // Colour-by is deep-linkable (?color=); the page only mounts after admin
  // auth hydrates, so reading the URL in the initializer never runs on SSR.
  const [colorBy, setColorBy] = useState<ColorBy>(() => {
    if (typeof window === 'undefined') return 'energy';
    const c = new URLSearchParams(window.location.search).get('color') as ColorBy | null;
    return c && COLOR_IDS.has(c) ? c : 'energy';
  });
  const [energy, setEnergy] = useState<Set<string>>(new Set());
  const [moods, setMoods] = useState<Set<string>>(new Set());
  const [genres, setGenres] = useState<Set<string>>(new Set());
  const [genresExpanded, setGenresExpanded] = useState(false);
  const [sources, setSources] = useState<Set<string>>(new Set());
  const [analysedOnly, setAnalysedOnly] = useState(false);
  const [selected, setSelected] = useState<ObsTrack | null>(null);
  const [tip, setTip] = useState<TipState | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);

  // Fly-to requests for the galaxy camera: bumped by search picks, MIX NEXT
  // picks and deep links — never by plain map clicks (the node is already
  // under the cursor there).
  const focusNonce = useRef(0);
  const [focusOn, setFocusOn] = useState<{ t: ObsTrack; n: number } | null>(null);
  const jumpTo = useCallback((t: ObsTrack) => {
    setSelected(t);
    focusNonce.current += 1;
    setFocusOn({ t, n: focusNonce.current });
  }, []);

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

  // Genre chips: top-N by population (lib.genres is already sorted), plus any
  // selected genre that would otherwise be hidden, plus a +N MORE toggle.
  const visibleGenres = useMemo(() => {
    if (genresExpanded || genreOptions.length <= GENRE_CHIP_CAP) return genreOptions;
    const top = genreOptions.slice(0, GENRE_CHIP_CAP);
    const topSet = new Set(top);
    for (const g of genres) if (!topSet.has(g) && genreOptions.includes(g)) top.push(g);
    return top;
  }, [genreOptions, genresExpanded, genres]);

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

  // A reload (retry button, post-projection refresh) rebuilds every ObsTrack —
  // re-point the selection at the new object so the highlight ring and wiring
  // don't sit on stale coordinates (or on a mock node after recovery).
  useEffect(() => {
    setSelected((cur) => (cur ? (byId.get(cur.id) ?? null) : cur));
  }, [byId]);

  // Top search hits for the jump-to dropdown: title matches first, then any
  // other field match, single pass with an early exit so a keystroke never
  // pays more than one O(n) scan even at the 500k cap.
  const searchHits = useMemo(() => {
    const qq = qDebounced.trim().toLowerCase();
    if (!qq) return [];
    const primary: ObsTrack[] = [];
    const secondary: ObsTrack[] = [];
    for (const t of matched) {
      if ((t.title || '').toLowerCase().includes(qq)) {
        primary.push(t);
        if (primary.length >= 8) break;
      } else if (secondary.length < 8) {
        secondary.push(t);
      }
    }
    return primary.concat(secondary).slice(0, 8);
  }, [matched, qDebounced]);

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

  // ---- deep links: ?track=<id> applied once the real library arrives --------
  // Captured ONCE at mount: the URL-sync effect below rewrites the query string
  // from the (initially empty) selection before the library has loaded, so by
  // the time tracks exist the live URL no longer carries the param.
  const initialTrack = useRef<string | null>(
    typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('track'),
  );
  const deepLinked = useRef(false);
  useEffect(() => {
    if (!lib || lib.mock || deepLinked.current) return;
    deepLinked.current = true;
    const id = initialTrack.current;
    if (!id) return;
    const t = byId.get(id);
    if (t) jumpTo(t);
  }, [lib, byId, jumpTo]);

  // …and kept in sync (replaceState — no navigation, no history spam).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    if (selected && !lib?.mock) sp.set('track', selected.id);
    else sp.delete('track');
    if (colorBy !== 'energy') sp.set('color', colorBy);
    else sp.delete('color');
    const qs = sp.toString();
    const next = window.location.pathname + (qs ? `?${qs}` : '');
    if (next !== window.location.pathname + window.location.search) {
      window.history.replaceState(null, '', next);
    }
  }, [selected, colorBy, lib]);

  // ---- Escape backs out: dossier first, then the search query ---------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (selected) setSelected(null);
      else if (q) setQ('');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, q]);

  // ---- sound-map projection: status + manual trigger ------------------------
  // Adopt the status that rode the bulk load, then poll the lightweight status
  // endpoint while a run is live; when it finishes, reload the map so the new
  // coordinates (and the entrance animation they deserve) come in.
  const [proj, setProj] = useState<MapProjectionStatus | null>(null);
  const [projBusy, setProjBusy] = useState(false);
  useEffect(() => {
    setProj(lib?.mapProjection ?? null);
  }, [lib]);
  useEffect(() => {
    if (!proj?.running) return;
    let cancelled = false;
    const id = setInterval(async () => {
      try {
        const res = await adminFetch('/library/observatory/projection');
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as MapProjectionStatus;
        if (cancelled) return;
        setProj(body);
        if (!body.running) reload();
      } catch {
        /* transient — keep polling */
      }
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [proj?.running, adminFetch, reload]);
  const startProjection = useCallback(async () => {
    setProjBusy(true);
    try {
      const res = await adminFetch('/library/observatory/project', { method: 'POST' });
      const body = await res.json().catch(() => null);
      if (body?.status) setProj(body.status as MapProjectionStatus);
    } catch {
      /* button stays; operator can retry */
    } finally {
      setProjBusy(false);
    }
  }, [adminFetch]);

  // ---- queue a track on air (the dossier's QUEUE button) ---------------------
  const queueTrack = useCallback(
    async (t: ObsTrack): Promise<{ ok: boolean; message: string }> => {
      try {
        const res = await adminFetch('/dj/queue-track', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: t.id,
            title: t.title || 'Untitled',
            artist: t.artist,
            album: t.album,
            year: t.year,
            genre: t.genre,
          }),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) return { ok: false, message: body?.error || `queue failed (${res.status})` };
        return { ok: true, message: 'queued' };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : 'queue failed' };
      }
    },
    [adminFetch],
  );

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

  const projLastLine = proj?.lastLog?.length ? proj.lastLog[proj.lastLog.length - 1] : null;

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
          {lib?.mock ? (
            <span className="obs-stat t-nums">{total} TRACKS</span>
          ) : (
            <label className="obs-top-max">
              <span className="obs-stat">MAP SIZE</span>
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
            </label>
          )}
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
          <span className="obs-vsep" />
          <button className="obs-top-reset" onClick={onReset}>
            RESET DIAL
          </button>
        </div>
      </header>

      {/* load failures never blank the view (the sample map fills in) — but
          they must not masquerade as a fresh install either */}
      {error && (
        <div className="obs-error" role="alert">
          <span>
            COULDN&apos;T LOAD THE LIBRARY ({error})
            {lib?.mock ? ' — SHOWING SAMPLE DATA' : ' — SHOWING THE LAST GOOD MAP'}
          </span>
          <button onClick={reload} disabled={loading}>
            {loading ? 'RETRYING…' : 'RETRY'}
          </button>
        </div>
      )}

      <div className="obs-main">
        {/* filter rail */}
        <aside className="obs-rail">
          <div className="rail-search-wrap">
            <div className="rail-search">
              <span className="rail-search-ico">♪</span>
              <input
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setSearchOpen(true); // typing reopens after a pick closed it
                }}
                onFocus={() => setSearchOpen(true)}
                onBlur={() => setSearchOpen(false)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && searchHits.length) {
                    jumpTo(searchHits[0]!);
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                placeholder="scanning the dial…"
                aria-label="search the library"
              />
            </div>
            {searchOpen && searchHits.length > 0 && (
              <div className="rail-search-results" role="listbox">
                {searchHits.map((t) => (
                  <button
                    key={t.idx}
                    className="rail-search-hit"
                    role="option"
                    aria-selected={selected?.idx === t.idx}
                    // mousedown, not click — it must beat the input's blur
                    onMouseDown={(e) => {
                      e.preventDefault();
                      jumpTo(t);
                      setSearchOpen(false);
                    }}
                  >
                    <span className="hit-title">{t.title || 'Untitled'}</span>
                    <span className="hit-artist">
                      {t.artist || 'Unknown'}
                      {t.genre ? ` · ${t.genre}` : ''}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="rail-sec">
            <div className="rail-label">COLOUR BY</div>
            <div className="flt-grid2">
              {COLOR_MODES.map(([k, l]) => (
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
                {visibleGenres.map((g) => (
                  <button key={g} className={'flt-chip' + (genres.has(g) ? ' on' : '')} onClick={() => toggleIn(setGenres)(g)}>
                    {g}
                  </button>
                ))}
                {genreOptions.length > GENRE_CHIP_CAP && (
                  <button className="flt-chip flt-chip-more" onClick={() => setGenresExpanded((v) => !v)}>
                    {genresExpanded ? '− less' : `+ ${genreOptions.length - GENRE_CHIP_CAP} more`}
                  </button>
                )}
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

          <div className="rail-foot">
            <div className="rail-count">
              <span className="t-nums acc">{matched.length}</span> <span className="ad-muted">/ {total} IN VIEW</span>
            </div>
            <div className="ad-muted t-caption">
              GALAXY RENDERER · {lib?.soundMap ? 'PLACED BY SOUND' : 'PLACED BY GENRE'}
            </div>
            {!lib?.mock &&
              proj &&
              (proj.running ? (
                <div className="rail-proj">
                  <span className="rail-proj-live t-caption">
                    <span className="obs-live-dot" /> PROJECTING SOUND MAP…
                  </span>
                  {projLastLine && <span className="ad-muted t-caption rail-proj-log">{projLastLine}</span>}
                </div>
              ) : proj.audioVectors >= PROJECTION_MIN_VECTORS ? (
                <div className="rail-proj">
                  {proj.stale && (
                    <span className="t-caption" style={{ color: 'var(--accent)' }}>
                      SOUND MAP OUT OF DATE
                    </span>
                  )}
                  <button className="flt-tog wide" onClick={startProjection} disabled={projBusy}>
                    {projBusy ? 'STARTING…' : proj.meta ? 'RE-PROJECT SOUND MAP' : 'PROJECT SOUND MAP'}
                  </button>
                </div>
              ) : null)}
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
              focus={focusOn}
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
                onSelect={jumpTo}
                onClose={() => setSelected(null)}
                onQueue={lib.mock ? undefined : queueTrack}
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

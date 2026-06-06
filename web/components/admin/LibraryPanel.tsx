'use client';

// Library — /admin/library (redesigned).
//
// One merged "Your DJ knows X%" tagging panel up top — coverage, the primary
// Start-tagging action, and progressive-disclosure Maintenance & log — then a
// clearer browse/search/untagged experience:
//   • Recently added — newest album tracks for quick discovery.
//   • Browse — filters the tagged moods index (mood/energy/genre/year/q).
//   • Search — Navidrome free-text (the legacy /dj/search path).
//   • Untagged — paginates through library tracks that haven't been tagged yet.
//
// Rows carry album art (via the public /cover/:id proxy, letter-tile fallback)
// and inline mood/energy tags so operators *see* what tagging produces. Each
// row supports Queue (push to the live queue) and, where applicable, Retag /
// Tag (single-track LLM classification via /library/retag).
//
// All colours come from theme tokens (the operator picks a theme in Settings),
// so the page renders correctly under every palette — no hardcoded hex.

import type { ChangeEvent, FormEvent, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Search, RotateCcw, Sparkles, Activity, Play, Square, ChevronDown, ChevronRight,
  Terminal, RefreshCw, ListPlus, X,
} from 'lucide-react';
import { useAdminAuth, ADMIN_API_URL } from '../../lib/adminAuth';
import { useDynamicStyle } from '../../hooks/useDynamicStyle';
import { notify, errorMessage } from '../../lib/notify';
import { Input } from '../ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '../ui/input-group';
import { Field, FieldLabel } from '../ui/field';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '../ui/select';
import { Card, Btn, Eyebrow } from './ui';
import { V3AlertDialog } from '../ui/alert-dialog';
import { cn } from '../../lib/cn';

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------
interface Track {
  id: string;
  title?: string;
  artist?: string;
  album?: string;
  year?: number | string | null;
  genre?: string | null;
  duration?: number | null;
  moods?: string[];
  energy?: string | null;
  taggedAt?: string;
}

interface BrowseResponse {
  rows: Track[];
  total: number;
  moodVocab: string[];
  stats: {
    total: number;
    byMood: Record<string, number>;
    byEnergy: Record<string, number>;
    byGenre: Record<string, number>;
    updatedAt: string | null;
  };
}

interface UntaggedResponse { rows: Track[]; nextCursor: string | null }

interface Coverage {
  tagged: number;
  analysed: number;
  total: number | null;
  percent: number | null;
  analysedPercent: number | null;
  scannedAt: string | null;
  scanning: boolean;
  // null = still probing; false = no analysis backend (sidecar/librosa) running.
  analysisAvailable?: boolean | null;
  analysisBackend?: string | null;
}

interface TaggerState {
  running?: boolean;
  pid?: number;
  startedAt?: string;
  lastLog?: string[];
}

// libraryStats rides along on /settings — gives moods-in-use, last-tag time,
// and withEmbedding (used to nudge a re-embed after a model swap) without an
// extra request and regardless of which tab is active.
interface LibraryStatsLite {
  total: number;
  byMood: Record<string, number>;
  byEnergy: Record<string, number>;
  byGenre: Record<string, number>;
  withEmbedding: number;
  updatedAt: string | null;
}

interface SettingsResponse { tagger?: TaggerState; libraryStats?: LibraryStatsLite }

type Tab = 'recent' | 'browse' | 'search' | 'untagged';
type Sort = 'artist' | 'title' | 'year' | 'taggedAt';
type Energy = 'any' | 'low' | 'medium' | 'high';
type Batch = '100' | '500' | 'all';

type RescanOpts = {
  reseed?: boolean;
  reEnrich?: boolean;
  reAnalyze?: boolean;
  upgrade?: boolean;
};

const PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// small shared parts
// ---------------------------------------------------------------------------
function EnergyMeter({ level }: { level?: string | null }) {
  const cls = level === 'high' ? 'h' : level === 'medium' ? 'm' : level === 'low' ? 'l' : '';
  return (
    <span className={cn('lib-emeter', cls)} aria-hidden>
      <span /><span /><span />
    </span>
  );
}

// Album thumbnail via the public /cover/:id proxy, with a letter-tile fallback
// when art is missing or the request errors. The fallback is token-coloured so
// it never clashes with the active theme.
function Thumb({ track }: { track: Track }) {
  const [errored, setErrored] = useState(false);
  const letter = (track.album || track.title || track.artist || '?').trim()[0]?.toUpperCase() || '?';
  const showImg = !!track.id && !errored;
  return (
    <span className="lib-thumb">
      {showImg ? (
         
        <img
          src={`${ADMIN_API_URL}/cover/${encodeURIComponent(track.id)}`}
          alt=""
          loading="lazy"
          onError={() => setErrored(true)}
        />
      ) : letter}
    </span>
  );
}

function num(n: number | null | undefined): string {
  return n != null ? n.toLocaleString('en-GB') : '—';
}

// ---------------------------------------------------------------------------
// panel
// ---------------------------------------------------------------------------
export default function LibraryPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const ready = hydrated && !needsAuth;

  // shared state
  const [tab, setTab] = useState<Tab>('recent');
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [tagger, setTagger] = useState<TaggerState | null>(null);
  const [libStats, setLibStats] = useState<LibraryStatsLite | null>(null);
  const [batch, setBatch] = useState<Batch>('500');
  const [taggerBusy, setTaggerBusy] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [queuing, setQueuing] = useState<string | null>(null);
  const [retagging, setRetagging] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);

  // live-run progress baseline (best-effort: coverage delta vs. a captured
  // target — the backend has no per-run counter). Set when WE start a run.
  const [runInfo, setRunInfo] = useState<{ baseline: number; target: number | null } | null>(null);

  // browse state
  const [moods, setMoods] = useState<string[]>([]);
  const [energy, setEnergy] = useState<Energy>('any');
  const [genre, setGenre] = useState<string>('');
  const [yearFrom, setYearFrom] = useState<string>('');
  const [yearTo, setYearTo] = useState<string>('');
  const [q, setQ] = useState<string>('');
  const [sort, setSort] = useState<Sort>('artist');
  const [page, setPage] = useState(0);
  const [browse, setBrowse] = useState<BrowseResponse | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);

  // genre list (lazy)
  const [genreList, setGenreList] = useState<{ value: string; songCount: number }[]>([]);

  // search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Track[] | null>(null);
  const [searching, setSearching] = useState(false);

  // untagged state
  const [untagged, setUntagged] = useState<Track[]>([]);
  const [untaggedCursor, setUntaggedCursor] = useState<string | null>(null);
  const [untaggedLoading, setUntaggedLoading] = useState(false);

  // recent state
  const [recent, setRecent] = useState<Track[] | null>(null);
  const [recentLoading, setRecentLoading] = useState(false);

  // -----------------------------------------------------------------------
  // polling — coverage (60 s) + tagger status (3 s while running, 10 s idle)
  // -----------------------------------------------------------------------
  const loadCoverage = useCallback(async () => {
    if (!ready) return;
    try {
      const r = await adminFetch('/library/coverage');
      if (!r.ok) return;
      setCoverage((await r.json()) as Coverage);
    } catch { /* transient */ }
  }, [adminFetch, ready]);

  const loadTagger = useCallback(async () => {
    if (!ready) return;
    try {
      const r = await adminFetch('/settings');
      if (!r.ok) return;
      const j = (await r.json()) as SettingsResponse;
      setTagger(j.tagger || null);
      if (j.libraryStats) setLibStats(j.libraryStats);
    } catch { /* transient */ }
  }, [adminFetch, ready]);

  useEffect(() => {
    if (!ready) return;
    loadCoverage();
    const id = setInterval(loadCoverage, 60_000);
    return () => clearInterval(id);
  }, [ready, loadCoverage]);

  useEffect(() => {
    if (!ready) return;
    loadTagger();
    const interval = tagger?.running ? 3_000 : 10_000;
    const id = setInterval(loadTagger, interval);
    return () => clearInterval(id);
  }, [ready, loadTagger, tagger?.running]);

  // While a run is live, poll coverage faster so the % visibly climbs.
  useEffect(() => {
    if (!ready || !tagger?.running) return;
    const id = setInterval(loadCoverage, 3_000);
    return () => clearInterval(id);
  }, [ready, tagger?.running, loadCoverage]);

  // Clear the run baseline once the tagger stops.
  useEffect(() => {
    if (!tagger?.running) setRunInfo(null);
  }, [tagger?.running]);

  // -----------------------------------------------------------------------
  // browse fetch — debounced on filter change
  // -----------------------------------------------------------------------
  const runBrowse = useCallback(async () => {
    if (!ready) return;
    setBrowseLoading(true);
    try {
      const params = new URLSearchParams();
      if (moods.length) params.set('moods', moods.join(','));
      if (energy !== 'any') params.set('energy', energy);
      if (genre) params.set('genre', genre);
      if (yearFrom) params.set('yearFrom', yearFrom);
      if (yearTo) params.set('yearTo', yearTo);
      if (q.trim()) params.set('q', q.trim());
      params.set('sort', sort);
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(page * PAGE_SIZE));
      const r = await adminFetch(`/library/browse?${params}`);
      if (!r.ok) throw new Error(`browse failed (${r.status})`);
      setBrowse((await r.json()) as BrowseResponse);
    } catch (err) {
      notify.err(errorMessage(err));
      setBrowse(null);
    } finally {
      setBrowseLoading(false);
    }
  }, [adminFetch, ready, moods, energy, genre, yearFrom, yearTo, q, sort, page]);

  useEffect(() => {
    if (!ready || tab !== 'browse') return;
    const t = setTimeout(runBrowse, 250);
    return () => clearTimeout(t);
  }, [ready, tab, runBrowse]);

  // genre dropdown — fetch once
  useEffect(() => {
    if (!ready || genreList.length) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await adminFetch('/library/genres');
        if (!r.ok) return;
        const j = await r.json() as { genres: { value: string; songCount: number }[] };
        if (!cancelled) setGenreList(j.genres || []);
      } catch { /* skip */ }
    })();
    return () => { cancelled = true; };
  }, [ready, adminFetch, genreList.length]);

  // reset to page 0 when any filter (other than page itself) changes
  useEffect(() => { setPage(0); }, [moods, energy, genre, yearFrom, yearTo, q, sort]);

  // -----------------------------------------------------------------------
  // search fetch
  // -----------------------------------------------------------------------
  const runSearch = async (e?: FormEvent<HTMLFormElement>) => {
    e?.preventDefault();
    const text = searchQuery.trim();
    if (!text || !ready) return;
    setSearching(true);
    try {
      const r = await adminFetch(`/dj/search?q=${encodeURIComponent(text)}`);
      const j = await r.json().catch(() => ({})) as { results?: Track[]; error?: string };
      if (!r.ok) throw new Error(j.error || `search failed (${r.status})`);
      setSearchResults(j.results || []);
    } catch (err) {
      notify.err(errorMessage(err));
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  };

  // -----------------------------------------------------------------------
  // untagged paging
  // -----------------------------------------------------------------------
  const loadUntagged = useCallback(async (cursor: string | null, append: boolean) => {
    if (!ready) return;
    setUntaggedLoading(true);
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (cursor) params.set('cursor', cursor);
      const r = await adminFetch(`/library/untagged?${params}`);
      if (!r.ok) throw new Error(`untagged failed (${r.status})`);
      const j = await r.json() as UntaggedResponse;
      setUntagged(prev => (append ? [...prev, ...j.rows] : j.rows));
      setUntaggedCursor(j.nextCursor);
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setUntaggedLoading(false);
    }
  }, [adminFetch, ready]);

  useEffect(() => {
    if (tab !== 'untagged' || !ready) return;
    if (untagged.length === 0) loadUntagged(null, false);
  }, [tab, ready, untagged.length, loadUntagged]);

  // -----------------------------------------------------------------------
  // recent fetch
  // -----------------------------------------------------------------------
  const loadRecent = useCallback(async () => {
    if (!ready) return;
    setRecentLoading(true);
    try {
      const r = await adminFetch('/dj/recent?limit=50');
      if (!r.ok) throw new Error(`recent failed (${r.status})`);
      const j = await r.json() as { results: Track[] };
      setRecent(j.results || []);
    } catch (err) {
      notify.err(errorMessage(err));
      setRecent([]);
    } finally {
      setRecentLoading(false);
    }
  }, [adminFetch, ready]);

  useEffect(() => {
    if (tab !== 'recent' || !ready) return;
    if (recent === null) loadRecent();
  }, [tab, ready, recent, loadRecent]);

  // -----------------------------------------------------------------------
  // row actions
  // -----------------------------------------------------------------------
  const queueTrack = async (track: Track) => {
    setQueuing(track.id);
    try {
      const r = await adminFetch('/dj/queue-track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(track),
      });
      const j = await r.json().catch(() => ({})) as { queuePosition?: number; error?: string };
      if (!r.ok) throw new Error(j.error || `queue failed (${r.status})`);
      notify.ok(`queued “${track.title}” · position ${j.queuePosition}`);
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setQueuing(null);
    }
  };

  const retagTrack = async (track: Track) => {
    setRetagging(track.id);
    try {
      const r = await adminFetch('/library/retag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(track),
      });
      const j = await r.json() as { moods?: string[]; energy?: string | null; error?: string };
      if (!r.ok) throw new Error(j.error || `retag failed (${r.status})`);
      const tagStr = j.moods?.length ? j.moods.join(', ') : '—';
      notify.ok(`retagged · ${tagStr} [${j.energy || '?'}]`);
      setFlashId(track.id);
      setTimeout(() => setFlashId(curr => (curr === track.id ? null : curr)), 1100);
      if (tab === 'browse') runBrowse();
      if (tab === 'untagged') setUntagged(prev => prev.filter(t => t.id !== track.id));
      loadCoverage();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setRetagging(null);
    }
  };

  // -----------------------------------------------------------------------
  // tagger controls
  // -----------------------------------------------------------------------
  const remaining = coverage?.total != null ? Math.max(0, coverage.total - coverage.tagged) : null;

  const startTagger = async () => {
    setTaggerBusy(true);
    try {
      const limit = batch === 'all' ? null : parseInt(batch, 10);
      const target = batch === 'all' ? remaining : limit;
      const r = await adminFetch('/tag-library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(limit && limit > 0 ? { limit } : {}),
      });
      const j = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) throw new Error(j.error || `tagger start failed (${r.status})`);
      notify.ok('tagger started');
      setLogOpen(true);
      setRunInfo({ baseline: coverage?.tagged ?? 0, target: target ?? null });
      await loadTagger();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setTaggerBusy(false);
    }
  };

  const stopTagger = async () => {
    setTaggerBusy(true);
    try {
      const r = await adminFetch('/tag-library/stop', { method: 'POST' });
      const j = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) throw new Error(j.error || `tagger stop failed (${r.status})`);
      notify.ok('stopping tagger…');
      await loadTagger();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setTaggerBusy(false);
    }
  };

  // Re-scan with explicit flags — each maps to a tag-library CLI flag:
  //   reseed     drop + rebuild every embedding from scratch (model-swap recovery)
  //   reEnrich   re-fetch Last.fm tags + lyrics that feed the embeddings
  //   reAnalyze  redo acoustic bpm/key analysis
  //   upgrade    re-LLM-tag only rows whose prompt/model is stale
  // Sends no limit — a partial reseed leaves the library in a mixed state KNN
  // can't use. Existing mood tags survive as seeds, so a reseed re-spends
  // embedding calls, not LLM.
  const rescanTagger = async (opts: RescanOpts) => {
    setTaggerBusy(true);
    try {
      const r = await adminFetch('/tag-library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      });
      const j = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) throw new Error(j.error || `re-scan failed (${r.status})`);
      notify.ok('re-scan started…');
      setLogOpen(true);
      await loadTagger();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setTaggerBusy(false);
    }
  };

  // -----------------------------------------------------------------------
  // derived
  // -----------------------------------------------------------------------
  const stats = browse?.stats;
  const moodVocab = browse?.moodVocab || [];
  const moodCounts = stats?.byMood || libStats?.byMood || {};
  const energyCounts = stats?.byEnergy || libStats?.byEnergy || {};
  const totalPages = browse ? Math.max(1, Math.ceil(browse.total / PAGE_SIZE)) : 1;
  const filtersActive =
    moods.length > 0 || energy !== 'any' || !!genre || !!yearFrom || !!yearTo || !!q.trim();

  const clearFilters = () => {
    setMoods([]); setEnergy('any'); setGenre(''); setYearFrom(''); setYearTo(''); setQ('');
    setSort('artist'); setPage(0);
  };

  const counts = {
    browse: coverage?.tagged ?? libStats?.total ?? null,
    untagged: remaining,
    recent: recent?.length ?? null,
  };

  const tableRows: Track[] =
    tab === 'browse' ? (browse?.rows || []) :
    tab === 'search' ? (searchResults || []) :
    tab === 'untagged' ? untagged :
    (recent || []);
  const tableLoading =
    tab === 'browse' ? browseLoading :
    tab === 'search' ? searching :
    tab === 'untagged' ? untaggedLoading :
    recentLoading;

  return (
    <div className="grid gap-5">
      <TaggingPanel
        coverage={coverage}
        libStats={libStats}
        tagger={tagger}
        runInfo={runInfo}
        batch={batch}
        setBatch={setBatch}
        busy={taggerBusy}
        logOpen={logOpen}
        setLogOpen={setLogOpen}
        onStart={startTagger}
        onStop={stopTagger}
        onRescan={rescanTagger}
      />

      <Tabs tab={tab} setTab={setTab} counts={counts} />

      {/* contextual controls */}
      {tab === 'browse' && (
        <BrowseFilters
          moodVocab={moodVocab}
          moodCounts={moodCounts}
          energyCounts={energyCounts}
          genreList={genreList}
          moods={moods} setMoods={setMoods}
          energy={energy} setEnergy={setEnergy}
          genre={genre} setGenre={setGenre}
          yearFrom={yearFrom} setYearFrom={setYearFrom}
          yearTo={yearTo} setYearTo={setYearTo}
          q={q} setQ={setQ}
          sort={sort} setSort={setSort}
        />
      )}

      {tab === 'browse' && filtersActive && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
          <span className="caption">active</span>
          {moods.map(m => (
            <span key={m} className="lib-active-chip">
              {m}<button type="button" onClick={() => setMoods(moods.filter(x => x !== m))} aria-label={`remove ${m}`}>×</button>
            </span>
          ))}
          {energy !== 'any' && (
            <span className="lib-active-chip">{energy} energy<button type="button" onClick={() => setEnergy('any')} aria-label="remove energy">×</button></span>
          )}
          {genre && (
            <span className="lib-active-chip">{genre}<button type="button" onClick={() => setGenre('')} aria-label="remove genre">×</button></span>
          )}
          {(yearFrom || yearTo) && (
            <span className="lib-active-chip">{yearFrom || '…'}–{yearTo || '…'}<button type="button" onClick={() => { setYearFrom(''); setYearTo(''); }} aria-label="remove year">×</button></span>
          )}
          {q.trim() && (
            <span className="lib-active-chip">“{q.trim()}”<button type="button" onClick={() => setQ('')} aria-label="remove search">×</button></span>
          )}
          <button type="button" className="inline-flex items-center gap-1 font-bold text-muted hover:text-ink" onClick={clearFilters}>
            <X size={12} /> clear all
          </button>
        </div>
      )}

      {tab === 'search' && (
        <Card bodyClass="!py-3">
          <form onSubmit={runSearch} className="grid grid-cols-[1fr_auto_auto] gap-2">
            <InputGroup>
              <InputGroupAddon><Search /></InputGroupAddon>
              <InputGroupInput
                placeholder="floating points, kingdoms in colour, 2018…"
                value={searchQuery}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
              />
            </InputGroup>
            <Btn tone="accent" type="submit" disabled={searching || !searchQuery.trim() || !ready}>
              {searching ? 'Searching…' : 'Search'}
            </Btn>
            <Btn type="button" onClick={() => { setSearchQuery(''); setSearchResults(null); }} disabled={searching}>
              Clear
            </Btn>
          </form>
        </Card>
      )}

      {/* track list */}
      <Card
        title={
          tab === 'browse' ? 'Tracks' :
          tab === 'search' ? 'Search results' :
          tab === 'untagged' ? 'Untagged' :
          'Recently added'
        }
        sub={
          tab === 'browse'
            ? (browse ? `${num(browse.total)} match${browse.total === 1 ? '' : 'es'}` : '')
            : tab === 'search' ? (searchResults ? `${searchResults.length} result${searchResults.length === 1 ? '' : 's'}` : 'enter a query')
            : tab === 'untagged' ? `${untagged.length} loaded${remaining != null ? ` · ${num(remaining)} need tags` : ''}`
            : (recent ? `${recent.length} tracks` : '')
        }
        right={
          tab === 'untagged' && untagged.length > 0 ? (
            <Btn sm tone="accent" onClick={startTagger} disabled={tagger?.running || taggerBusy}>
              <Sparkles size={11} /> Tag all
            </Btn>
          ) : tab === 'recent' ? (
            <Btn sm onClick={loadRecent} disabled={recentLoading}>
              <RefreshCw size={11} /> {recentLoading ? 'Loading…' : 'Refresh'}
            </Btn>
          ) : null
        }
        bodyClass="!p-0"
      >
        <TrackTable
          tab={tab}
          rows={tableRows}
          loading={tableLoading}
          queuing={queuing}
          retagging={retagging}
          flashId={flashId}
          onQueue={queueTrack}
          onRetag={retagTrack}
        />
      </Card>

      {tab === 'browse' && browse && browse.total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-[11px] text-muted">
          <span className="mono-num">
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, browse.total)} of {num(browse.total)}
          </span>
          <span className="flex items-center gap-2">
            <Btn sm disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))}>‹ prev</Btn>
            <span className="mono-num">page {page + 1} of {totalPages}</span>
            <Btn sm disabled={page + 1 >= totalPages} onClick={() => setPage(p => p + 1)}>next ›</Btn>
          </span>
        </div>
      )}

      {tab === 'untagged' && untaggedCursor && (
        <div className="flex justify-center">
          <Btn onClick={() => loadUntagged(untaggedCursor, true)} disabled={untaggedLoading}>
            {untaggedLoading ? 'Loading…' : 'Load more'}
          </Btn>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// tagging panel — merged coverage + tagger, framed for humans
// ---------------------------------------------------------------------------
interface TaggingPanelProps {
  coverage: Coverage | null;
  libStats: LibraryStatsLite | null;
  tagger: TaggerState | null;
  runInfo: { baseline: number; target: number | null } | null;
  batch: Batch;
  setBatch: (b: Batch) => void;
  busy: boolean;
  logOpen: boolean;
  setLogOpen: (fn: (o: boolean) => boolean) => void;
  onStart: () => void;
  onStop: () => void;
  onRescan: (opts: RescanOpts) => void;
}

function TaggingPanel(p: TaggingPanelProps) {
  const [maintOpen, setMaintOpen] = useState(false);
  const [confirmFull, setConfirmFull] = useState(false);
  const [passes, setPasses] = useState<RescanOpts>({ reseed: false, reEnrich: false, reAnalyze: false, upgrade: false });
  const logRef = useRef<HTMLPreElement>(null);
  const moodFillRef = useRef<HTMLSpanElement>(null);
  const acousticFillRef = useRef<HTMLSpanElement>(null);
  const runFillRef = useRef<HTMLSpanElement>(null);

  const tagged = p.coverage?.tagged ?? p.libStats?.total ?? null;
  const total = p.coverage?.total ?? null;
  const analysed = p.coverage?.analysed ?? null;
  const pct = p.coverage?.percent ?? null;
  const apct = p.coverage?.analysedPercent ?? null;
  const remaining = total != null && tagged != null ? Math.max(0, total - tagged) : null;
  const running = !!p.tagger?.running;
  const analysisOff = p.coverage?.analysisAvailable === false;
  const moodCount = p.libStats ? Object.keys(p.libStats.byMood || {}).length : 0;
  const lastTag = p.libStats?.updatedAt ? new Date(p.libStats.updatedAt).toLocaleString('en-GB') : '—';
  const anySel = !!(passes.reseed || passes.reEnrich || passes.reAnalyze || passes.upgrade);

  // Embeddings present but no vectors → likely a model swap dropped them.
  const embeddingMissing = (tagged ?? 0) > 0 && p.libStats != null && p.libStats.withEmbedding === 0;

  // live-run progress (best-effort: coverage delta vs. captured target)
  const processed = p.runInfo && tagged != null ? Math.max(0, tagged - p.runInfo.baseline) : null;
  const runPct = p.runInfo?.target && processed != null
    ? Math.min(100, Math.round((processed / p.runInfo.target) * 100)) : null;

  useDynamicStyle(moodFillRef, { width: pct != null ? `${Math.min(100, pct)}%` : '0%' });
  useDynamicStyle(acousticFillRef, { width: !analysisOff && apct != null ? `${Math.min(100, apct)}%` : '0%' });
  useDynamicStyle(runFillRef, { width: runPct != null ? `${runPct}%` : null });

  useEffect(() => {
    if (p.logOpen && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [p.logOpen, p.tagger?.lastLog?.length]);

  const togglePass = (k: keyof RescanOpts) => setPasses(prev => ({ ...prev, [k]: !prev[k] }));

  return (
    <section className="card">
      {/* headline */}
      <div className="border-b border-ink p-6">
        <Eyebrow className="text-vermilion">library · tagging</Eyebrow>
        <h1 className="lib-hero-title">
          {pct != null
            ? <>Your DJ knows <span className="pct mono-num">{pct}%</span> of your library.</>
            : <>Manage the music your station plays.</>}
        </h1>
        <p className="lib-hero-sub">
          To pick the right track for any moment, the DJ reads the <b>mood</b> and <b>energy</b> of
          every song. New tracks need tagging before they can go on air — that&rsquo;s what this does.
        </p>
      </div>

      {/* coverage — mood primary, acoustic optional */}
      <div className="border-b border-ink">
        <div className="p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <span className="flex items-center gap-2 text-[11px] font-bold tracking-[0.16em] text-ink uppercase">
              <Sparkles size={14} /> Mood &amp; energy tagged
            </span>
            <span className="mono-num text-[13px] font-bold">{pct != null ? `${pct}%` : '—'}</span>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="lib-cov-big mono-num">{num(tagged)}</span>
            <span className="text-[13px] text-muted">/ {total != null ? num(total) : (p.coverage?.scanning ? 'scanning…' : '—')} tracks</span>
          </div>
          <div className="lib-bar mt-3"><span ref={moodFillRef} /></div>
          <div className="mt-2.5 text-[11px] text-muted">
            {remaining != null && remaining > 0
              ? <><b className="mono-num text-ink">{num(remaining)}</b> tracks still need tags · <span className="mono-num">{moodCount}</span> moods in use · last tag {lastTag}</>
              : <>{remaining === 0 ? 'Every track is tagged' : 'Coverage updating…'} · <span className="mono-num">{moodCount}</span> moods in use · last tag {lastTag}</>}
          </div>
          {embeddingMissing && (
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border border-[color-mix(in_oklab,var(--accent)_30%,transparent)] bg-[var(--accent-soft)] px-3 py-2 text-[11px] text-ink">
              <span><b>Embeddings missing.</b> Your embedding model may have changed — re-embed to restore similarity-based picks.</span>
              <button
                type="button"
                className="font-bold text-vermilion underline-offset-2 hover:underline"
                onClick={() => { setMaintOpen(true); setPasses(s => ({ ...s, reseed: true })); }}
              >
                Set up a re-embed →
              </button>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 border-t border-dashed border-separator-strong px-6 py-3.5">
          <span className="caption flex items-center gap-2">
            <Activity size={13} /> Acoustic analysis · bpm / key
          </span>
          <span className="lib-opt-tag">optional</span>
          <span className="lib-minibar"><span ref={acousticFillRef} /></span>
          <span className="caption mono-num !tracking-[0.04em]">
            {analysisOff ? 'engine off' : <>{num(analysed)} / {num(total)} · {apct != null ? `${apct}%` : '…'}</>}
          </span>
          <span className="caption basis-full !tracking-[0.04em] !normal-case">
            {analysisOff
              ? 'No analysis engine running. Start the tts-heavy sidecar (docker compose --profile tts-heavy up -d) or configure a local librosa venv to enable it.'
              : 'Improves beat-matching between tracks. Tagging works fine without it.'}
          </span>
        </div>
      </div>

      {/* action zone — idle vs running */}
      {!running ? (
        <div className="flex flex-wrap items-center gap-4 p-6">
          <div className="min-w-[220px] flex-1 text-[13px]">
            {remaining != null && remaining > 0
              ? <><b>{num(remaining)}</b> tracks are waiting. Tag them and they become DJ-ready.</>
              : remaining === 0
                ? <>Library fully tagged. Run a re-scan below if you&rsquo;ve changed the model.</>
                : <>Start tagging new tracks so the DJ can play them.</>}
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="lib-batch">
              <label htmlFor="lib-batch">Tag</label>
              <select id="lib-batch" value={p.batch} onChange={e => p.setBatch(e.target.value as Batch)}>
                <option value="100">next 100</option>
                <option value="500">next 500</option>
                <option value="all">all{remaining != null ? ` ${num(remaining)}` : ''} remaining</option>
              </select>
            </div>
            <Btn lg tone="accent" onClick={p.onStart} disabled={p.busy || remaining === 0}>
              <Play size={13} /> Start tagging
            </Btn>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3.5">
            <span className="flex items-center gap-2.5 text-[13px] font-bold">
              <span className="lib-livedot" /> Tagging in progress…
            </span>
            <span className="caption mono-num !tracking-[0.04em]">
              {processed != null && <>{num(processed)}{p.runInfo?.target ? ` / ${num(p.runInfo.target)}` : ''} this run · </>}
              {p.tagger?.pid ? `pid ${p.tagger.pid}` : ''}
              {p.tagger?.startedAt ? ` · started ${new Date(p.tagger.startedAt).toLocaleTimeString('en-GB')}` : ''}
            </span>
            <Btn sm tone="danger" onClick={p.onStop} disabled={p.busy}><Square size={11} /> Stop</Btn>
          </div>
          {runPct != null && (
            <div className="lib-bar !h-1.5"><span ref={runFillRef} /></div>
          )}
          <div className="caption !tracking-[0.04em] !normal-case">
            The DJ is listening to each new track and deciding its mood &amp; energy. You can keep
            browsing — this runs in the background.
          </div>
        </div>
      )}

      {/* footer — progressive disclosure */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-dashed border-separator-strong px-6 py-3">
        <button
          type="button"
          className={cn('inline-flex items-center gap-1.5 text-[11px] font-bold', maintOpen ? 'text-ink' : 'text-muted hover:text-ink')}
          onClick={() => setMaintOpen(o => !o)}
        >
          {maintOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Maintenance &amp; re-scan
        </button>
        <button
          type="button"
          className={cn('inline-flex items-center gap-1.5 text-[11px] font-bold', p.logOpen ? 'text-ink' : 'text-muted hover:text-ink')}
          onClick={() => p.setLogOpen(o => !o)}
        >
          <Terminal size={13} /> {p.logOpen ? 'Hide log' : 'View log'}
        </button>
      </div>

      {/* maintenance disclosure */}
      {maintOpen && (
        <div className="flex flex-col gap-3.5 border-t border-ink bg-[var(--ink-soft)] p-6">
          <div className="max-w-[64ch] text-[12px] leading-[1.55] text-muted">
            Re-scanning rebuilds parts of the index from scratch — only needed after you change the
            LLM, embedding model, or analysis engine. Your existing mood tags are kept as seeds.
            Pick what to re-run:
          </div>
          <div className="grid gap-2.5 sm:grid-cols-2">
            <Pass on={!!passes.reseed} onClick={() => togglePass('reseed')} name="Re-embed all tracks"
              hint="Drop & rebuild every vector. Run after changing the embedding model." />
            <Pass on={!!passes.reEnrich} onClick={() => togglePass('reEnrich')} name="Re-enrich metadata"
              hint="Re-fetch Last.fm tags + lyrics that feed the tagging." />
            <Pass on={!!passes.reAnalyze} onClick={() => togglePass('reAnalyze')} name="Re-analyse acoustics"
              hint="Redo BPM / key detection for every track." />
            <Pass on={!!passes.upgrade} onClick={() => togglePass('upgrade')} name="Re-decide moods"
              hint="Re-tag tracks whose prompt or model is now stale." />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Btn sm disabled={p.busy || running} onClick={() => setConfirmFull(true)}>
              <RefreshCw size={12} /> Full re-scan (everything)
            </Btn>
            <Btn sm tone="accent" disabled={!anySel || p.busy || running}
              onClick={() => { p.onRescan(passes); setPasses({ reseed: false, reEnrich: false, reAnalyze: false, upgrade: false }); }}>
              Run selected passes
            </Btn>
          </div>
        </div>
      )}

      {/* log drawer — reuses the theme-aware .term surface */}
      {p.logOpen && (
        <pre ref={logRef} className="term m-0 max-h-56 overflow-y-auto !border-t !border-l-0 border-separator-strong">
          {(p.tagger?.lastLog || []).join('\n') || '(no log output yet — start a tagging run to see the booth think)'}
        </pre>
      )}

      <V3AlertDialog
        open={confirmFull}
        onOpenChange={setConfirmFull}
        title="Full library re-scan"
        description="Rebuilds the whole library from scratch: re-embeds every track, re-fetches Last.fm tags + lyrics, and redoes acoustic (bpm/key) analysis. Existing mood tags are kept and reused as seeds — moods are not re-decided. This can take several minutes on a large library and re-spends embedding calls. To re-decide moods too, tick 'Re-decide moods' and use 'Run selected passes'."
        confirmLabel="full re-scan"
        danger
        onConfirm={() => p.onRescan({ reseed: true, reEnrich: true, reAnalyze: true })}
      />
    </section>
  );
}

function Pass({ on, onClick, name, hint }: { on: boolean; onClick: () => void; name: string; hint: string }) {
  return (
    <button type="button" className={cn('lib-pass', on && 'on')} onClick={onClick}>
      <span className="box">
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
          <path d="M2.5 6.2L4.8 8.5L9.5 3.5" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span>
        <span className="lib-pass-name">{name}</span>
        <span className="lib-pass-hint">{hint}</span>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// tabs
// ---------------------------------------------------------------------------
function Tabs({ tab, setTab, counts }: {
  tab: Tab;
  setTab: (t: Tab) => void;
  counts: { browse: number | null; untagged: number | null; recent: number | null };
}) {
  const items: { id: Tab; name: string; hint: string; badge: number | null }[] = [
    { id: 'recent', name: 'Recently added', hint: 'newest first', badge: counts.recent },
    { id: 'browse', name: 'Browse', hint: 'tagged index', badge: counts.browse },
    { id: 'search', name: 'Search', hint: 'navidrome', badge: null },
    { id: 'untagged', name: 'Untagged', hint: 'needs tags', badge: counts.untagged },
  ];
  return (
    <div className="lib-tabs">
      {items.map(it => (
        <button key={it.id} type="button" className={cn('lib-tab', tab === it.id && 'on')} onClick={() => setTab(it.id)}>
          <span className="lib-tab-name">
            {it.name}
            {it.badge != null && <span className="lib-tab-badge">{it.badge.toLocaleString('en-GB')}</span>}
          </span>
          <span className="lib-tab-hint">{it.hint}</span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// browse filters
// ---------------------------------------------------------------------------
interface BrowseFiltersProps {
  moodVocab: string[];
  moodCounts: Record<string, number>;
  energyCounts: Record<string, number>;
  genreList: { value: string; songCount: number }[];
  moods: string[]; setMoods: (m: string[]) => void;
  energy: Energy; setEnergy: (e: Energy) => void;
  genre: string; setGenre: (g: string) => void;
  yearFrom: string; setYearFrom: (s: string) => void;
  yearTo: string; setYearTo: (s: string) => void;
  q: string; setQ: (s: string) => void;
  sort: Sort; setSort: (s: Sort) => void;
}

function BrowseFilters(p: BrowseFiltersProps) {
  const [showAllMoods, setShowAllMoods] = useState(false);
  const ranked = useMemo(
    () => [...p.moodVocab].sort((a, b) => (p.moodCounts[b] || 0) - (p.moodCounts[a] || 0)),
    [p.moodVocab, p.moodCounts],
  );
  const shown = showAllMoods ? ranked : ranked.slice(0, 12);
  const toggleMood = (m: string) =>
    p.setMoods(p.moods.includes(m) ? p.moods.filter(x => x !== m) : [...p.moods, m]);

  const energyOpts: { id: Energy; label: ReactNode }[] = [
    { id: 'any', label: 'Any' },
    { id: 'low', label: <><EnergyMeter level="low" /> Low{p.energyCounts.low ? ` · ${p.energyCounts.low}` : ''}</> },
    { id: 'medium', label: <><EnergyMeter level="medium" /> Mid{p.energyCounts.medium ? ` · ${p.energyCounts.medium}` : ''}</> },
    { id: 'high', label: <><EnergyMeter level="high" /> High{p.energyCounts.high ? ` · ${p.energyCounts.high}` : ''}</> },
  ];

  return (
    <section className="card">
      {/* filter results text */}
      <div className="border-b border-dashed border-separator-strong p-4">
        <InputGroup>
          <InputGroupAddon><Search /></InputGroupAddon>
          <InputGroupInput
            placeholder="filter results by title, artist, or album…"
            value={p.q}
            onChange={(e: ChangeEvent<HTMLInputElement>) => p.setQ(e.target.value)}
          />
        </InputGroup>
      </div>

      {/* moods */}
      <div className="border-b border-dashed border-separator-strong p-4">
        <div className="caption mb-2.5">mood</div>
        <div className="flex flex-wrap gap-1.5">
          {shown.map(m => (
            <button key={m} type="button" className={cn('lib-chip', p.moods.includes(m) && 'on')} onClick={() => toggleMood(m)}>
              {m}<span className="n">{p.moodCounts[m] || 0}</span>
            </button>
          ))}
          {ranked.length > 12 && (
            <button type="button" className="lib-chip lib-chip-more" onClick={() => setShowAllMoods(s => !s)}>
              {showAllMoods ? '− less' : `+ ${ranked.length - 12} more`}
            </button>
          )}
        </div>
      </div>

      {/* energy / genre / year / sort */}
      <div className="flex flex-wrap items-end gap-x-5 gap-y-4 p-4">
        <div className="flex flex-col gap-2">
          <div className="caption">energy</div>
          <div className="flex flex-wrap border border-ink">
            {energyOpts.map((o, i) => (
              <button
                key={o.id}
                type="button"
                onClick={() => p.setEnergy(o.id)}
                className={cn(
                  'inline-flex items-center gap-1.5 px-3 py-2 text-[10px] font-bold tracking-[0.12em] uppercase',
                  i > 0 && 'border-l border-ink',
                  p.energy === o.id ? 'bg-ink text-bg' : 'text-ink hover:bg-[var(--ink-soft)]',
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Field>
            <FieldLabel htmlFor="genre">genre</FieldLabel>
            <Select value={p.genre || '__any'} onValueChange={v => p.setGenre(v === '__any' ? '' : v)}>
              <SelectTrigger id="genre" className="min-w-[150px]"><SelectValue placeholder="Any genre" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__any">Any genre</SelectItem>
                {p.genreList.slice(0, 80).map(g => (
                  <SelectItem key={g.value} value={g.value}>
                    {g.value}{g.songCount ? ` · ${g.songCount}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        <div className="flex flex-col gap-2">
          <div className="caption">year</div>
          <div className="flex items-center gap-2">
            <Input type="number" inputMode="numeric" placeholder="from" className="w-20" value={p.yearFrom} onChange={e => p.setYearFrom(e.target.value)} />
            <span className="text-[10px] text-muted">–</span>
            <Input type="number" inputMode="numeric" placeholder="to" className="w-20" value={p.yearTo} onChange={e => p.setYearTo(e.target.value)} />
          </div>
        </div>

        <div className="ml-auto flex flex-col gap-2">
          <Field>
            <FieldLabel htmlFor="sort">sort</FieldLabel>
            <Select value={p.sort} onValueChange={v => p.setSort(v as Sort)}>
              <SelectTrigger id="sort" className="min-w-[170px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="artist">Artist / album / title</SelectItem>
                <SelectItem value="title">Title</SelectItem>
                <SelectItem value="year">Year (newest first)</SelectItem>
                <SelectItem value="taggedAt">Recently tagged</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// track table
// ---------------------------------------------------------------------------
interface TrackTableProps {
  tab: Tab;
  rows: Track[];
  loading: boolean;
  queuing: string | null;
  retagging: string | null;
  flashId: string | null;
  onQueue: (t: Track) => void;
  onRetag: (t: Track) => void;
}

function TrackTable(p: TrackTableProps) {
  if (p.loading && p.rows.length === 0) {
    return <div className="px-4 py-8 text-center text-[12px] text-muted italic">loading…</div>;
  }
  if (p.rows.length === 0) {
    return (
      <div className="px-4 py-10 text-center text-[12px] text-muted italic">
        {p.tab === 'browse' && 'no tracks match — try clearing some filters'}
        {p.tab === 'search' && 'search your library to queue a track on demand'}
        {p.tab === 'untagged' && 'every track is tagged — nice'}
        {p.tab === 'recent' && 'nothing here yet'}
      </div>
    );
  }

  return (
    <div>
      <div className="lib-colhead">
        <span />
        <span>title</span>
        <span className="h-tags">mood · energy</span>
        <span className="h-album">album</span>
        <span />
      </div>
      {p.rows.map(t => {
        const tagged = !!(t.moods && t.moods.length > 0);
        return (
          <div key={t.id} className={cn('lib-row', p.flashId === t.id && 'flash')}>
            <Thumb track={t} />
            <div className="min-w-0">
              <div className="lib-title">{t.title || '—'}</div>
              <div className="lib-artist">{t.artist || '—'}{t.year ? ` · ${t.year}` : ''}</div>
            </div>
            <div className="lib-tags">
              {tagged ? (
                <>
                  {t.moods!.slice(0, 2).map(m => <span key={m} className="lib-mtag">{m}</span>)}
                  {t.energy && <span className="lib-mtag"><EnergyMeter level={t.energy} />{t.energy}</span>}
                </>
              ) : (
                <span className="lib-needs">needs tags</span>
              )}
            </div>
            <span className="lib-album">{t.album || '—'}</span>
            <div className="flex items-center justify-end gap-1.5">
              <Btn sm onClick={() => p.onQueue(t)} disabled={!!p.queuing}>
                {p.queuing === t.id ? '…' : <><ListPlus size={12} /> Queue</>}
              </Btn>
              {(p.tab === 'browse' || p.tab === 'untagged') && (
                <Btn
                  sm
                  tone={p.tab === 'untagged' || !tagged ? 'accent' : 'solid'}
                  onClick={() => p.onRetag(t)}
                  disabled={!!p.retagging}
                >
                  {p.retagging === t.id ? '…' : tagged
                    ? <><RotateCcw size={11} /> Retag</>
                    : <><Sparkles size={11} /> Tag</>}
                </Btn>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

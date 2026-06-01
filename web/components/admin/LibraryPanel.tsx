'use client';

// Library — /admin/library.
//
// Three tabs over the same chrome:
//   • Browse — filters the tagged moods.json index (mood/energy/genre/year/q).
//   • Search — Navidrome free-text (the legacy /dj/search path).
//   • Untagged — paginates through library tracks that haven't been tagged yet.
//   • Recently added — newest album tracks for quick discovery.
//
// Each row supports `Queue` (push to the live queue) and, where applicable,
// `Retag` / `Tag` (single-track LLM classification via /library/retag).
// A tagger strip below the header owns the background batch job.

import type { ChangeEvent, FormEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, RotateCcw } from 'lucide-react';
import { useAdminAuth } from '../../lib/adminAuth';
import { useDynamicStyle } from '../../hooks/useDynamicStyle';
import { notify, errorMessage } from '../../lib/notify';
import { Input } from '../ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '../ui/input-group';
import { Field, FieldLabel } from '../ui/field';
import { Checkbox } from '../ui/checkbox';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '../ui/select';
import { Card, Btn, Eyebrow, Seg } from './ui';
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

interface SettingsResponse { tagger?: TaggerState }

type Tab = 'browse' | 'search' | 'untagged' | 'recent';
type Sort = 'artist' | 'title' | 'year' | 'taggedAt';
type Energy = 'any' | 'low' | 'medium' | 'high';

const PAGE_SIZE = 50;

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
  const [taggerLimit, setTaggerLimit] = useState('500');
  const [taggerBusy, setTaggerBusy] = useState(false);
  const [queuing, setQueuing] = useState<string | null>(null);
  const [retagging, setRetagging] = useState<string | null>(null);

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
  const startTagger = async () => {
    setTaggerBusy(true);
    try {
      const limit = parseInt(taggerLimit, 10);
      const r = await adminFetch('/tag-library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
      });
      const j = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) throw new Error(j.error || `tagger start failed (${r.status})`);
      notify.ok('tagger started');
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

  // Full re-embed: drops + rebuilds the vector table from scratch. The recovery
  // path after changing the embedding model (its dim no longer matches the
  // stored vectors). Sends no limit — a partial reseed leaves the library in a
  // mixed state KNN propagation can't use. Existing mood/energy tags survive as
  // seeds, so this only re-spends embedding calls, not the LLM tag budget.
  const reseedTagger = async () => {
    setTaggerBusy(true);
    try {
      const r = await adminFetch('/tag-library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reseed: true }),
      });
      const j = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) throw new Error(j.error || `re-seed failed (${r.status})`);
      notify.ok('re-seeding embeddings…');
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
  const totalPages = browse ? Math.max(1, Math.ceil(browse.total / PAGE_SIZE)) : 1;
  const filtersActive =
    moods.length > 0 || energy !== 'any' || !!genre || !!yearFrom || !!yearTo || !!q.trim();

  const clearFilters = () => {
    setMoods([]); setEnergy('any'); setGenre(''); setYearFrom(''); setYearTo(''); setQ('');
    setSort('artist'); setPage(0);
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
    <div className="grid gap-4">
      <KpiStrip coverage={coverage} stats={stats} onStartTag={startTagger} />

      <TaggerStrip
        coverage={coverage}
        tagger={tagger}
        limit={taggerLimit}
        setLimit={setTaggerLimit}
        busy={taggerBusy}
        onStart={startTagger}
        onStop={stopTagger}
        onReseed={reseedTagger}
      />

      <div className="stack-mobile grid grid-cols-[260px_1fr] items-start gap-4">
        <aside className="grid gap-4">
          <TabRail tab={tab} setTab={setTab} />

          {tab === 'browse' && (
            <BrowseFilters
              moodVocab={moodVocab}
              moodCounts={stats?.byMood || {}}
              energyCounts={stats?.byEnergy || {}}
              genreList={genreList}
              moods={moods} setMoods={setMoods}
              energy={energy} setEnergy={setEnergy}
              genre={genre} setGenre={setGenre}
              yearFrom={yearFrom} setYearFrom={setYearFrom}
              yearTo={yearTo} setYearTo={setYearTo}
              sort={sort} setSort={setSort}
              filtersActive={filtersActive}
              onClear={clearFilters}
            />
          )}

          {tab !== 'browse' && (
            <Card title="About this view" bodyClass="!py-3">
              <div className="text-[11px] leading-[1.5] text-muted">
                {tab === 'search' && 'Free-text search against Navidrome — best for finding a specific track to queue right now.'}
                {tab === 'untagged' && 'Tracks that don\'t yet have moods/energy classified. Tag them one at a time, or kick off the bulk tagger at the top of the page.'}
                {tab === 'recent' && 'The newest tracks added to your Navidrome library.'}
              </div>
            </Card>
          )}
        </aside>

        <div className="grid gap-4">
          {tab === 'browse' && (
            <Card bodyClass="!py-3">
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <InputGroup>
                  <InputGroupAddon><Search /></InputGroupAddon>
                  <InputGroupInput
                    placeholder="filter results by title, artist, or album…"
                    value={q}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setQ(e.target.value)}
                  />
                </InputGroup>
                <Btn type="button" onClick={() => runBrowse()} disabled={browseLoading}>
                  {browseLoading ? 'Loading…' : 'Refresh'}
                </Btn>
              </div>
            </Card>
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

          <Card
            title={
              tab === 'browse' ? 'Tracks' :
              tab === 'search' ? 'Search results' :
              tab === 'untagged' ? 'Untagged' :
              'Recently added'
            }
            sub={
              tab === 'browse'
                ? (browse ? `${browse.total.toLocaleString('en-GB')} match${browse.total === 1 ? '' : 'es'}` : '')
                : tab === 'search' ? (searchResults ? `${searchResults.length} result${searchResults.length === 1 ? '' : 's'}` : '')
                : tab === 'untagged' ? `${untagged.length} loaded`
                : (recent ? `${recent.length} tracks` : '')
            }
            right={
              tab === 'recent' ? (
                <Btn sm onClick={loadRecent} disabled={recentLoading}>{recentLoading ? 'Loading…' : 'Refresh'}</Btn>
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
              onQueue={queueTrack}
              onRetag={retagTrack}
            />
          </Card>

          {tab === 'browse' && browse && browse.total > PAGE_SIZE && (
            <div className="flex items-center justify-between text-[11px] text-muted">
              <span className="mono-num">
                {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, browse.total)} of {browse.total.toLocaleString('en-GB')}
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
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPI strip
// ---------------------------------------------------------------------------
// One labelled progress meter: a headline count (done / total), a fill bar,
// and a trailing percent. The done count comes straight from the library DB
// so it shows immediately; only the denominator waits on the Subsonic scan.
function Meter({ label, done, total, percent, scanning, onStart, unavailable, note }: {
  label: string;
  done: number | null;
  total: number | null;
  percent: number | null;
  scanning: boolean;
  onStart?: () => void;
  // When true, the meter reads "engine off" instead of a misleading 0% — the
  // pass can't run because no backend is installed.
  unavailable?: boolean;
  // Explanatory line shown under the bar (e.g. how to enable the engine).
  note?: string;
}) {
  const fillRef = useRef<HTMLSpanElement>(null);
  useDynamicStyle(fillRef, { width: !unavailable && percent != null ? `${Math.min(100, percent)}%` : '0%' });

  const doneNum = done != null ? done.toLocaleString('en-GB') : '—';
  const totalNum = total != null
    ? total.toLocaleString('en-GB')
    : (scanning ? 'scanning…' : '—');
  const complete = percent != null && percent >= 100;
  const empty = (done ?? 0) === 0;

  return (
    <div className="grid gap-1.5 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-[10px] font-bold tracking-[0.1em] text-muted uppercase">{label}</span>
        <span className="caption text-muted">
          {unavailable
            ? 'engine off'
            : complete
              ? '✓ complete'
              : percent != null
                ? `${percent}%`
                : (empty && onStart ? '' : '…')}
        </span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className={cn(
          'mono-num text-[22px] leading-none font-extrabold tracking-[-0.02em]',
          unavailable && 'text-muted',
        )}>{doneNum}</span>
        <span className="caption text-muted">/ {totalNum}</span>
      </div>
      <div className={cn('h-1.5 w-full overflow-hidden bg-[var(--ink-soft)]', unavailable && 'opacity-50')}>
        <span ref={fillRef} className="block h-full bg-[var(--accent)]" />
      </div>
      {note && (
        <div className="mt-0.5 text-[11px] leading-[1.45] text-muted">{note}</div>
      )}
      {empty && onStart && !unavailable && (
        <button
          type="button"
          onClick={onStart}
          className="mt-0.5 w-fit text-[11px] font-bold text-vermilion underline-offset-2 hover:underline"
        >
          Start tagging →
        </button>
      )}
    </div>
  );
}

function KpiStrip({ coverage, stats, onStartTag }: {
  coverage: Coverage | null;
  stats: BrowseResponse['stats'] | undefined;
  onStartTag?: () => void;
}) {
  // `tagged` / `analysed` are known from the DB without the scan; only the
  // denominator (`total`) and the derived percents wait on the Subsonic walk.
  const tagged = coverage?.tagged ?? stats?.total ?? null;
  const analysed = coverage?.analysed ?? null;
  const total = coverage?.total ?? null;
  const scanning = !!coverage?.scanning;
  const moodCount = stats ? Object.keys(stats.byMood || {}).length : 0;
  const lastTag = stats?.updatedAt ? new Date(stats.updatedAt).toLocaleString('en-GB') : '—';

  return (
    <section className="card">
      <div className="border-b border-ink p-4">
        <Eyebrow className="text-vermilion">library · browse · tag · queue</Eyebrow>
        <div className="mt-1.5 text-[22px] font-extrabold tracking-[-0.02em]">
          Manage the music your station plays.
        </div>
        <div className="mt-1 text-[11px] text-muted">
          Filter the tagged index by mood, energy, genre, year, or artist.
          Re-tag tracks the AI got wrong. Queue anything on demand.
        </div>
      </div>
      <div className="grid grid-cols-1 border-b border-ink sm:grid-cols-2">
        <div className="border-b border-separator-strong sm:border-r sm:border-b-0">
          <Meter
            label="mood tagging"
            done={tagged}
            total={total}
            percent={coverage?.percent ?? null}
            scanning={scanning}
            onStart={onStartTag}
          />
        </div>
        <div>
          <Meter
            label="acoustic analysis · bpm/key"
            done={analysed}
            total={total}
            percent={coverage?.analysedPercent ?? null}
            scanning={scanning}
            unavailable={coverage?.analysisAvailable === false}
            note={coverage?.analysisAvailable === false
              ? 'No analysis engine running. Start the tts-heavy sidecar (docker compose --profile tts-heavy up -d) or configure a local librosa venv to enable BPM/key detection — tagging runs will then fill this in.'
              : undefined}
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-x-2 px-4 py-2 text-[11px] text-muted">
        <span className="mono-num">{total != null ? total.toLocaleString('en-GB') : (scanning ? 'scanning…' : '—')}</span>
        <span>tracks</span>
        <span aria-hidden>·</span>
        <span className="mono-num">{moodCount}</span>
        <span>moods in use</span>
        <span aria-hidden>·</span>
        <span>last tag {lastTag}</span>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// tab rail
// ---------------------------------------------------------------------------
function TabRail({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const items: { id: Tab; label: string; hint: string }[] = [
    { id: 'recent', label: 'Recently added', hint: '' },
    { id: 'browse', label: 'Browse', hint: 'tagged' },
    { id: 'search', label: 'Search', hint: 'navidrome' },
    { id: 'untagged', label: 'Untagged', hint: 'needs tags' },
  ];
  return (
    <Card bodyClass="!p-0">
      <div className="py-1">
        {items.map(it => (
          <button
            key={it.id}
            type="button"
            onClick={() => setTab(it.id)}
            className={cn(
              'flex w-full items-center justify-between px-3.5 py-2 text-left text-[12px] transition-colors',
              tab === it.id
                ? 'border-l-2 border-[var(--accent)] bg-[var(--ink-soft)] font-bold'
                : 'border-l-2 border-transparent hover:bg-[var(--ink-soft)]/30',
            )}
          >
            <span>{it.label}</span>
            {it.hint && <span className="caption text-muted">{it.hint}</span>}
          </button>
        ))}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// browse filters sidebar
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
  sort: Sort; setSort: (s: Sort) => void;
  filtersActive: boolean;
  onClear: () => void;
}

function BrowseFilters(p: BrowseFiltersProps) {
  const toggleMood = (m: string) => {
    p.setMoods(p.moods.includes(m) ? p.moods.filter(x => x !== m) : [...p.moods, m]);
  };
  const sortedMoods = useMemo(() => {
    const ranked = [...p.moodVocab];
    ranked.sort((a, b) => (p.moodCounts[b] || 0) - (p.moodCounts[a] || 0));
    return ranked;
  }, [p.moodVocab, p.moodCounts]);

  return (
    <Card
      title="Filters"
      right={p.filtersActive ? (
        <Btn sm tone="danger" onClick={p.onClear} title="Clear all filters">
          <RotateCcw size={11} /> clear
        </Btn>
      ) : null}
    >
      <div>
        <div className="caption mb-1.5">mood</div>
        <div className="grid max-h-56 gap-0.5 overflow-y-auto pr-1">
          {sortedMoods.map(m => {
            const n = p.moodCounts[m] || 0;
            const checked = p.moods.includes(m);
            return (
              <label
                key={m}
                className={cn(
                  'flex cursor-pointer items-center justify-between gap-2 px-1 py-1 text-[12px]',
                  checked ? 'text-ink' : 'text-muted hover:text-ink',
                )}
              >
                <span className="flex items-center gap-2">
                  <Checkbox checked={checked} onCheckedChange={() => toggleMood(m)} />
                  <span>{m}</span>
                </span>
                <span className="mono-num text-[10px] text-muted">{n.toLocaleString('en-GB')}</span>
              </label>
            );
          })}
        </div>
      </div>

      <div className="mt-4">
        <div className="caption mb-1.5">energy</div>
        <Seg
          value={p.energy}
          onChange={id => p.setEnergy(id as Energy)}
          options={[
            { id: 'any', label: 'Any' },
            { id: 'low', label: `Low${p.energyCounts.low ? ` · ${p.energyCounts.low}` : ''}` },
            { id: 'medium', label: `Mid${p.energyCounts.medium ? ` · ${p.energyCounts.medium}` : ''}` },
            { id: 'high', label: `High${p.energyCounts.high ? ` · ${p.energyCounts.high}` : ''}` },
          ]}
        />
      </div>

      <div className="mt-4">
        <Field>
          <FieldLabel htmlFor="genre">genre</FieldLabel>
          <Select value={p.genre || '__any'} onValueChange={v => p.setGenre(v === '__any' ? '' : v)}>
            <SelectTrigger id="genre"><SelectValue placeholder="Any genre" /></SelectTrigger>
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

      <div className="mt-4">
        <div className="caption mb-1.5">year</div>
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
          <Input
            type="number"
            inputMode="numeric"
            placeholder="from"
            value={p.yearFrom}
            onChange={e => p.setYearFrom(e.target.value)}
          />
          <span className="text-[10px] text-muted">–</span>
          <Input
            type="number"
            inputMode="numeric"
            placeholder="to"
            value={p.yearTo}
            onChange={e => p.setYearTo(e.target.value)}
          />
        </div>
      </div>

      <div className="mt-4">
        <Field>
          <FieldLabel htmlFor="sort">sort</FieldLabel>
          <Select value={p.sort} onValueChange={v => p.setSort(v as Sort)}>
            <SelectTrigger id="sort"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="artist">Artist / album / title</SelectItem>
              <SelectItem value="title">Title</SelectItem>
              <SelectItem value="year">Year (newest first)</SelectItem>
              <SelectItem value="taggedAt">Recently tagged</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// track table — same chrome across all tabs, action column varies
// ---------------------------------------------------------------------------
interface TrackTableProps {
  tab: Tab;
  rows: Track[];
  loading: boolean;
  queuing: string | null;
  retagging: string | null;
  onQueue: (t: Track) => void;
  onRetag: (t: Track) => void;
}

function TrackTable(p: TrackTableProps) {
  const cols = 'grid grid-cols-[minmax(0,1.6fr)_minmax(0,1.2fr)_140px]';

  if (p.loading && p.rows.length === 0) {
    return <div className="px-4 py-6 text-[12px] text-muted italic">loading…</div>;
  }
  if (p.rows.length === 0) {
    return (
      <div className="px-4 py-6 text-[12px] text-muted italic">
        {p.tab === 'browse' && 'no tracks match — try clearing some filters'}
        {p.tab === 'search' && 'search the library to queue a track'}
        {p.tab === 'untagged' && 'no untagged tracks found'}
        {p.tab === 'recent' && 'nothing here yet'}
      </div>
    );
  }

  return (
    <div>
      <div className={cn(cols, 'gap-3 border-b border-ink px-3 py-2 text-[9px] font-bold tracking-[0.22em] text-muted uppercase')}>
        <span>title</span>
        <span>album</span>
        <span />
      </div>
      {p.rows.map(t => (
        <div
          key={t.id}
          className={cn(cols, 'items-center gap-3 border-b border-dashed border-separator-strong px-3 py-2 text-[12px]')}
        >
          <div className="min-w-0">
            <div className="overflow-hidden text-ellipsis whitespace-nowrap text-ink">{t.title || '—'}</div>
            <div className="overflow-hidden text-[11px] text-ellipsis whitespace-nowrap text-muted">{t.artist || '—'}</div>
          </div>
          <span className="overflow-hidden text-[11px] text-ellipsis whitespace-nowrap text-muted">{t.album || '—'}</span>
          <div className="flex items-center justify-end gap-1.5">
            <Btn sm onClick={() => p.onQueue(t)} disabled={!!p.queuing}>
              {p.queuing === t.id ? 'Queuing…' : 'Queue'}
            </Btn>
            {(p.tab === 'browse' || p.tab === 'untagged') && (
              <Btn
                sm
                tone={p.tab === 'untagged' ? 'accent' : 'solid'}
                onClick={() => p.onRetag(t)}
                disabled={!!p.retagging}
              >
                {p.retagging === t.id ? '…' : (p.tab === 'untagged' ? 'Tag' : 'Retag')}
              </Btn>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// tagger strip (sticky bottom)
// ---------------------------------------------------------------------------
interface TaggerStripProps {
  coverage: Coverage | null;
  tagger: TaggerState | null;
  limit: string;
  setLimit: (s: string) => void;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
  onReseed: () => void;
}

function TaggerStrip(p: TaggerStripProps) {
  const [expanded, setExpanded] = useState(false);
  const [confirmReseed, setConfirmReseed] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  const fillRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (expanded && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [expanded, p.tagger?.lastLog?.length]);

  const pct = p.coverage?.percent;
  const running = p.tagger?.running;
  // Inline width avoided by mutating .style via the dynamic-style hook.
  useDynamicStyle(fillRef, { width: pct != null ? `${Math.min(100, pct)}%` : null });

  return (
    <div>
      <section className="card border-ink shadow-[0_4px_24px_rgba(0,0,0,0.18)]">
        <div className="stack-mobile grid grid-cols-[1fr_auto] items-center gap-3 p-3">
          <div className="grid gap-1.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
              <span className={cn('h-2 w-2 rounded-full', running ? 'animate-pulse bg-vermilion' : 'bg-muted')} />
              <span className="font-bold">
                {p.coverage?.tagged?.toLocaleString('en-GB') || '—'}
                {' / '}
                {p.coverage?.total != null ? p.coverage.total.toLocaleString('en-GB') : (p.coverage?.scanning ? 'scanning…' : '—')}
                {' tagged'}
              </span>
              {pct != null && <span className="caption text-muted">{pct}%</span>}
              {running && p.tagger?.startedAt && (
                <span className="caption text-muted">
                  pid {p.tagger.pid} · started {new Date(p.tagger.startedAt).toLocaleTimeString('en-GB')}
                </span>
              )}
            </div>
            {pct != null && (
              <div className="h-1 w-full overflow-hidden bg-[var(--ink-soft)]">
                <span ref={fillRef} className="block h-full bg-[var(--accent)]" />
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="number"
              inputMode="numeric"
              className="mono-num w-20"
              value={p.limit}
              onChange={e => p.setLimit(e.target.value)}
              disabled={running}
              title="how many new tracks to tag this run"
            />
            {running ? (
              <Btn tone="danger" onClick={p.onStop} disabled={p.busy}>Stop</Btn>
            ) : (
              <>
                <Btn tone="accent" onClick={p.onStart} disabled={p.busy}>Start tagging</Btn>
                <Btn
                  sm
                  onClick={() => setConfirmReseed(true)}
                  disabled={p.busy}
                  title="Drop + rebuild every embedding from scratch — run after changing the embedding model"
                >
                  Re-seed
                </Btn>
              </>
            )}
            <Btn sm onClick={() => setExpanded(e => !e)}>
              {expanded ? 'hide log' : 'log'}
            </Btn>
          </div>
        </div>
        {expanded && (
          <pre
            ref={logRef}
            className="term m-0 max-h-48 overflow-y-auto border-t border-separator-strong"
          >
            {(p.tagger?.lastLog || []).join('\n') || '(no log output yet)'}
          </pre>
        )}
      </section>
      <V3AlertDialog
        open={confirmReseed}
        onOpenChange={setConfirmReseed}
        title="Re-seed embeddings"
        description="Drops the vector table and re-embeds every track from scratch. Do this after changing the embedding model — the new model's dimensions no longer match the stored vectors. Existing mood/energy tags are kept and reused as seeds (no LLM re-tagging), but a full re-embed can take several minutes on a large library."
        confirmLabel="re-seed"
        danger
        onConfirm={p.onReseed}
      />
    </div>
  );
}


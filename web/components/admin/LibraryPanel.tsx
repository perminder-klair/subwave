'use client';

// Library — /admin/library (redesigned).
//
// One merged "Your DJ knows X%" tagging panel up top — coverage, the primary
// Start-tagging action, and progressive-disclosure Maintenance & log — then a
// clearer browse/search/untagged experience:
//   • Recently added — newest album tracks for quick discovery.
//   • Browse — filters the tagged moods index (mood/energy/genre/year/q).
//   • Search — Navidrome free-text (/dj/search, paged) plus, when the heavy
//     analyzer's CLAP text tower is up, a natural-language "sounds like" mode
//     (/library/search-sound).
//   • Untagged — paginates through library tracks that haven't been tagged yet.
//
// Tab choice, browse filters, and the search query are mirrored into the URL
// query string (history.replaceState) so reloads and shared links keep the view.
//
// Rows carry album art (via the public /cover/:id proxy, letter-tile fallback)
// and inline mood/energy tags so operators *see* what tagging produces. Each
// row supports Queue (push to the live queue) and, where applicable, Retag /
// Tag (single-track LLM classification via /library/retag).
//
// All colours come from theme tokens (the operator picks a theme in Settings),
// so the page renders correctly under every palette — no hardcoded hex.

import type { ChangeEvent, FormEvent, ReactNode } from 'react';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Search, RotateCcw, Sparkles, RefreshCw, ListPlus, ListMusic, X, Pencil, Ban,
  Music, LayoutGrid, Tags,
} from 'lucide-react';
import { useAdminAuth, ADMIN_API_URL } from '../../lib/adminAuth';
import { notify, errorMessage } from '../../lib/notify';
import { Input } from '../ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '../ui/input-group';
import { Field, FieldLabel } from '../ui/field';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '../ui/select';
import { Card, Btn, Eyebrow, Pill, Seg } from './ui';
import { cn } from '../../lib/cn';
import TaggingPanel, { num } from './LibraryTaggingPanel';
import type { Coverage, TaggerState, LibraryStatsLite, Batch, BudgetMode, RescanOpts, TagSteps } from './LibraryTaggingPanel';
import LibraryPlaylistsTab from './LibraryPlaylistsTab';
import type { PlaylistSummary } from './LibraryPlaylistsTab';

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
  source?: string | null;
  taggedAt?: string;
  // Acoustic-analysis surface — null/undefined until the analyze pass runs.
  bpm?: number | null;
  musicalKey?: string | null;
  loudnessLufs?: number | null;
  paceMean?: number | null;
  instrumental?: boolean | null;
  // Cosine match vs the query — only on sounds-like search results.
  similarity?: number | null;
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

// Never-play blocklist entry (GET /library/blocklist) — name/artist/album are
// display snapshots taken at block time, so no Navidrome re-lookup to render.
type BlockType = 'track' | 'album' | 'artist';
interface BlockEntry {
  type: BlockType;
  id: string;
  name: string | null;
  artist: string | null;
  album: string | null;
  addedAt: string;
}

// Coverage / TaggerState / LibraryStatsLite / Batch / RescanOpts live in
// LibraryTaggingPanel.tsx alongside the panel that renders them.

interface SettingsResponse {
  tagger?: TaggerState;
  libraryStats?: LibraryStatsLite;
  // Only the slice this panel needs from the full settings payload.
  values?: { audio?: { embeddings?: boolean; vocalActivity?: boolean } };
  // Daily-token-budget tier — drives the "budget nearly/already used" warning in
  // the Tagging modal. Absent on an old controller → treated as 'normal'.
  budget?: { mode: BudgetMode };
}

type Tab = 'tracks' | 'browse' | 'search' | 'playlists' | 'blocked';
// The Tracks tab folds the old Recent + Untagged tabs into one view with an
// All / Needs-tags toggle; TableVariant keeps TrackTable's per-view behaviour
// (empty-state copy, accent Tag button) keyed on what's actually shown.
type TrackMode = 'all' | 'needs';
type TableVariant = 'recent' | 'browse' | 'search' | 'untagged';
type Sort = 'artist' | 'title' | 'year' | 'taggedAt' | 'bpm' | 'loudness' | 'pace';
type Energy = 'any' | 'low' | 'medium' | 'high';
type Vocal = 'any' | 'instrumental' | 'vocal';
// 'library' = Navidrome metadata search (/dj/search); 'sound' = natural-language
// CLAP sounds-like search (/library/search-sound), shown only when coverage
// reports the capability.
type SearchMode = 'library' | 'sound';

const PAGE_SIZE = 50;
const SEARCH_PAGE = 30;

const TABS: Tab[] = ['tracks', 'browse', 'search', 'playlists', 'blocked'];
const SORTS: Sort[] = ['artist', 'title', 'year', 'taggedAt', 'bpm', 'loudness', 'pace'];

// ---------------------------------------------------------------------------
// small shared parts
// ---------------------------------------------------------------------------
// Track length as m:ss, or null when unknown/zero (Navidrome omits duration on
// some rows — don't render "0:00" for those).
function fmtDuration(sec?: number | null): string | null {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return null;
  const total = Math.round(sec);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

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

// ---------------------------------------------------------------------------
// panel
// ---------------------------------------------------------------------------
export default function LibraryPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const ready = hydrated && !needsAuth;

  // shared state
  const [tab, setTab] = useState<Tab>('tracks');
  const [trackMode, setTrackMode] = useState<TrackMode>('all');
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [tagger, setTagger] = useState<TaggerState | null>(null);
  const [libStats, setLibStats] = useState<LibraryStatsLite | null>(null);
  const [batch, setBatch] = useState<Batch>('500');
  const [taggerBusy, setTaggerBusy] = useState(false);
  // settings.audio.embeddings — null until the first /settings poll lands.
  const [audioEnabled, setAudioEnabled] = useState<boolean | null>(null);
  // settings.audio.vocalActivity — null until the first /settings poll lands.
  const [vocalEnabled, setVocalEnabled] = useState<boolean | null>(null);
  // Daily-token-budget tier from /settings — null until the first slow poll lands.
  const [budgetMode, setBudgetMode] = useState<BudgetMode | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [queuing, setQueuing] = useState<string | null>(null);
  const [retagging, setRetagging] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  // manual tagging — which row's inline editor is open, and which is saving.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [manualBusy, setManualBusy] = useState<string | null>(null);
  // Mood vocab, lifted out of the browse response so the editor has it on any
  // tab (browse is the only call that returns it; lazily fetched otherwise).
  const [vocab, setVocab] = useState<string[]>([]);

  // browse state
  const [moods, setMoods] = useState<string[]>([]);
  const [energy, setEnergy] = useState<Energy>('any');
  const [vocal, setVocal] = useState<Vocal>('any');
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
  const [searchMode, setSearchMode] = useState<SearchMode>('library');
  const [searchResults, setSearchResults] = useState<Track[] | null>(null);
  const [searching, setSearching] = useState(false);
  // Library-mode paging: a full page from /dj/search means more may exist.
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [searchingMore, setSearchingMore] = useState(false);
  // The query/mode that produced searchResults — Load more must page THAT
  // search, not whatever is currently typed in the (maybe edited) input.
  const lastSearchRef = useRef<{ q: string; mode: SearchMode } | null>(null);

  // untagged state
  const [untagged, setUntagged] = useState<Track[]>([]);
  const [untaggedCursor, setUntaggedCursor] = useState<string | null>(null);
  const [untaggedLoading, setUntaggedLoading] = useState(false);

  // recent state
  const [recent, setRecent] = useState<Track[] | null>(null);
  const [recentLoading, setRecentLoading] = useState(false);

  // playlist state — row selection (any track tab) + the Navidrome playlist
  // list shared by the add-to-playlist bar and the Playlists tab.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [playlists, setPlaylists] = useState<PlaylistSummary[] | null>(null);
  const [playlistsLoading, setPlaylistsLoading] = useState(false);
  const [plBusy, setPlBusy] = useState(false);

  // never-play blocklist state — the entry list for the Blocked tab, plus
  // which row's block action / which entry's unblock is in flight.
  const [blockedEntries, setBlockedEntries] = useState<BlockEntry[] | null>(null);
  const [blockedLoading, setBlockedLoading] = useState(false);
  const [blocking, setBlocking] = useState<string | null>(null);
  const [unblocking, setUnblocking] = useState<string | null>(null);

  // -----------------------------------------------------------------------
  // URL state — tab, browse filters, and the search query live in the query
  // string so a reload / back-button / shared link lands on the same view.
  // Restored once on mount (post-hydration, so no SSR mismatch); written back
  // via history.replaceState (no Next.js navigation, no server round-trip).
  // -----------------------------------------------------------------------
  const [urlRestored, setUrlRestored] = useState(false);
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const t = sp.get('tab');
    // Legacy links: the old Recent and Untagged tabs are now Tracks (+ mode).
    if (t === 'untagged') { setTab('tracks'); setTrackMode('needs'); }
    else if (t === 'recent') setTab('tracks');
    else if (t && (TABS as string[]).includes(t)) setTab(t as Tab);
    if (sp.get('view') === 'needs') { setTab('tracks'); setTrackMode('needs'); }
    const m = (sp.get('moods') || '').split(',').map(s => s.trim()).filter(Boolean);
    if (m.length) setMoods(m);
    const en = sp.get('energy');
    if (en === 'low' || en === 'medium' || en === 'high') setEnergy(en);
    const vo = sp.get('vocal');
    if (vo === 'vocal' || vo === 'instrumental') setVocal(vo);
    const g = sp.get('genre');
    if (g) setGenre(g);
    const yf = sp.get('from');
    if (yf) setYearFrom(yf);
    const yt = sp.get('to');
    if (yt) setYearTo(yt);
    const bq = sp.get('q');
    if (bq) setQ(bq);
    const so = sp.get('sort');
    if (so && (SORTS as string[]).includes(so)) setSort(so as Sort);
    const sq = sp.get('sq');
    if (sq) setSearchQuery(sq);
    if (sp.get('smode') === 'sound') setSearchMode('sound');
    setUrlRestored(true);
  }, []);

  useEffect(() => {
    if (!urlRestored) return;
    const sp = new URLSearchParams();
    if (tab !== 'tracks') sp.set('tab', tab);
    if (tab === 'tracks' && trackMode === 'needs') sp.set('view', 'needs');
    if (moods.length) sp.set('moods', moods.join(','));
    if (energy !== 'any') sp.set('energy', energy);
    if (vocal !== 'any') sp.set('vocal', vocal);
    if (genre) sp.set('genre', genre);
    if (yearFrom) sp.set('from', yearFrom);
    if (yearTo) sp.set('to', yearTo);
    if (q.trim()) sp.set('q', q.trim());
    if (sort !== 'artist') sp.set('sort', sort);
    if (searchQuery.trim()) sp.set('sq', searchQuery.trim());
    if (searchMode === 'sound') sp.set('smode', 'sound');
    const qs = sp.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`);
  }, [urlRestored, tab, trackMode, moods, energy, vocal, genre, yearFrom, yearTo, q, sort, searchQuery, searchMode]);

  // If coverage says the sound search can't serve (lean analyzer, no audio
  // index), drop back to the metadata mode the toggle would otherwise hide.
  useEffect(() => {
    if (coverage && coverage.soundSearchAvailable !== true && searchMode === 'sound') {
      setSearchMode('library');
    }
  }, [coverage, searchMode]);

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

  // Fast loop payload — just the live tagger snapshot (GET /library/tagger), so a
  // 3s running poll doesn't drag the whole heavy /settings body across each time.
  const loadTaggerState = useCallback(async () => {
    if (!ready) return;
    try {
      const r = await adminFetch('/library/tagger');
      if (!r.ok) return;
      const j = (await r.json()) as { tagger?: TaggerState };
      setTagger(j.tagger || null);
    } catch { /* transient */ }
  }, [adminFetch, ready]);

  // Slow loop payload — the settings-derived bits the panel shows but that change
  // rarely: library stats, the audio/vocal opt-in toggles, and the daily-budget
  // tier. Deliberately does NOT touch tagger state (the fast loop owns that) so
  // the two pollers never race on it.
  const loadSettingsData = useCallback(async () => {
    if (!ready) return;
    try {
      const r = await adminFetch('/settings');
      if (!r.ok) return;
      const j = (await r.json()) as SettingsResponse;
      if (j.libraryStats) setLibStats(j.libraryStats);
      if (j.values?.audio) {
        setAudioEnabled(!!j.values.audio.embeddings);
        setVocalEnabled(!!j.values.audio.vocalActivity);
      }
      if (j.budget) setBudgetMode(j.budget.mode);
    } catch { /* transient */ }
  }, [adminFetch, ready]);

  useEffect(() => {
    if (!ready) return;
    loadCoverage();
    const id = setInterval(loadCoverage, 60_000);
    return () => clearInterval(id);
  }, [ready, loadCoverage]);

  // Fast: tagger state — 3s while a run is live so progress is snappy, 10s idle.
  useEffect(() => {
    if (!ready) return;
    loadTaggerState();
    const interval = tagger?.running ? 3_000 : 10_000;
    const id = setInterval(loadTaggerState, interval);
    return () => clearInterval(id);
  }, [ready, loadTaggerState, tagger?.running]);

  // Slow: settings-derived data (stats / audio toggles / budget) — 30s + on mount.
  useEffect(() => {
    if (!ready) return;
    loadSettingsData();
    const id = setInterval(loadSettingsData, 30_000);
    return () => clearInterval(id);
  }, [ready, loadSettingsData]);

  // While a run is live, poll coverage faster so the % visibly climbs.
  useEffect(() => {
    if (!ready || !tagger?.running) return;
    const id = setInterval(loadCoverage, 3_000);
    return () => clearInterval(id);
  }, [ready, tagger?.running, loadCoverage]);

  // -----------------------------------------------------------------------
  // browse fetch — debounced on filter change. Each run aborts the previous
  // in-flight request: without this, a slow earlier response can land after a
  // faster later one and overwrite the table with results for stale filters.
  // -----------------------------------------------------------------------
  const browseAbortRef = useRef<AbortController | null>(null);
  const runBrowse = useCallback(async () => {
    if (!ready) return;
    browseAbortRef.current?.abort();
    const ac = new AbortController();
    browseAbortRef.current = ac;
    setBrowseLoading(true);
    try {
      const params = new URLSearchParams();
      if (moods.length) params.set('moods', moods.join(','));
      if (energy !== 'any') params.set('energy', energy);
      if (vocal !== 'any') params.set('vocal', vocal);
      if (genre) params.set('genre', genre);
      if (yearFrom) params.set('yearFrom', yearFrom);
      if (yearTo) params.set('yearTo', yearTo);
      if (q.trim()) params.set('q', q.trim());
      params.set('sort', sort);
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(page * PAGE_SIZE));
      const r = await adminFetch(`/library/browse?${params}`, { signal: ac.signal });
      if (!r.ok) throw new Error(`browse failed (${r.status})`);
      setBrowse((await r.json()) as BrowseResponse);
    } catch (err) {
      // Superseded by a newer run — that run owns the table and the spinner.
      if (ac.signal.aborted) return;
      notify.err(errorMessage(err));
      setBrowse(null);
    } finally {
      if (!ac.signal.aborted) setBrowseLoading(false);
    }
  }, [adminFetch, ready, moods, energy, vocal, genre, yearFrom, yearTo, q, sort, page]);

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
  useEffect(() => { setPage(0); }, [moods, energy, vocal, genre, yearFrom, yearTo, q, sort]);

  // -----------------------------------------------------------------------
  // search fetch — two modes: 'library' pages Navidrome metadata search
  // (/dj/search, offset appends), 'sound' is the one-shot natural-language
  // CLAP sounds-like search (/library/search-sound, no paging — fixed KNN).
  // -----------------------------------------------------------------------
  const executeSearch = useCallback(async (text: string, mode: SearchMode, offset: number) => {
    if (!text || !ready) return;
    const append = offset > 0;
    if (append) setSearchingMore(true);
    else setSearching(true);
    try {
      let rows: Track[] = [];
      let more = false;
      if (mode === 'sound') {
        const r = await adminFetch(`/library/search-sound?q=${encodeURIComponent(text)}&limit=${SEARCH_PAGE}`);
        const j = await r.json().catch(() => ({})) as { results?: Track[]; error?: string };
        if (!r.ok) throw new Error(j.error || `sound search failed (${r.status})`);
        rows = j.results || [];
      } else {
        const r = await adminFetch(`/dj/search?q=${encodeURIComponent(text)}&limit=${SEARCH_PAGE}&offset=${offset}`);
        const j = await r.json().catch(() => ({})) as { results?: Track[]; hasMore?: boolean; error?: string };
        if (!r.ok) throw new Error(j.error || `search failed (${r.status})`);
        rows = j.results || [];
        // Absent on an old controller (fixed 12 rows) → no Load more, as before.
        more = !!j.hasMore;
      }
      setSearchResults(prev => (append ? [...(prev || []), ...rows] : rows));
      setSearchHasMore(more);
      lastSearchRef.current = { q: text, mode };
    } catch (err) {
      notify.err(errorMessage(err));
      if (!append) { setSearchResults([]); setSearchHasMore(false); }
    } finally {
      if (append) setSearchingMore(false);
      else setSearching(false);
    }
  }, [adminFetch, ready]);

  const runSearch = (e?: FormEvent<HTMLFormElement>) => {
    e?.preventDefault();
    executeSearch(searchQuery.trim(), searchMode, 0);
  };

  const loadMoreSearch = () => {
    const last = lastSearchRef.current;
    if (last) executeSearch(last.q, last.mode, searchResults?.length || 0);
  };

  // Deep link with a search query (?tab=search&sq=…) — run it once auth is up.
  const autoSearchedRef = useRef(false);
  useEffect(() => {
    if (!ready || !urlRestored || autoSearchedRef.current) return;
    autoSearchedRef.current = true;
    if (tab === 'search' && searchQuery.trim()) executeSearch(searchQuery.trim(), searchMode, 0);
  }, [ready, urlRestored, tab, searchQuery, searchMode, executeSearch]);

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
    if (tab !== 'tracks' || trackMode !== 'needs' || !ready) return;
    if (untagged.length === 0) loadUntagged(null, false);
  }, [tab, trackMode, ready, untagged.length, loadUntagged]);

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
    if (tab !== 'tracks' || trackMode !== 'all' || !ready) return;
    if (recent === null) loadRecent();
  }, [tab, trackMode, ready, recent, loadRecent]);

  // -----------------------------------------------------------------------
  // playlists — list fetch, row selection, add-to-playlist
  // -----------------------------------------------------------------------
  const loadPlaylists = useCallback(async () => {
    if (!ready) return;
    setPlaylistsLoading(true);
    try {
      const r = await adminFetch('/playlists');
      const j = await r.json().catch(() => ({})) as { playlists?: PlaylistSummary[]; error?: string };
      if (!r.ok) throw new Error(j.error || `playlists failed (${r.status})`);
      setPlaylists(j.playlists || []);
    } catch (err) {
      notify.err(errorMessage(err));
      setPlaylists([]);
    } finally {
      setPlaylistsLoading(false);
    }
  }, [adminFetch, ready]);

  // Selection is per-view: switching tabs drops it (ids from another tab would
  // be invisible, and "Add 12" with 9 off-screen rows is a foot-gun).
  useEffect(() => { setSelected(new Set()); }, [tab]);

  useEffect(() => {
    if (tab === 'playlists' && ready) loadPlaylists();
  }, [tab, ready, loadPlaylists]);

  // The add-bar's dropdown needs the playlist list the first time a selection
  // appears on a track tab — fetch lazily, once.
  useEffect(() => {
    if (selected.size > 0 && playlists === null && ready) loadPlaylists();
  }, [selected.size, playlists, ready, loadPlaylists]);

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllRows = (rows: Track[]) => {
    setSelected(prev => {
      const all = rows.length > 0 && rows.every(r => prev.has(r.id));
      const next = new Set(prev);
      if (all) rows.forEach(r => next.delete(r.id));
      else rows.forEach(r => next.add(r.id));
      return next;
    });
  };

  const addSelectedToPlaylist = async (target: { playlistId?: string; name?: string }) => {
    const songIds = Array.from(selected);
    if (songIds.length === 0) return;
    setPlBusy(true);
    try {
      const r = target.playlistId
        ? await adminFetch(`/playlists/${encodeURIComponent(target.playlistId)}/tracks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ songIds }),
          })
        : await adminFetch('/playlists', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: target.name, songIds }),
          });
      const j = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) throw new Error(j.error || `add to playlist failed (${r.status})`);
      const plName = target.name
        || playlists?.find(p => p.id === target.playlistId)?.name
        || 'playlist';
      notify.ok(`added ${songIds.length} track${songIds.length === 1 ? '' : 's'} to “${plName}”`);
      setSelected(new Set());
      loadPlaylists();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setPlBusy(false);
    }
  };

  // -----------------------------------------------------------------------
  // never-play blocklist
  // -----------------------------------------------------------------------
  const loadBlocked = useCallback(async () => {
    if (!ready) return;
    setBlockedLoading(true);
    try {
      const r = await adminFetch('/library/blocklist');
      if (!r.ok) throw new Error(`blocklist load failed (${r.status})`);
      const j = await r.json() as { entries?: BlockEntry[] };
      setBlockedEntries(j.entries || []);
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setBlockedLoading(false);
    }
  }, [adminFetch, ready]);

  useEffect(() => {
    if (tab === 'blocked' && ready) loadBlocked();
  }, [tab, ready, loadBlocked]);

  const blockTrack = async (track: Track, type: BlockType) => {
    setBlocking(track.id);
    try {
      const r = await adminFetch('/library/blocklist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, trackId: track.id }),
      });
      const j = await r.json().catch(() => ({})) as { entry?: BlockEntry; purged?: number; error?: string };
      if (!r.ok) throw new Error(j.error || `block failed (${r.status})`);
      const what = type === 'track' ? `“${track.title}”` : type === 'album' ? `album “${track.album}”` : track.artist;
      notify.ok(`${what} will never air${j.purged ? ` · ${j.purged} dropped from queue` : ''} — manage in the Blocked tab`);
      setBlockedEntries(prev => (prev && j.entry ? [...prev, j.entry] : prev));
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setBlocking(null);
    }
  };

  const unblockEntry = async (e: BlockEntry) => {
    const key = `${e.type}:${e.id}`;
    setUnblocking(key);
    try {
      const r = await adminFetch(`/library/blocklist/${e.type}/${encodeURIComponent(e.id)}`, { method: 'DELETE' });
      if (!r.ok && r.status !== 404) {
        const j = await r.json().catch(() => ({})) as { error?: string };
        throw new Error(j.error || `unblock failed (${r.status})`);
      }
      notify.ok(`“${e.name || e.id}” can play again`);
      setBlockedEntries(prev => (prev ? prev.filter(x => !(x.type === e.type && x.id === e.id)) : prev));
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setUnblocking(null);
    }
  };

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
      if (tab === 'tracks' && trackMode === 'needs') setUntagged(prev => prev.filter(t => t.id !== track.id));
      // Search/recent rows aren't refetched — patch the row so the new tags
      // show immediately (the server stamps retagged rows source='llm').
      if (tab === 'search') setSearchResults(prev => patchRows(prev, track, j.moods || [], j.energy ?? null, false, false, 'llm'));
      if (tab === 'tracks' && trackMode === 'all') setRecent(prev => patchRows(prev, track, j.moods || [], j.energy ?? null, false, false, 'llm'));
      loadCoverage();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setRetagging(null);
    }
  };

  // Mood vocab only rides along on the browse response. Keep `vocab` synced
  // from it, and lazily fetch a one-row browse when the editor opens on a tab
  // that hasn't loaded browse yet — avoids hardcoding SHOW_MOODS in the bundle.
  useEffect(() => {
    if (browse?.moodVocab?.length) setVocab(browse.moodVocab);
  }, [browse]);
  const ensureVocab = useCallback(async () => {
    if (vocab.length) return;
    try {
      const r = await adminFetch('/library/browse?limit=1');
      if (!r.ok) return;
      const j = (await r.json()) as BrowseResponse;
      if (j.moodVocab?.length) setVocab(j.moodVocab);
    } catch { /* editor shows a "loading moods…" hint until this lands */ }
  }, [vocab.length, adminFetch]);

  const onEditTrack = (t: Track) => {
    if (editingId === t.id) { setEditingId(null); return; }
    ensureVocab();
    setEditingId(t.id);
  };

  // Patch the visible rows after a tag write so search/recent reflect it
  // without a refetch. Album siblings in view update too when applyToAlbum.
  // `source` mirrors what the server stamped: 'manual' for the inline editor,
  // 'llm' for single-track retag.
  const patchRows = (
    rows: Track[] | null, track: Track,
    moods: string[], energy: string | null, cleared: boolean, applyToAlbum: boolean,
    source: string = 'manual',
  ): Track[] | null => {
    if (!rows) return rows;
    return rows.map(r => {
      const hit = r.id === track.id || (applyToAlbum && !!track.album && r.album === track.album);
      if (!hit) return r;
      return cleared
        ? { ...r, moods: [], energy: null, source: null }
        : { ...r, moods, energy, source };
    });
  };

  const saveManualTag = async (
    track: Track, moods: string[], energy: string | null, applyToAlbum: boolean,
  ) => {
    setManualBusy(track.id);
    try {
      const r = await adminFetch('/library/manual-tag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: track.id, moods, energy, applyToAlbum }),
      });
      const j = (await r.json().catch(() => ({}))) as
        { ok?: boolean; updated?: number; cleared?: boolean; error?: string };
      if (!r.ok) throw new Error(j.error || `save failed (${r.status})`);
      const cleared = !!j.cleared;
      const n = j.updated ?? 1;
      const scope = applyToAlbum ? `${n} album track${n === 1 ? '' : 's'}` : 'track';
      notify.ok(cleared ? `cleared tags · ${scope}` : `tagged ${scope} · ${moods.join(', ') || '—'}`);
      setEditingId(null);
      setFlashId(track.id);
      setTimeout(() => setFlashId(curr => (curr === track.id ? null : curr)), 1100);
      if (tab === 'browse') runBrowse();
      else if (tab === 'tracks' && trackMode === 'needs') {
        // Newly-tagged tracks leave the untagged list; cleared ones stay put.
        if (!cleared) {
          setUntagged(prev => prev.filter(t =>
            !(t.id === track.id || (applyToAlbum && track.album && t.album === track.album))));
        }
      } else if (tab === 'search') {
        setSearchResults(prev => patchRows(prev, track, moods, energy, cleared, applyToAlbum));
      } else if (tab === 'tracks') {
        setRecent(prev => patchRows(prev, track, moods, energy, cleared, applyToAlbum));
      }
      loadCoverage();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setManualBusy(null);
    }
  };

  // -----------------------------------------------------------------------
  // tagger controls
  // -----------------------------------------------------------------------
  const remaining = coverage?.total != null ? Math.max(0, coverage.total - coverage.tagged) : null;

  const startTagger = async (steps?: TagSteps) => {
    setTaggerBusy(true);
    try {
      const limit = batch === 'all' ? null : parseInt(batch, 10);
      const body: Record<string, unknown> = limit && limit > 0 ? { limit } : {};
      // Forward-run step toggles from the modal's Run tab; absent on the legacy
      // "Tag all" quick action, which then sends a plain full run.
      if (steps) Object.assign(body, steps);
      const r = await adminFetch('/tag-library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) throw new Error(j.error || `tagger start failed (${r.status})`);
      notify.ok('tagger started');
      setLogOpen(true);
      await loadTaggerState();
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
      await loadTaggerState();
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
  // embedding calls, not LLM. `thenTag` (reseed-only) rides along in opts: it
  // continues into the forward tag pass after the whole-library re-embed, still
  // with no limit so every untagged track is processed.
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
      await loadTaggerState();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setTaggerBusy(false);
    }
  };

  // Flip settings.audio.embeddings — the "sounds-like" (CLAP) opt-in. The
  // toggle only persists the setting; vectors appear after an analysis run.
  const toggleAudio = async () => {
    if (audioEnabled == null) return;
    setTaggerBusy(true);
    try {
      const r = await adminFetch('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: { embeddings: !audioEnabled } }),
      });
      const j = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) throw new Error(j.error || `save failed (${r.status})`);
      setAudioEnabled(!audioEnabled);
      // When the analyzer can't fingerprint yet (lean image), frame enabling as
      // pending rather than done — the incapable banner below explains the upgrade.
      const audioPending =
        coverage?.analysisAvailable !== false && coverage?.audioAnalysisAvailable === false;
      notify.ok(
        !audioEnabled
          ? audioPending
            ? 'sounds-like enabled — starts once the heavy analyzer is up'
            : 'sounds-like analysis enabled'
          : 'sounds-like analysis disabled',
      );
      // The toggle lives on the slow /settings loop — refresh it now so a manual
      // re-open / status recompute doesn't wait up to 30s to reflect the flip.
      void loadSettingsData();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setTaggerBusy(false);
    }
  };

  // Reconcile with Navidrome — walk the catalogue and prune library entries
  // for tracks that no longer exist (deleted files, or IDs re-minted by a full
  // rescan). No LLM/embedding cost; reuses the tagger's single-flight slot, so
  // the running view + stop button below cover it. Usable at 100% coverage,
  // where Start tagging is disabled.
  const reconcile = async () => {
    setTaggerBusy(true);
    try {
      const r = await adminFetch('/library/reconcile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const j = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) throw new Error(j.error || `reconcile failed (${r.status})`);
      notify.ok('reconcile started, scanning Navidrome');
      setLogOpen(true);
      await loadTaggerState();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setTaggerBusy(false);
    }
  };

  // Run the analysis pass (bpm/key + audio fingerprints) as a background
  // child — same single-flight state as the tagger, so the running view and
  // stop button below cover it too.
  const analyzeAudio = async () => {
    setTaggerBusy(true);
    try {
      const r = await adminFetch('/library/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const j = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) throw new Error(j.error || `analysis start failed (${r.status})`);
      notify.ok('audio analysis started');
      setLogOpen(true);
      await loadTaggerState();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setTaggerBusy(false);
    }
  };

  // Flip settings.audio.vocalActivity — the Demucs vocal-activity opt-in (#646).
  // Mirrors toggleAudio; env ANALYZE_VOCAL_ACTIVITY still wins "on".
  const toggleVocal = async () => {
    if (vocalEnabled == null) return;
    setTaggerBusy(true);
    try {
      const r = await adminFetch('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: { vocalActivity: !vocalEnabled } }),
      });
      const j = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) throw new Error(j.error || `save failed (${r.status})`);
      setVocalEnabled(!vocalEnabled);
      // Mirrors toggleAudio: enabling on a lean analyzer is "armed", not active.
      const vocalPending =
        coverage?.analysisAvailable !== false && coverage?.vocalAnalysisAvailable === false;
      notify.ok(
        !vocalEnabled
          ? vocalPending
            ? 'vocal-activity enabled — starts once the heavy analyzer is up'
            : 'vocal-activity analysis enabled'
          : 'vocal-activity analysis disabled',
      );
      // Refresh the slow settings-derived state now rather than waiting for its
      // tick — and coverage too, so the coverage-driven bits (vocalStatus, the
      // vocal meter row) catch up without waiting out the 60s poll.
      void loadSettingsData();
      void loadCoverage();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setTaggerBusy(false);
    }
  };

  // Backfill Demucs vocal ranges on tracks that lack them — POST with vocal:true
  // so the analyze pass forces the vocal scope (#646).
  const vocalBackfill = async () => {
    setTaggerBusy(true);
    try {
      const r = await adminFetch('/library/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vocal: true }),
      });
      const j = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) throw new Error(j.error || `vocal analysis start failed (${r.status})`);
      notify.ok('vocal analysis started');
      setLogOpen(true);
      await loadTaggerState();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setTaggerBusy(false);
    }
  };

  // Reset — wipe ALL tagging data (tags, embeddings, acoustics, enrichment) and
  // start fresh. Deletes library.db server-side; the Navidrome library itself is
  // untouched, so every track simply returns to the untagged pool. Gated behind
  // the modal's typed confirmation. Refused (409) while a tagger run is active.
  const resetLibrary = async () => {
    setTaggerBusy(true);
    try {
      const r = await adminFetch('/library/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const j = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) throw new Error(j.error || `reset failed (${r.status})`);
      notify.ok('library reset — all tagging data wiped');
      // Everything the tables/meters showed is gone. Refresh coverage + settings
      // and drop the cached views so each tab reloads against the empty library.
      await loadCoverage();
      void loadSettingsData();
      setBrowse(null);
      setSearchResults(null);
      setRecent(null);
      setUntagged([]);
      setUntaggedCursor(null);
      if (tab === 'browse') runBrowse();
      else if (tab === 'tracks' && trackMode === 'all') loadRecent();
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
    moods.length > 0 || energy !== 'any' || vocal !== 'any' || !!genre || !!yearFrom || !!yearTo || !!q.trim();

  const clearFilters = () => {
    setMoods([]); setEnergy('any'); setVocal('any'); setGenre(''); setYearFrom(''); setYearTo(''); setQ('');
    setSort('artist'); setPage(0);
  };

  // What the merged Tracks tab actually shows right now — drives the table's
  // rows, empty-state copy, and accent Tag button (TrackTable keys on this).
  const tableVariant: TableVariant =
    tab === 'tracks' ? (trackMode === 'needs' ? 'untagged' : 'recent') : (tab as TableVariant);
  const tableRows: Track[] =
    tableVariant === 'browse' ? (browse?.rows || []) :
    tableVariant === 'search' ? (searchResults || []) :
    tableVariant === 'untagged' ? untagged :
    (recent || []);
  const tableLoading =
    tableVariant === 'browse' ? browseLoading :
    tableVariant === 'search' ? searching :
    tableVariant === 'untagged' ? untaggedLoading :
    recentLoading;

  return (
    <div className="grid gap-5">
      <TaggingPanel
        coverage={coverage}
        libStats={libStats}
        tagger={tagger}
        batch={batch}
        setBatch={setBatch}
        busy={taggerBusy}
        logOpen={logOpen}
        setLogOpen={setLogOpen}
        onStart={startTagger}
        onStop={stopTagger}
        onRescan={rescanTagger}
        onReconcile={reconcile}
        onReset={resetLibrary}
        audioEnabled={audioEnabled}
        onToggleAudio={toggleAudio}
        onAnalyzeAudio={analyzeAudio}
        vocalEnabled={vocalEnabled}
        onToggleVocal={toggleVocal}
        onVocalBackfill={vocalBackfill}
        budgetMode={budgetMode}
      />

      <Tabs tab={tab} setTab={setTab} />

      {/* contextual controls */}
      {tab === 'browse' && (
        <BrowseFilters
          moodVocab={moodVocab}
          moodCounts={moodCounts}
          energyCounts={energyCounts}
          genreList={genreList}
          moods={moods} setMoods={setMoods}
          energy={energy} setEnergy={setEnergy}
          vocal={vocal} setVocal={setVocal}
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
          {vocal !== 'any' && (
            <span className="lib-active-chip">{vocal}<button type="button" onClick={() => setVocal('any')} aria-label="remove vocal filter">×</button></span>
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
          <div className="grid gap-2.5">
            {/* Mode toggle only when the CLAP text tower + audio index exist —
                on lean installs the tab stays plain metadata search. */}
            {coverage?.soundSearchAvailable === true && (
              <div className="flex flex-wrap items-center gap-3">
                <Seg
                  value={searchMode}
                  options={[
                    { id: 'library', label: 'Library' },
                    { id: 'sound', label: 'Sounds like' },
                  ]}
                  onChange={(v: string) => {
                    setSearchMode(v as SearchMode);
                    setSearchResults(null);
                    setSearchHasMore(false);
                  }}
                />
                {searchMode === 'sound' && (
                  <span className="text-[11px] text-muted">
                    describe a sound — matches the audio itself, not titles or tags
                  </span>
                )}
              </div>
            )}
            <form onSubmit={runSearch} className="grid grid-cols-[1fr_auto_auto] gap-2">
              <InputGroup>
                <InputGroupAddon><Search /></InputGroupAddon>
                <InputGroupInput
                  placeholder={searchMode === 'sound'
                    ? 'dusty late-night jazz with brushed drums, warm acoustic fingerpicking…'
                    : 'floating points, kingdoms in colour, 2018…'}
                  value={searchQuery}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
                />
              </InputGroup>
              <Btn tone="accent" type="submit" disabled={searching || !searchQuery.trim() || !ready}>
                {searching ? 'Searching…' : 'Search'}
              </Btn>
              <Btn type="button" onClick={() => { setSearchQuery(''); setSearchResults(null); setSearchHasMore(false); }} disabled={searching}>
                Clear
              </Btn>
            </form>
          </div>
        </Card>
      )}

      {/* add-to-playlist bar — appears when rows are selected on a track tab */}
      {tab !== 'playlists' && tab !== 'blocked' && selected.size > 0 && (
        <AddToPlaylistBar
          count={selected.size}
          playlists={playlists}
          busy={plBusy}
          onAdd={addSelectedToPlaylist}
          onClear={() => setSelected(new Set())}
        />
      )}

      {tab === 'playlists' && (
        <LibraryPlaylistsTab
          playlists={playlists}
          loading={playlistsLoading}
          onRefresh={loadPlaylists}
          adminFetch={adminFetch}
        />
      )}

      {tab === 'blocked' && (
        <BlockedTab
          entries={blockedEntries}
          loading={blockedLoading}
          unblocking={unblocking}
          onUnblock={unblockEntry}
          onRefresh={loadBlocked}
        />
      )}

      {/* track list */}
      {tab !== 'playlists' && tab !== 'blocked' && (
      <Card
        title={
          tableVariant === 'browse' ? 'Tracks' :
          tableVariant === 'search' ? 'Search results' :
          tableVariant === 'untagged' ? 'Needs tags' :
          'Recently added'
        }
        sub={
          tableVariant === 'browse'
            ? (browse ? `${num(browse.total)} match${browse.total === 1 ? '' : 'es'}` : '')
            : tableVariant === 'search' ? (searchResults ? `${searchResults.length} result${searchResults.length === 1 ? '' : 's'}` : 'enter a query')
            : tableVariant === 'untagged' ? `${untagged.length} loaded${remaining != null ? ` · ${num(remaining)} need tags` : ''}`
            : (recent ? `${recent.length} tracks` : '')
        }
        right={
          tab === 'tracks' ? (
            <span className="flex items-center gap-2.5">
              <Seg
                value={trackMode}
                options={[
                  { id: 'all', label: 'All' },
                  { id: 'needs', label: `Needs tags${remaining != null ? ` · ${num(remaining)}` : ''}` },
                ]}
                onChange={(v: string) => setTrackMode(v as TrackMode)}
              />
              {trackMode === 'needs' && untagged.length > 0 ? (
                <Btn sm tone="accent" onClick={() => startTagger()} disabled={tagger?.running || taggerBusy}>
                  <Sparkles size={11} /> Tag all
                </Btn>
              ) : trackMode === 'all' ? (
                <Btn sm onClick={loadRecent} disabled={recentLoading}>
                  <RefreshCw size={11} /> {recentLoading ? 'Loading…' : 'Refresh'}
                </Btn>
              ) : null}
            </span>
          ) : null
        }
        bodyClass="!p-0"
      >
        <TrackTable
          tab={tableVariant}
          rows={tableRows}
          loading={tableLoading}
          queuing={queuing}
          retagging={retagging}
          flashId={flashId}
          onQueue={queueTrack}
          onRetag={retagTrack}
          blocking={blocking}
          onBlock={blockTrack}
          vocab={vocab}
          editingId={editingId}
          manualBusy={manualBusy}
          onEdit={onEditTrack}
          onSaveManual={saveManualTag}
          onCancelEdit={() => setEditingId(null)}
          selected={selected}
          onToggleSelect={toggleSelect}
          onToggleAll={toggleAllRows}
        />
      </Card>
      )}

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

      {tab === 'search' && searchHasMore && (searchResults?.length || 0) > 0 && (
        <div className="flex justify-center">
          <Btn onClick={loadMoreSearch} disabled={searchingMore}>
            {searchingMore ? 'Loading…' : 'Load more'}
          </Btn>
        </div>
      )}

      {tab === 'tracks' && trackMode === 'needs' && untaggedCursor && (
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
// tabs
// ---------------------------------------------------------------------------
// Masthead tabs: icon left, name + subtitle stacked right. No count badges —
// the panel subtitle below reports the real numbers for whichever view is open.
function Tabs({ tab, setTab }: {
  tab: Tab;
  setTab: (t: Tab) => void;
}) {
  const items: { id: Tab; name: string; sub: string; icon: ReactNode }[] = [
    { id: 'tracks', name: 'Tracks', sub: 'newest & needs tags', icon: <Music size={17} /> },
    { id: 'browse', name: 'Browse', sub: 'tagged index', icon: <LayoutGrid size={17} /> },
    { id: 'search', name: 'Search', sub: 'navidrome', icon: <Search size={17} /> },
    { id: 'playlists', name: 'Playlists', sub: 'navidrome', icon: <ListMusic size={17} /> },
    { id: 'blocked', name: 'Blocked', sub: 'never plays', icon: <Ban size={17} /> },
  ];
  return (
    <div className="lib-tabs">
      {items.map(it => (
        <button key={it.id} type="button" className={cn('lib-tab', tab === it.id && 'on')} onClick={() => setTab(it.id)}>
          {it.icon}
          <span className="min-w-0">
            <span className="lib-tab-name">{it.name}</span>
            <span className="lib-tab-sub">{it.sub}</span>
          </span>
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
  vocal: Vocal; setVocal: (v: Vocal) => void;
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

  // Vocal facet rides on the acoustic analysis pass; it only ever narrows to
  // analysed tracks (un-analysed rows have no vocal ranges to test).
  const vocalOpts: { id: Vocal; label: string }[] = [
    { id: 'any', label: 'Any' },
    { id: 'vocal', label: 'Vocal' },
    { id: 'instrumental', label: 'Instrumental' },
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

      {/* quick facets — the energy + vocal toggle groups sit on their own row,
          divided from the dropdown-style refinements below. */}
      <div className="flex flex-wrap items-end gap-x-4 gap-y-4 border-b border-dashed border-separator-strong p-4">
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
          <div className="caption">vocal</div>
          <div className="flex flex-wrap border border-ink">
            {vocalOpts.map((o, i) => (
              <button
                key={o.id}
                type="button"
                onClick={() => p.setVocal(o.id)}
                className={cn(
                  'inline-flex items-center gap-1.5 px-3 py-2 text-[10px] font-bold tracking-[0.12em] uppercase',
                  i > 0 && 'border-l border-ink',
                  p.vocal === o.id ? 'bg-ink text-bg' : 'text-ink hover:bg-[var(--ink-soft)]',
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* refine — genre, year and sort share a single row. They wrap together as
          a group on very narrow widths, but none ever strands on its own line. */}
      <div className="flex flex-wrap items-end gap-x-4 gap-y-4 p-4">
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

        <div className="flex flex-col gap-2">
          <Field>
            <FieldLabel htmlFor="sort">sort</FieldLabel>
            <Select value={p.sort} onValueChange={v => p.setSort(v as Sort)}>
              <SelectTrigger id="sort" className="min-w-[170px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="artist">Artist / album / title</SelectItem>
                <SelectItem value="title">Title</SelectItem>
                <SelectItem value="year">Year (newest first)</SelectItem>
                <SelectItem value="taggedAt">Recently tagged</SelectItem>
                <SelectItem value="bpm">Tempo (slow → fast)</SelectItem>
                <SelectItem value="loudness">Loudness (loud → quiet)</SelectItem>
                <SelectItem value="pace">Pace (intense → calm)</SelectItem>
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
  tab: TableVariant;
  rows: Track[];
  loading: boolean;
  queuing: string | null;
  retagging: string | null;
  flashId: string | null;
  onQueue: (t: Track) => void;
  onRetag: (t: Track) => void;
  blocking: string | null;
  onBlock: (t: Track, type: BlockType) => void;
  vocab: string[];
  editingId: string | null;
  manualBusy: string | null;
  onEdit: (t: Track) => void;
  onSaveManual: (t: Track, moods: string[], energy: string | null, applyToAlbum: boolean) => void;
  onCancelEdit: () => void;
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onToggleAll: (rows: Track[]) => void;
}

function TrackTable(p: TrackTableProps) {
  if (p.loading && p.rows.length === 0) {
    return <div className="px-4 py-8 text-center text-[12px] text-muted italic">loading…</div>;
  }
  if (p.rows.length === 0) {
    return (
      <div className="px-4 py-10 text-center text-[12px] text-muted italic">
        {p.tab === 'browse' && 'no tracks match, try clearing some filters'}
        {p.tab === 'search' && 'search your library to queue a track on demand'}
        {p.tab === 'untagged' && 'every track is tagged, nice'}
        {p.tab === 'recent' && 'nothing here yet'}
      </div>
    );
  }

  const allSelected = p.rows.length > 0 && p.rows.every(t => p.selected.has(t.id));

  return (
    // Dim (don't blank) stale rows while a refetch is in flight, so filter
    // changes read as "updating" instead of silently showing old results.
    <div className={cn(p.loading && 'opacity-60 transition-opacity')}>
      <div className="lib-colhead">
        <span>
          <input
            type="checkbox"
            checked={allSelected}
            onChange={() => p.onToggleAll(p.rows)}
            aria-label={allSelected ? 'deselect all tracks' : 'select all tracks'}
          />
        </span>
        <span />
        <span>title</span>
        <span className="h-tags">mood · energy</span>
        <span />
      </div>
      {p.rows.map(t => {
        const tagged = !!(t.moods && t.moods.length > 0);
        const editing = p.editingId === t.id;
        const dur = fmtDuration(t.duration);
        return (
          <Fragment key={t.id}>
          <div className={cn('lib-row', p.flashId === t.id && 'flash')}>
            <input
              type="checkbox"
              checked={p.selected.has(t.id)}
              onChange={() => p.onToggleSelect(t.id)}
              aria-label={`select ${t.title || 'track'}`}
            />
            <Thumb track={t} />
            <div className="min-w-0">
              <div className="lib-title">{t.title || '—'}</div>
              <div className="lib-artist">{t.artist || '—'}{t.year ? ` · ${t.year}` : ''}{dur ? ` · ${dur}` : ''}</div>
              {t.album && <div className="lib-album">{t.album}</div>}
            </div>
            <div className="lib-tags">
              {tagged ? (
                <>
                  {t.moods!.slice(0, 2).map(m => <span key={m} className="lib-mtag">{m}</span>)}
                  {t.energy && <span className="lib-mtag"><EnergyMeter level={t.energy} />{t.energy}</span>}
                  {t.source === 'manual' && <span className="lib-mtag" title="hand-tagged by an operator">manual</span>}
                </>
              ) : (
                <span className="lib-needs" title="needs tags — tag it so the DJ can pick it" aria-label="needs tags">
                  <Tags size={12} />
                </span>
              )}
              {/* acoustic-analysis badges — independent of mood tagging, shown
                  whenever the analyze pass has filled them in */}
              {t.bpm != null && <span className="lib-mtag lib-atag" title="tempo">{Math.round(t.bpm)} BPM</span>}
              {t.musicalKey && <span className="lib-mtag lib-atag" title="musical key">{t.musicalKey}</span>}
              {t.loudnessLufs != null && <span className="lib-mtag lib-atag" title="integrated loudness (LUFS)">{t.loudnessLufs.toFixed(1)} LUFS</span>}
              {t.instrumental === true && <span className="lib-mtag lib-atag" title="no vocals detected">instrumental</span>}
              {/* sounds-like results carry their cosine match vs the query —
                  shows where relevance falls off down the list */}
              {t.similarity != null && <span className="lib-mtag lib-atag" title="sound match vs your description">≈ {Math.round(t.similarity * 100)}%</span>}
            </div>
            {/* icon-only action cluster — tooltips carry the verbs; the fixed
                150px grid track keeps it aligned under the (empty) header cell */}
            <div className="flex items-center justify-end gap-1.5">
              <Btn sm onClick={() => p.onQueue(t)} disabled={!!p.queuing} title="Queue on air">
                {p.queuing === t.id ? '…' : <ListPlus size={12} />}
              </Btn>
              <Btn
                sm
                tone={editing ? 'accent' : undefined}
                onClick={() => p.onEdit(t)}
                disabled={!!p.manualBusy}
                title="Edit moods manually"
              >
                {editing ? <X size={12} /> : <Pencil size={12} />}
              </Btn>
              {/* All track tabs — an untagged track found via search/recent can
                  be LLM-tagged on the spot (/library/retag takes the row body). */}
              <Btn
                sm
                tone={p.tab === 'untagged' || !tagged ? 'accent' : 'solid'}
                onClick={() => p.onRetag(t)}
                disabled={!!p.retagging}
                title={tagged ? 'Retag with AI' : 'Tag with AI'}
              >
                {p.retagging === t.id ? '…' : tagged
                  ? <RotateCcw size={11} />
                  : <Sparkles size={11} />}
              </Btn>
              <BlockMenu
                track={t}
                busy={p.blocking === t.id}
                disabled={!!p.blocking}
                onBlock={p.onBlock}
              />
            </div>
          </div>
          {editing && (
            <ManualTagEditor
              track={t}
              vocab={p.vocab}
              busy={p.manualBusy === t.id}
              onSave={(moods, energy, applyToAlbum) => p.onSaveManual(t, moods, energy, applyToAlbum)}
              onCancel={p.onCancelEdit}
            />
          )}
          </Fragment>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BlockMenu — the per-row "Never play" action. A Ban button opening a small
// scope menu (track / album / artist); the server resolves album/artist ids
// from the track id, so the row only needs t.id. No confirm dialog — blocking
// is one-click reversible from the Blocked tab.
// ---------------------------------------------------------------------------
function BlockMenu({ track, busy, disabled, onBlock }: {
  track: Track;
  busy: boolean;
  disabled: boolean;
  onBlock: (t: Track, type: BlockType) => void;
}) {
  const [open, setOpen] = useState(false);
  const pick = (type: BlockType) => { setOpen(false); onBlock(track, type); };
  return (
    <div className="relative">
      <Btn sm onClick={() => setOpen(o => !o)} disabled={disabled} title="Never play this on air">
        {busy ? '…' : <Ban size={12} />}
      </Btn>
      {open && (
        <>
          {/* click-away backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute top-full right-0 z-50 mt-1 min-w-[200px] rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
            <button type="button" className="block w-full rounded px-2.5 py-1.5 text-left text-[12px] hover:bg-[var(--ink-soft)] hover:text-ink" onClick={() => pick('track')}>
              Never play this track
            </button>
            {track.album && (
              <button type="button" className="block w-full rounded px-2.5 py-1.5 text-left text-[12px] hover:bg-[var(--ink-soft)] hover:text-ink" onClick={() => pick('album')}>
                Never play this album
              </button>
            )}
            {track.artist && (
              <button type="button" className="block w-full rounded px-2.5 py-1.5 text-left text-[12px] hover:bg-[var(--ink-soft)] hover:text-ink" onClick={() => pick('artist')}>
                Never play this artist
                <span className="block text-[10px] text-muted">primary credit only — collabs filed under other artists still play</span>
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BlockedTab — the never-play blocklist manager. Lists entries newest-first
// with a type badge and one-click unblock. The list governs AIRING only:
// blocked tracks still appear in browse/search (the library browser shows the
// library), they just never make it to the queue.
// ---------------------------------------------------------------------------
function BlockedTab({ entries, loading, unblocking, onUnblock, onRefresh }: {
  entries: BlockEntry[] | null;
  loading: boolean;
  unblocking: string | null;
  onUnblock: (e: BlockEntry) => void;
  onRefresh: () => void;
}) {
  const rows = (entries || []).slice().sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));
  return (
    <Card
      title="Never play"
      sub={entries ? `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} — these are refused everywhere: DJ picks, requests, even manual queueing` : ''}
      right={
        <Btn sm onClick={onRefresh} disabled={loading}>
          <RefreshCw size={11} /> {loading ? 'Loading…' : 'Refresh'}
        </Btn>
      }
      bodyClass="!p-0"
    >
      {rows.length === 0 ? (
        <div className="px-4 py-10 text-center text-[12px] text-muted italic">
          {loading ? 'loading…' : (
            <>nothing blocked — use the <Ban size={11} className="inline align-[-1px]" /> action on any track row to keep a track, album or artist off the air</>
          )}
        </div>
      ) : (
        <div className={cn(loading && 'opacity-60 transition-opacity')}>
          {rows.map(e => {
            const key = `${e.type}:${e.id}`;
            return (
              <div key={key} className="flex items-center gap-3 border-b border-dashed border-[var(--separator-strong)] px-4 py-2.5 last:border-b-0">
                <span className="lib-mtag shrink-0" title={`blocked ${e.type}`}>{e.type}</span>
                <div className="min-w-0 flex-1">
                  <div className="lib-title">{e.name || e.id}</div>
                  {(e.artist || e.album) && e.type !== 'artist' && (
                    <div className="lib-artist">{e.artist || ''}{e.album && e.type === 'track' ? ` · ${e.album}` : ''}</div>
                  )}
                </div>
                <span className="hidden text-[11px] text-muted sm:block" title="blocked on">
                  {e.addedAt ? new Date(e.addedAt).toLocaleDateString('en-GB') : ''}
                </span>
                <Btn sm onClick={() => onUnblock(e)} disabled={!!unblocking}>
                  {unblocking === key ? '…' : <><X size={12} /> Unblock</>}
                </Btn>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// ManualTagEditor — inline mood/energy editor under a track row. Operator-set
// tags (source='manual') feed songsByMood() → the picker exactly like the
// LLM tagger's, and "apply to whole album" tags every track on the album so a
// folder/album of content can be targeted at once (discussion #336).
// ---------------------------------------------------------------------------
const ENERGY_SEG: { id: string; label: string }[] = [
  { id: 'none', label: 'none' },
  { id: 'low', label: 'low' },
  { id: 'medium', label: 'med' },
  { id: 'high', label: 'high' },
];

function ManualTagEditor(props: {
  track: Track;
  vocab: string[];
  busy: boolean;
  onSave: (moods: string[], energy: string | null, applyToAlbum: boolean) => void;
  onCancel: () => void;
}) {
  const { track, vocab, busy } = props;
  const [sel, setSel] = useState<string[]>((track.moods || []).slice(0, 3));
  const [energy, setEnergy] = useState<string>(track.energy || 'none');
  const [applyToAlbum, setApplyToAlbum] = useState(false);

  const toggle = (m: string) =>
    setSel(cur => cur.includes(m) ? cur.filter(x => x !== m) : (cur.length >= 3 ? cur : [...cur, m]));
  const energyVal = energy === 'none' ? null : energy;

  return (
    <div className="grid gap-3 border-b border-ink bg-[var(--ink-softer)] px-4 py-3">
      <div className="grid gap-1.5">
        <Eyebrow>moods · up to 3</Eyebrow>
        <div className="flex flex-wrap gap-1.5">
          {vocab.length === 0 && (
            <span className="text-[11px] text-muted italic">loading moods…</span>
          )}
          {vocab.map(m => {
            const on = sel.includes(m);
            return (
              <Pill
                key={m}
                tone={on ? 'accent' : 'default'}
                onClick={busy || (!on && sel.length >= 3) ? undefined : () => toggle(m)}
                className={cn(
                  (busy || (!on && sel.length >= 3)) && !on && 'opacity-40',
                  !busy && 'cursor-pointer',
                )}
              >
                {m}
              </Pill>
            );
          })}
        </div>
      </div>
      <div className="grid gap-1.5">
        <Eyebrow>energy</Eyebrow>
        <div><Seg value={energy} options={ENERGY_SEG} onChange={setEnergy} /></div>
      </div>
      <label className="flex items-center gap-2 text-[12px] text-ink">
        <input
          type="checkbox"
          checked={applyToAlbum}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setApplyToAlbum(e.target.checked)}
          disabled={busy}
        />
        apply to whole album{track.album ? ` “${track.album}”` : ''}
      </label>
      <div className="flex items-center gap-2">
        <Btn sm tone="accent" onClick={() => props.onSave(sel, energyVal, applyToAlbum)} disabled={busy || sel.length === 0}>
          {busy ? 'Saving…' : 'Save tags'}
        </Btn>
        <Btn sm tone="danger" onClick={() => props.onSave([], null, applyToAlbum)} disabled={busy}>
          Clear tags
        </Btn>
        <Btn sm onClick={props.onCancel} disabled={busy}>Cancel</Btn>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AddToPlaylistBar — shown while rows are selected on any track tab. Adds the
// selection to an existing Navidrome playlist or creates a new one; both go
// through the controller's /playlists routes (Subsonic createPlaylist /
// updatePlaylist under the hood).
// ---------------------------------------------------------------------------
function AddToPlaylistBar({ count, playlists, busy, onAdd, onClear }: {
  count: number;
  playlists: PlaylistSummary[] | null;
  busy: boolean;
  onAdd: (target: { playlistId?: string; name?: string }) => void;
  onClear: () => void;
}) {
  const [target, setTarget] = useState<string>('__new');
  const [name, setName] = useState('');
  const creating = target === '__new';
  const canAdd = creating ? !!name.trim() : true;

  return (
    <Card bodyClass="!py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[12px] font-bold text-ink">
          {count} track{count === 1 ? '' : 's'} selected
        </span>
        <Select value={target} onValueChange={setTarget}>
          <SelectTrigger className="min-w-[180px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__new">New playlist…</SelectItem>
            {(playlists || []).map(p => (
              <SelectItem key={p.id} value={p.id}>
                {p.name} · {p.songCount}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {creating && (
          <Input
            placeholder="playlist name"
            className="w-48"
            value={name}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
          />
        )}
        <Btn
          sm
          tone="accent"
          disabled={busy || !canAdd}
          onClick={() => onAdd(creating ? { name: name.trim() } : { playlistId: target })}
        >
          <ListMusic size={12} /> {busy ? 'Adding…' : creating ? 'Create playlist' : 'Add to playlist'}
        </Btn>
        <Btn sm onClick={onClear} disabled={busy}>Clear selection</Btn>
      </div>
    </Card>
  );
}

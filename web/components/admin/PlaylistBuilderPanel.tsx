'use client';

/* Magical Playlist Builder — the "studio console" screen.
   Spec: docs/superpowers/specs/2026-07-15-magical-playlist-builder-design.md

   Two zones in the newsprint idiom: a CONSOLE (prompt + seeds + knobs → one
   Generate action) and a DECK (the ordered, hand-editable tracklist with a live
   tape counter + energy-arc sparkline). Save writes to Navidrome via the
   existing /playlists routes; the result feeds Shows' playlist picker. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Wand2, Plus, X, GripVertical, RefreshCw, Save, Search, ChevronUp, ChevronDown,
  Sparkles, Disc3, FolderOpen, FilePlus2, CircleDot, Music4, Radio,
} from 'lucide-react';
import { useAdminAuth } from '../../lib/adminAuth';
import { Eyebrow, Btn, Pill, MetaChip } from './ui';
import { cn } from '../../lib/cn';

const API = (process.env.NEXT_PUBLIC_API_URL as string | undefined) || '/api';

// Mirrors SHOW_MOODS in controller/src/settings.ts (stable vocab).
const MOODS = [
  'energetic', 'calm', 'reflective', 'celebratory', 'romantic', 'spiritual',
  'focus', 'workout', 'driving', 'cooking', 'rainy', 'sunny', 'night', 'morning',
  'evening', 'festival', 'cultural',
];
const ENERGIES = ['low', 'medium', 'high'];
const ARCS: { id: ArcShape; label: string; hint: string }[] = [
  { id: 'flat', label: 'Steady', hint: 'even energy throughout' },
  { id: 'build', label: 'Build', hint: 'calm → energetic' },
  { id: 'peak-then-cool', label: 'Peak', hint: 'rise, then cool down' },
  { id: 'wind-down', label: 'Wind down', hint: 'high → mellow' },
];
const DECADES: { label: string; fromYear: number; toYear: number }[] = [
  { label: "60s", fromYear: 1960, toYear: 1969 },
  { label: "70s", fromYear: 1970, toYear: 1979 },
  { label: "80s", fromYear: 1980, toYear: 1989 },
  { label: "90s", fromYear: 1990, toYear: 1999 },
  { label: "00s", fromYear: 2000, toYear: 2009 },
  { label: "10s", fromYear: 2010, toYear: 2019 },
  { label: "20s", fromYear: 2020, toYear: 2029 },
];

type ArcShape = 'flat' | 'build' | 'peak-then-cool' | 'wind-down';

interface DraftTrack {
  id: string;
  title: string;
  artist: string;
  album?: string;
  durationSec: number;
  year?: number | null;
  genre?: string | null;
  energy?: string | null;
  moods?: string[];
  instrumental?: boolean | null;
}
interface SeedChip { id: string; title: string; artist: string }
interface PlaylistSummary { id: string; name: string; songCount: number; synced?: boolean; lastSyncedAt?: string | null }

// Loose shape for /dj/search rows and /playlists/:id entries — the controller
// returns Subsonic-derived fields with varying key names across endpoints.
interface RawTrackRow {
  id: string;
  title?: string;
  artist?: string;
  album?: string;
  duration?: number;
  durationSec?: number;
  year?: number | null;
}

function fmtDur(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${m}:${String(ss).padStart(2, '0')}`;
}
const energyLevel = (e?: string | null): number => (e === 'low' ? 0 : e === 'high' ? 2 : 1);

// ── Energy-arc sparkline ──────────────────────────────────────────────────────
// A hand-drawn feel: the curve of the built set's energy over its runtime.
function ArcSpark({ tracks, className }: { tracks: DraftTrack[]; className?: string }) {
  const W = 320;
  const H = 40;
  const pts = useMemo(() => {
    if (tracks.length < 2) return '';
    const n = tracks.length;
    return tracks.map((t, i) => {
      const x = (i / (n - 1)) * W;
      const y = H - 4 - (energyLevel(t.energy) / 2) * (H - 8);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  }, [tracks]);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={cn('block h-10 w-full', className)}
      aria-hidden
    >
      <line x1="0" y1={H - 4} x2={W} y2={H - 4} stroke="var(--separator-strong)" strokeWidth="1" />
      {pts && (
        <polyline
          points={pts}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

export default function PlaylistBuilderPanel() {
  const { adminFetch } = useAdminAuth();

  // Console state
  const [prompt, setPrompt] = useState('');
  const [seeds, setSeeds] = useState<SeedChip[]>([]);
  const [moods, setMoods] = useState<string[]>([]);
  const [genresText, setGenresText] = useState('');
  const [energies, setEnergies] = useState<string[]>([]);
  const [decades, setDecades] = useState<string[]>([]);
  const [arc, setArc] = useState<ArcShape>('flat');
  const [count, setCount] = useState(25);
  const [artistSpacing, setArtistSpacing] = useState(2);
  const [maxTrackSec, setMaxTrackSec] = useState(0); // 0 = no cap
  const [excludeRecent, setExcludeRecent] = useState(false);
  const [instrumentalOnly, setInstrumentalOnly] = useState(false);
  const [recentlyAdded, setRecentlyAdded] = useState(false);
  const [tuneOpen, setTuneOpen] = useState(true);

  // Deck state
  const [name, setName] = useState('');
  const [tracks, setTracks] = useState<DraftTrack[]>([]);
  const [existingId, setExistingId] = useState<string | undefined>();
  const [keepInSync, setKeepInSync] = useState(false);
  const [syncInfo, setSyncInfo] = useState<{ lastSyncedAt: string | null } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [reasons, setReasons] = useState<string[]>([]);
  const [usedFallback, setUsedFallback] = useState(false);

  // Async / UX state
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);

  // Search (seed + manual add)
  const [seedQuery, setSeedQuery] = useState('');
  const [seedResults, setSeedResults] = useState<SeedChip[] | null>(null);
  const [addQuery, setAddQuery] = useState('');
  const [addResults, setAddResults] = useState<DraftTrack[] | null>(null);

  // Open-existing picker
  const [pickerOpen, setPickerOpen] = useState(false);
  const [playlists, setPlaylists] = useState<PlaylistSummary[] | null>(null);

  const dragIndex = useRef<number | null>(null);

  const flash = useCallback((kind: 'ok' | 'err', msg: string) => {
    setToast({ kind, msg });
    window.setTimeout(() => setToast(null), 4200);
  }, []);

  const totalSec = useMemo(() => tracks.reduce((s, t) => s + (t.durationSec || 0), 0), [tracks]);
  const dupeIds = useMemo(() => {
    const seen = new Set<string>();
    const dup = new Set<string>();
    for (const t of tracks) { if (seen.has(t.id)) dup.add(t.id); seen.add(t.id); }
    return dup;
  }, [tracks]);

  const decadeWindows = useCallback(
    () => DECADES.filter(d => decades.includes(d.label)).map(d => ({ fromYear: d.fromYear, toYear: d.toYear })),
    [decades],
  );

  const buildBody = useCallback((excludeTrackIds: string[] = []) => ({
    prompt: prompt.trim() || undefined,
    seedTrackIds: seeds.map(s => s.id),
    knobs: {
      targetCount: count,
      energyArc: arc,
      moods,
      genres: genresText.split(',').map(g => g.trim()).filter(Boolean),
      energies,
      eras: decadeWindows(),
      artistSpacing,
      excludeRecentlyPlayed: excludeRecent,
      instrumentalOnly,
      maxTrackSeconds: maxTrackSec || undefined,
    },
    sources: { recentlyAdded },
    excludeTrackIds,
  }), [prompt, seeds, count, arc, moods, genresText, energies, decadeWindows, artistSpacing, excludeRecent, instrumentalOnly, maxTrackSec, recentlyAdded]);

  const hasIntent = prompt.trim() || seeds.length || recentlyAdded || moods.length ||
    genresText.trim() || energies.length || decades.length || instrumentalOnly;

  const generate = useCallback(async (mode: 'fresh' | 'regenerate' | 'more') => {
    if (generating) return;
    const exclude = mode === 'fresh' ? [] : tracks.map(t => t.id);
    setGenerating(true);
    setReasons([]);
    try {
      const r = await adminFetch('/playlists/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody(exclude)),
      });
      const j = await r.json();
      if (!r.ok) { flash('err', j.error || 'generation failed'); return; }
      const got: DraftTrack[] = j.tracks || [];
      setReasons(j.reasons || []);
      setUsedFallback(!!j.usedFallback);
      if (!got.length) { flash('err', j.message || 'nothing matched — loosen the filters'); return; }
      if (mode === 'more') {
        setTracks(prev => [...prev, ...got]);
        flash('ok', `added ${got.length} more`);
      } else {
        setTracks(got);
        if (j.name && (!name.trim() || mode === 'fresh')) setName(j.name);
        flash('ok', `${got.length} tracks${j.usedFallback ? ' (deterministic)' : ''}`);
      }
    } catch (err) {
      flash('err', err instanceof Error ? err.message : 'generation failed');
    } finally {
      setGenerating(false);
    }
  }, [generating, tracks, adminFetch, buildBody, flash, name]);

  // Seed search (debounced)
  useEffect(() => {
    const q = seedQuery.trim();
    if (q.length < 2) { setSeedResults(null); return; }
    const h = window.setTimeout(async () => {
      try {
        const r = await adminFetch(`/dj/search?q=${encodeURIComponent(q)}&limit=8`);
        const j = await r.json();
        setSeedResults((j.results || j.songs || j.tracks || []).map((s: RawTrackRow) => ({ id: s.id, title: s.title || '', artist: s.artist || '' })));
      } catch { setSeedResults([]); }
    }, 250);
    return () => window.clearTimeout(h);
  }, [seedQuery, adminFetch]);

  // Manual add search (debounced)
  useEffect(() => {
    const q = addQuery.trim();
    if (q.length < 2) { setAddResults(null); return; }
    const h = window.setTimeout(async () => {
      try {
        const r = await adminFetch(`/dj/search?q=${encodeURIComponent(q)}&limit=10`);
        const j = await r.json();
        setAddResults((j.results || j.songs || j.tracks || []).map((s: RawTrackRow) => ({
          id: s.id, title: s.title || '', artist: s.artist || '', album: s.album, durationSec: s.durationSec ?? s.duration ?? 0, year: s.year,
        })));
      } catch { setAddResults([]); }
    }, 250);
    return () => window.clearTimeout(h);
  }, [addQuery, adminFetch]);

  const toggle = (list: string[], set: (v: string[]) => void, v: string) =>
    set(list.includes(v) ? list.filter(x => x !== v) : [...list, v]);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= tracks.length) return;
    setTracks(prev => {
      const next = [...prev];
      const [row] = next.splice(from, 1);
      if (!row) return prev;
      next.splice(to, 0, row);
      return next;
    });
  };
  const removeAt = (i: number) => setTracks(prev => prev.filter((_, idx) => idx !== i));
  const addTrack = (t: DraftTrack) => {
    setTracks(prev => [...prev, t]);
    setAddQuery('');
    setAddResults(null);
  };

  const openExisting = useCallback(async () => {
    setPickerOpen(true);
    if (playlists) return;
    try {
      const r = await adminFetch('/playlists');
      const j = await r.json();
      setPlaylists(j.playlists || []);
    } catch { setPlaylists([]); }
  }, [adminFetch, playlists]);

  const loadPlaylist = useCallback(async (p: PlaylistSummary) => {
    try {
      const r = await adminFetch(`/playlists/${encodeURIComponent(p.id)}`);
      const j = await r.json();
      setTracks((j.entries || []).map((e: RawTrackRow) => ({
        id: e.id, title: e.title || '', artist: e.artist || '', album: e.album, durationSec: e.durationSec ?? 0, year: e.year,
      })));
      setName(p.name);
      setExistingId(p.id);
      setKeepInSync(!!p.synced);
      setSyncInfo(p.synced ? { lastSyncedAt: p.lastSyncedAt ?? null } : null);
      setReasons([]);
      setPickerOpen(false);
      flash('ok', `loaded "${p.name}"`);
    } catch { flash('err', 'could not load playlist'); }
  }, [adminFetch, flash]);

  const newEmpty = () => {
    setTracks([]); setName(''); setExistingId(undefined); setReasons([]); setSavedId(null);
    setKeepInSync(false); setSyncInfo(null);
  };

  const save = useCallback(async () => {
    if (!name.trim()) { flash('err', 'name the playlist first'); return; }
    if (!tracks.length) { flash('err', 'nothing to save'); return; }
    setSaving(true);
    try {
      const r = await adminFetch('/playlists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          songIds: tracks.map(t => t.id),
          playlistId: existingId,
          keepInSync,
          recipe: keepInSync ? buildBody() : undefined,
        }),
      });
      const j = await r.json();
      if (!r.ok) { flash('err', j.error || 'save failed'); return; }
      const id = j.playlist?.id || existingId || null;
      setExistingId(id || undefined);
      setSavedId(id);
      if (keepInSync && !syncInfo) setSyncInfo({ lastSyncedAt: null });
      if (!keepInSync) setSyncInfo(null);
      flash('ok', (existingId ? 'playlist updated' : 'playlist saved to Navidrome') + (keepInSync ? ' · sync on' : ''));
    } catch (err) {
      flash('err', err instanceof Error ? err.message : 'save failed');
    } finally {
      setSaving(false);
    }
  }, [name, tracks, existingId, keepInSync, syncInfo, buildBody, adminFetch, flash]);

  const syncNow = useCallback(async () => {
    if (!existingId || syncing) return;
    setSyncing(true);
    try {
      const r = await adminFetch(`/playlists/${encodeURIComponent(existingId)}/sync`, { method: 'POST' });
      const j = await r.json();
      if (!r.ok) { flash('err', j.error || 'sync failed'); return; }
      setSyncInfo({ lastSyncedAt: new Date().toISOString() });
      flash('ok', j.added ? `synced · added ${j.added} new track${j.added === 1 ? '' : 's'}` : 'synced · nothing new');
      // Reload the deck so appended tracks show.
      if (j.added) {
        const pr = await adminFetch(`/playlists/${encodeURIComponent(existingId)}`);
        const pj = await pr.json();
        if (pr.ok) setTracks((pj.entries || []).map((e: RawTrackRow) => ({
          id: e.id, title: e.title || '', artist: e.artist || '', album: e.album, durationSec: e.durationSec ?? 0, year: e.year,
        })));
      }
    } catch (err) {
      flash('err', err instanceof Error ? err.message : 'sync failed');
    } finally {
      setSyncing(false);
    }
  }, [existingId, syncing, adminFetch, flash]);

  return (
    <div className="admin-root mx-auto max-w-[1180px] px-4 pt-6 pb-24 sm:px-6">
      {/* Masthead */}
      <header className="mb-6 border-b border-ink pb-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <Eyebrow>Studio · Programming</Eyebrow>
            <h1 className="mt-1 flex items-center gap-2 text-3xl font-black tracking-tight text-ink sm:text-4xl">
              <Wand2 className="size-7 text-vermilion" strokeWidth={2.4} />
              Playlist Builder
            </h1>
            <p className="mt-1 max-w-xl text-sm text-muted">
              Describe a vibe, drop a few seeds, tune the knobs — the station assembles an ordered set you can reshape by hand, then save straight into the Shows picker.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Btn sm onClick={openExisting}><FolderOpen className="mr-1 size-3.5" />Open</Btn>
            <Btn sm onClick={newEmpty}><FilePlus2 className="mr-1 size-3.5" />New</Btn>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        {/* ── CONSOLE ── */}
        <section className="space-y-4">
          {/* Prompt console */}
          <div className="relative overflow-hidden border border-ink bg-ink-soft">
            <div className="flex items-center justify-between border-b border-separator-strong px-3 py-2">
              <span className="eyebrow text-muted">The vibe</span>
              <span className="flex items-center gap-1.5 text-[10px] font-bold tracking-eyebrow text-muted uppercase">
                <CircleDot className={cn('size-3', generating ? 'animate-pulse text-vermilion' : 'text-muted')} />
                {generating ? 'assembling' : 'ready'}
              </span>
            </div>
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              rows={3}
              placeholder={'“rainy sunday jazz that warms up halfway through”\n“late-night driving synths, moody and instrumental”'}
              className="w-full resize-none bg-transparent px-3 py-3 font-serif text-lg leading-snug text-ink outline-none placeholder:text-muted/60"
            />
            {/* Seeds */}
            <div className="border-t border-separator-strong px-3 py-2.5">
              <div className="mb-1.5 flex items-center gap-2">
                <Sparkles className="size-3.5 text-vermilion" />
                <span className="eyebrow text-muted">Seeds — anchor tracks</span>
              </div>
              {seeds.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {seeds.map(s => (
                    <Pill key={s.id} tone="ink" onClick={() => setSeeds(seeds.filter(x => x.id !== s.id))} title="remove seed">
                      {s.title} · {s.artist} <X className="ml-1 inline size-3" />
                    </Pill>
                  ))}
                </div>
              )}
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted" />
                <input
                  value={seedQuery}
                  onChange={e => setSeedQuery(e.target.value)}
                  placeholder="search a track to seed from…"
                  className="w-full border border-separator-strong bg-bg py-1.5 pr-2 pl-7 text-sm text-ink outline-none focus:border-ink"
                />
                {seedResults && seedResults.length > 0 && (
                  <div className="absolute z-20 mt-1 max-h-56 w-full overflow-auto border border-ink bg-bg shadow-lg">
                    {seedResults.map(s => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => { if (!seeds.some(x => x.id === s.id)) setSeeds([...seeds, s]); setSeedQuery(''); setSeedResults(null); }}
                        className="flex w-full items-center gap-2 border-b border-separator-strong px-2 py-1.5 text-left text-sm hover:bg-ink-soft"
                      >
                        <Plus className="size-3 text-vermilion" />
                        <span className="truncate"><span className="font-semibold text-ink">{s.title}</span> <span className="text-muted">· {s.artist}</span></span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Generate bar */}
            <div className="flex items-center gap-2 border-t border-ink bg-bg px-3 py-2.5">
              <button
                type="button"
                onClick={() => generate('fresh')}
                disabled={generating || !hasIntent}
                className={cn(
                  'group relative flex flex-1 items-center justify-center gap-2 border border-ink px-4 py-2.5 text-sm font-black tracking-eyebrow uppercase transition',
                  generating || !hasIntent
                    ? 'cursor-not-allowed bg-ink-soft text-muted'
                    : 'bg-vermilion text-white hover:brightness-110',
                )}
              >
                <Wand2 className={cn('size-4', generating && 'animate-spin')} />
                {generating ? 'Assembling…' : tracks.length ? 'Generate fresh' : 'Generate'}
              </button>
              {tracks.length > 0 && (
                <>
                  <Btn sm onClick={() => generate('regenerate')} disabled={generating} title="new set, same recipe">
                    <RefreshCw className="size-3.5" />
                  </Btn>
                  <Btn sm onClick={() => generate('more')} disabled={generating} title="append more">
                    <Plus className="size-3.5" />
                  </Btn>
                </>
              )}
            </div>
          </div>

          {/* Tune drawer */}
          <div className="border border-ink">
            <button
              type="button"
              onClick={() => setTuneOpen(v => !v)}
              className="flex w-full items-center justify-between border-b border-separator-strong px-3 py-2"
            >
              <span className="flex items-center gap-2"><Disc3 className="size-3.5 text-vermilion" /><span className="eyebrow text-muted">Tune the recipe</span></span>
              {tuneOpen ? <ChevronUp className="size-4 text-muted" /> : <ChevronDown className="size-4 text-muted" />}
            </button>
            {tuneOpen && (
              <div className="space-y-4 px-3 py-3">
                {/* Length + spacing */}
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="eyebrow text-muted">Length · <span className="mono-num text-ink">{count}</span> tracks</span>
                    <input type="range" min={5} max={60} value={count} onChange={e => setCount(+e.target.value)} className="mt-1 w-full accent-[var(--accent)]" />
                  </label>
                  <label className="block">
                    <span className="eyebrow text-muted">Artist gap · <span className="mono-num text-ink">{artistSpacing}</span></span>
                    <input type="range" min={0} max={5} value={artistSpacing} onChange={e => setArtistSpacing(+e.target.value)} className="mt-1 w-full accent-[var(--accent)]" />
                  </label>
                </div>

                {/* Max track length */}
                <label className="block">
                  <span className="eyebrow text-muted">
                    Max track length · <span className="mono-num text-ink">{maxTrackSec ? fmtDur(maxTrackSec) : 'off'}</span>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={600}
                    step={15}
                    value={maxTrackSec}
                    onChange={e => setMaxTrackSec(+e.target.value)}
                    className="mt-1 w-full accent-[var(--accent)]"
                    aria-label="maximum track length in seconds (0 = no cap)"
                  />
                  <span className="mt-0.5 block text-[10px] text-muted">only include tracks this long or shorter · slide to 0 for no cap</span>
                </label>

                {/* Energy arc */}
                <div>
                  <span className="eyebrow text-muted">Energy arc</span>
                  <div className="mt-1.5 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                    {ARCS.map(a => (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => setArc(a.id)}
                        title={a.hint}
                        className={cn(
                          'border px-2 py-1.5 text-[11px] font-bold tracking-wide uppercase transition',
                          arc === a.id ? 'border-ink bg-ink text-bg' : 'border-separator-strong text-muted hover:border-ink hover:text-ink',
                        )}
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Moods */}
                <div>
                  <span className="eyebrow text-muted">Moods</span>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {MOODS.map(m => (
                      <button key={m} type="button" onClick={() => toggle(moods, setMoods, m)}
                        className={cn('border px-2 py-1 text-[11px] font-semibold capitalize transition',
                          moods.includes(m) ? 'border-vermilion bg-vermilion/10 text-vermilion' : 'border-separator-strong text-muted hover:border-ink hover:text-ink')}>
                        {m}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Energies + decades */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <span className="eyebrow text-muted">Energy</span>
                    <div className="mt-1.5 flex gap-1.5">
                      {ENERGIES.map(e => (
                        <button key={e} type="button" onClick={() => toggle(energies, setEnergies, e)}
                          className={cn('flex-1 border px-2 py-1 text-[11px] font-bold uppercase transition',
                            energies.includes(e) ? 'border-ink bg-ink text-bg' : 'border-separator-strong text-muted hover:border-ink')}>
                          {e}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <span className="eyebrow text-muted">Era</span>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {DECADES.map(d => (
                        <button key={d.label} type="button" onClick={() => toggle(decades, setDecades, d.label)}
                          className={cn('border px-1.5 py-1 text-[11px] font-bold uppercase transition',
                            decades.includes(d.label) ? 'border-ink bg-ink text-bg' : 'border-separator-strong text-muted hover:border-ink')}>
                          {d.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Genres */}
                <label className="block">
                  <span className="eyebrow text-muted">Genres — comma separated</span>
                  <input value={genresText} onChange={e => setGenresText(e.target.value)} placeholder="jazz, ambient, hip-hop"
                    className="mt-1 w-full border border-separator-strong bg-bg px-2 py-1.5 text-sm text-ink outline-none focus:border-ink" />
                </label>

                {/* Switch-row knobs */}
                <div className="grid grid-cols-1 gap-2 border-t border-separator-strong pt-3">
                  <KnobSwitch icon={<Music4 className="size-3.5" />} label="Instrumental only" hint="skip vocal-forward tracks" on={instrumentalOnly} onToggle={() => setInstrumentalOnly(v => !v)} />
                  <KnobSwitch icon={<Radio className="size-3.5" />} label="Recently added" hint="seed from new arrivals" on={recentlyAdded} onToggle={() => setRecentlyAdded(v => !v)} />
                  <KnobSwitch icon={<RefreshCw className="size-3.5" />} label="Skip recent plays" hint="avoid what just aired" on={excludeRecent} onToggle={() => setExcludeRecent(v => !v)} />
                </div>
              </div>
            )}
          </div>
        </section>

        {/* ── DECK ── */}
        <section className="border border-ink">
          {/* Deck head — tape counter + arc */}
          <div className="border-b border-ink bg-ink-soft px-3 py-3">
            <div className="flex items-end justify-between gap-3">
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Untitled set"
                className="min-w-0 flex-1 border-b border-transparent bg-transparent text-xl font-black text-ink outline-none placeholder:text-muted/50 focus:border-ink"
              />
              <div className="shrink-0 text-right">
                <div className="mono-num text-2xl leading-none font-black text-ink">{fmtDur(totalSec)}</div>
                <div className="eyebrow text-muted"><span className="mono-num">{tracks.length}</span> tracks</div>
              </div>
            </div>
            <ArcSpark tracks={tracks} className="mt-2" />
          </div>

          {/* Reasons / fallback strip */}
          {(reasons.length > 0 || usedFallback) && (
            <div className="border-b border-separator-strong bg-vermilion/[0.06] px-3 py-2 text-[11px] text-muted">
              {usedFallback && <div className="mb-0.5 font-bold text-vermilion">Deterministic fallback — the DJ model was unavailable, so this was arranged by energy/relevance.</div>}
              {reasons.map((r, i) => <div key={i}>· {r}</div>)}
            </div>
          )}

          {/* Manual add */}
          <div className="relative border-b border-separator-strong px-3 py-2">
            <Search className="pointer-events-none absolute top-1/2 left-5 size-3.5 -translate-y-1/2 text-muted" />
            <input
              value={addQuery}
              onChange={e => setAddQuery(e.target.value)}
              placeholder="add a track by hand…"
              className="w-full border border-separator-strong bg-bg py-1.5 pr-2 pl-7 text-sm text-ink outline-none focus:border-ink"
            />
            {addResults && addResults.length > 0 && (
              <div className="absolute right-3 left-3 z-20 mt-1 max-h-64 overflow-auto border border-ink bg-bg shadow-lg">
                {addResults.map(s => (
                  <button key={s.id} type="button" onClick={() => addTrack(s)}
                    className="flex w-full items-center gap-2 border-b border-separator-strong px-2 py-1.5 text-left text-sm hover:bg-ink-soft">
                    <Plus className="size-3 text-vermilion" />
                    <span className="truncate"><span className="font-semibold text-ink">{s.title}</span> <span className="text-muted">· {s.artist}</span></span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Tracklist */}
          <div className="max-h-[58vh] overflow-auto">
            {tracks.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 px-4 py-16 text-center">
                <Disc3 className="size-8 text-muted/50" />
                <p className="text-sm text-muted">No tracks yet. Describe a vibe and hit <span className="font-bold text-vermilion">Generate</span>, or open an existing playlist.</p>
              </div>
            ) : (
              <ol>
                {tracks.map((t, i) => (
                  <li
                    key={`${t.id}-${i}`}
                    draggable
                    onDragStart={() => { dragIndex.current = i; }}
                    onDragOver={e => e.preventDefault()}
                    onDrop={() => { if (dragIndex.current != null) move(dragIndex.current, i); dragIndex.current = null; }}
                    className={cn(
                      'group flex items-center gap-2 border-b border-separator-strong px-2 py-1.5',
                      dupeIds.has(t.id) && 'bg-vermilion/[0.06]',
                    )}
                  >
                    <GripVertical className="size-4 shrink-0 cursor-grab text-muted/50 group-hover:text-muted" />
                    <span className="mono-num w-6 shrink-0 text-right text-xs text-muted">{i + 1}</span>
                    <img
                      src={`${API}/cover/${encodeURIComponent(t.id)}`}
                      alt=""
                      loading="lazy"
                      className="size-9 shrink-0 border border-separator-strong bg-ink-soft object-cover"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-ink">{t.title}</span>
                      <span className="block truncate text-xs text-muted">{t.artist}</span>
                    </span>
                    <span className="hidden shrink-0 items-center gap-1 sm:flex">
                      {dupeIds.has(t.id) && <MetaChip accent>dupe</MetaChip>}
                      {t.instrumental === true && <MetaChip>inst</MetaChip>}
                      {t.energy && <MetaChip>{t.energy}</MetaChip>}
                    </span>
                    <span className="mono-num w-10 shrink-0 text-right text-xs text-muted">{fmtDur(t.durationSec || 0)}</span>
                    <span className="flex shrink-0 items-center opacity-0 transition group-hover:opacity-100">
                      <button type="button" onClick={() => move(i, i - 1)} disabled={i === 0} title="up" className="p-0.5 text-muted hover:text-ink disabled:opacity-30"><ChevronUp className="size-4" /></button>
                      <button type="button" onClick={() => move(i, i + 1)} disabled={i === tracks.length - 1} title="down" className="p-0.5 text-muted hover:text-ink disabled:opacity-30"><ChevronDown className="size-4" /></button>
                      <button type="button" onClick={() => removeAt(i)} title="remove" className="p-0.5 text-muted hover:text-vermilion"><X className="size-4" /></button>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>

          {/* Keep-in-sync row */}
          <div className="flex items-center justify-between gap-2 border-t border-separator-strong bg-bg px-3 py-2">
            <KnobSwitch
              icon={<RefreshCw className="size-3.5" />}
              label="Keep in sync"
              hint="auto-add new library songs that match this recipe"
              on={keepInSync}
              onToggle={() => setKeepInSync(v => !v)}
            />
            {existingId && (keepInSync || syncInfo) && (
              <div className="flex shrink-0 items-center gap-2">
                {syncInfo && (
                  <span className="text-[10px] text-muted">
                    {syncInfo.lastSyncedAt ? `synced ${new Date(syncInfo.lastSyncedAt).toLocaleDateString()}` : 'not synced yet'}
                  </span>
                )}
                <Btn sm onClick={syncNow} disabled={syncing} title="check the library for new matches now">
                  <RefreshCw className={cn('mr-1 size-3.5', syncing && 'animate-spin')} />
                  {syncing ? 'Syncing…' : 'Sync now'}
                </Btn>
              </div>
            )}
          </div>

          {/* Save toolbar */}
          <div className="flex items-center gap-2 border-t border-ink bg-bg px-3 py-2.5">
            <button
              type="button"
              onClick={save}
              disabled={saving || !tracks.length || !name.trim()}
              className={cn(
                'flex flex-1 items-center justify-center gap-2 border border-ink px-4 py-2 text-sm font-black tracking-eyebrow uppercase transition',
                saving || !tracks.length || !name.trim() ? 'cursor-not-allowed bg-ink-soft text-muted' : 'bg-ink text-bg hover:bg-ink/90',
              )}
            >
              <Save className="size-4" />
              {saving ? 'Saving…' : existingId ? 'Update playlist' : 'Save to Navidrome'}
            </button>
            {savedId && (
              <a href="/admin/shows" className="border border-vermilion px-3 py-2 text-[11px] font-bold tracking-eyebrow text-vermilion uppercase hover:bg-vermilion/10">
                Pin to a show →
              </a>
            )}
          </div>
        </section>
      </div>

      {/* Open-existing picker */}
      {pickerOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/40 p-4 pt-24" onClick={() => setPickerOpen(false)}>
          <div className="w-full max-w-md border border-ink bg-bg shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-ink px-3 py-2">
              <span className="eyebrow text-muted">Open a playlist</span>
              <button type="button" onClick={() => setPickerOpen(false)}><X className="size-4 text-muted hover:text-ink" /></button>
            </div>
            <div className="max-h-[50vh] overflow-auto">
              {playlists === null ? (
                <div className="px-3 py-8 text-center text-sm text-muted">Loading…</div>
              ) : playlists.length === 0 ? (
                <div className="px-3 py-8 text-center text-sm text-muted">No playlists yet.</div>
              ) : playlists.map(p => (
                <button key={p.id} type="button" onClick={() => loadPlaylist(p)}
                  className="flex w-full items-center justify-between gap-2 border-b border-separator-strong px-3 py-2 text-left hover:bg-ink-soft">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-semibold text-ink">{p.name}</span>
                    {p.synced && <MetaChip accent>synced</MetaChip>}
                  </span>
                  <span className="mono-num shrink-0 text-xs text-muted">{p.songCount}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className={cn(
          'fixed bottom-6 left-1/2 z-50 -translate-x-1/2 border px-4 py-2 text-sm font-semibold shadow-lg',
          toast.kind === 'ok' ? 'border-ink bg-ink text-bg' : 'border-vermilion bg-vermilion text-white',
        )}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

function KnobSwitch({ icon, label, hint, on, onToggle }: { icon: React.ReactNode; label: string; hint: string; on: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} className="flex items-center justify-between gap-2 text-left">
      <span className="flex items-center gap-2">
        <span className={cn('flex size-6 items-center justify-center border', on ? 'border-vermilion text-vermilion' : 'border-separator-strong text-muted')}>{icon}</span>
        <span>
          <span className="block text-sm font-semibold text-ink">{label}</span>
          <span className="block text-[11px] text-muted">{hint}</span>
        </span>
      </span>
      <span className={cn('relative h-5 w-9 shrink-0 border transition', on ? 'border-vermilion bg-vermilion/20' : 'border-separator-strong bg-transparent')}>
        <span className={cn('absolute top-0.5 size-3.5 transition-all', on ? 'left-[18px] bg-vermilion' : 'left-0.5 bg-muted')} />
      </span>
    </button>
  );
}

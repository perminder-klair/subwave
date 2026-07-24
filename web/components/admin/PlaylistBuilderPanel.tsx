'use client';

/* Magical Playlist Builder — the "studio console" screen.

   Two panes: a fixed RECIPE rail (vibe prompt + seeds + tuning → Generate /
   Regenerate / More) and a RESULT pane that is a real state machine — result,
   empty, generating, no-match, error — with an energy-over-running-order bar
   graph, AI-curated vs rules-based-fallback attribution, and a save modal
   (overwrite vs create + keep-in-sync). Saves land in Navidrome via the
   existing /playlists routes, so the set immediately feeds the Shows picker. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus, X, Search, ArrowUp, ArrowDown, ChevronRight, ChevronUp, ChevronDown,
  GripVertical, RefreshCw, Trash2, FolderOpen, FilePlus2, Save,
} from 'lucide-react';
import { useAdminAuth } from '../../lib/adminAuth';
import { useDynamicStyle } from '../../hooks/useDynamicStyle';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';
import { V3Alert } from '../ui/alert';
import { ScrollArea } from '../ui/scroll-area';
import { cn } from '../../lib/cn';

const API = (process.env.NEXT_PUBLIC_API_URL as string | undefined) || '/api';

// Mirrors SHOW_MOODS in controller/src/settings.ts (stable vocab).
const MOODS = [
  'energetic', 'calm', 'reflective', 'celebratory', 'romantic', 'spiritual',
  'focus', 'workout', 'driving', 'cooking', 'rainy', 'sunny', 'night', 'morning',
  'evening', 'festival', 'cultural',
];
const ENERGIES = ['low', 'medium', 'high'];
type ArcShape = 'flat' | 'build' | 'peak-then-cool' | 'wind-down';
const ARCS: { id: ArcShape; label: string; hint: string }[] = [
  { id: 'flat', label: 'Steady', hint: 'even energy throughout' },
  { id: 'build', label: 'Build', hint: 'calm → energetic' },
  { id: 'peak-then-cool', label: 'Peak', hint: 'rise, then cool down' },
  { id: 'wind-down', label: 'Wind down', hint: 'high → mellow' },
];
// Band domains. Anchors parked at the extremes mean "unbounded" on that end.
const LEN_MAX = 600;                              // track length: 0 → 10:00, 15s notches
const LEN_STEP = 15;
const BPM_MIN = 60;                               // tempo: 60 → 200 bpm, 5 bpm notches
const BPM_MAX = 200;
const BPM_STEP = 5;
const YEAR_MIN = 1950;                            // release year: 1950 → current year
const YEAR_MAX = new Date().getFullYear();

// Bar palette for the energy graph — theme-aware mixes rather than the mock's
// light-theme hexes, so dark mode keeps the same low/med/high contrast. Raw
// values feed SVG `fill` attributes; the class twins style HTML swatches.
const EN_LOW = 'color-mix(in oklab, var(--ink) 22%, var(--bg))';
const EN_MED = 'color-mix(in oklab, var(--ink) 80%, var(--bg))';
const EN_HIGH = 'var(--accent)';
const EN_LOW_BG = 'bg-[color-mix(in_oklab,var(--ink)_22%,var(--bg))]';
const EN_MED_BG = 'bg-[color-mix(in_oklab,var(--ink)_80%,var(--bg))]';
const EN_HIGH_BG = 'bg-[var(--accent)]';

type View = 'result' | 'empty' | 'generating' | 'nomatch' | 'error';
type GenMode = 'fresh' | 'regenerate' | 'more';

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
  genre?: string | null;
  energy?: string | null;
  moods?: string[];
}

function rowToDraft(s: RawTrackRow): DraftTrack {
  return {
    id: s.id,
    title: s.title || '',
    artist: s.artist || '',
    album: s.album,
    durationSec: s.durationSec ?? s.duration ?? 0,
    year: s.year,
    genre: s.genre ?? null,
    energy: s.energy ?? null,
    moods: s.moods || [],
    instrumental: null,
  };
}

function fmtDur(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${m}:${String(ss).padStart(2, '0')}`;
}
function fmtRun(total: number): string {
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function relTime(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
const energyPct = (e?: string | null): number => (e === 'low' ? 34 : e === 'high' ? 92 : 64);
const energyColor = (e?: string | null): string => (e === 'low' ? EN_LOW : e === 'high' ? EN_HIGH : EN_MED);
const energyBgClass = (e?: string | null): string => (e === 'low' ? EN_LOW_BG : e === 'high' ? EN_HIGH_BG : EN_MED_BG);
// Untagged tracks read '—', not a fake 'med' — an untagged library shouldn't
// masquerade as uniformly mid-energy (the bars go translucent for the same reason).
const energyLabel = (e?: string | null): string =>
  e === 'low' || e === 'medium' || e === 'high' ? (e === 'medium' ? 'med' : e) : '—';
const energyKnown = (e?: string | null): boolean => e === 'low' || e === 'medium' || e === 'high';

// ── shared micro-pieces (design idiom: mono eyebrows, sharp toggles) ─────────

function Eyeb({ children, muted, className }: { children: React.ReactNode; muted?: boolean; className?: string }) {
  return (
    <span className={cn('font-mono text-[10px] font-bold tracking-[0.16em] uppercase', muted ? 'text-muted' : 'text-ink', className)}>
      {children}
    </span>
  );
}

function Tog({ on, onClick, title, children }: { on: boolean; onClick: () => void; title?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'border px-[11px] py-1.5 font-mono text-[11px] font-semibold tracking-[0.03em] transition',
        on ? 'border-ink bg-ink text-bg' : 'border-separator-strong bg-bg text-ink hover:border-ink',
      )}
    >
      {children}
    </button>
  );
}

function IconBtn({ onClick, disabled, title, className, children }: {
  onClick?: () => void; disabled?: boolean; title?: string; className?: string; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'grid size-[30px] place-items-center border border-transparent text-muted transition',
        'hover:border-separator-soft hover:bg-ink-soft hover:text-ink disabled:opacity-25 disabled:hover:border-transparent disabled:hover:bg-transparent',
        className,
      )}
    >
      {children}
    </button>
  );
}

function Chip({ accent, onRemove, children }: { accent?: boolean; onRemove?: () => void; children: React.ReactNode }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 border bg-bg px-[7px] py-[3px] font-mono text-[10px] font-semibold tracking-[0.06em] uppercase',
      accent ? 'border-[var(--accent)] text-vermilion' : 'border-separator-strong text-ink',
    )}>
      {children}
      {onRemove && (
        <button type="button" onClick={onRemove} className="cursor-pointer text-muted hover:text-ink" title="remove">
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}

// ── Dual-anchor range — two overlaid native sliders sharing one track, with an
// accent band between the anchors. No dependency; thumbs stay keyboardable.
function DualRange({ min, max, step, lo, hi, disabled, onLo, onHi, loLabel, hiLabel }: {
  min: number; max: number; step: number; lo: number; hi: number; disabled?: boolean;
  onLo: (v: number) => void; onHi: (v: number) => void; loLabel: string; hiLabel: string;
}) {
  const bandRef = useRef<HTMLDivElement>(null);
  const span = max - min || 1;
  const loPct = ((lo - min) / span) * 100;
  const hiPct = ((hi - min) / span) * 100;
  useDynamicStyle(bandRef, { left: `${loPct}%`, width: `${Math.max(0, hiPct - loPct)}%` });
  const thumb =
    'pointer-events-none absolute inset-0 h-5 w-full appearance-none bg-transparent outline-none ' +
    '[&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:pointer-events-auto ' +
    '[&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none ' +
    '[&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-ink [&::-webkit-slider-thumb]:bg-[var(--accent)] ' +
    '[&::-moz-range-track]:bg-transparent [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:size-3.5 ' +
    '[&::-moz-range-thumb]:rounded-none [&::-moz-range-thumb]:border [&::-moz-range-thumb]:border-ink [&::-moz-range-thumb]:bg-[var(--accent)]';
  return (
    <div className={cn('relative h-5', disabled && 'opacity-40')}>
      <div className="absolute top-1/2 right-0 left-0 h-[3px] -translate-y-1/2 bg-separator-strong" />
      <div ref={bandRef} className="absolute top-1/2 h-[3px] -translate-y-1/2 bg-[var(--accent)]" />
      <input
        type="range" min={min} max={max} step={step} value={lo} disabled={disabled}
        onChange={e => onLo(Math.min(+e.target.value, hi))}
        aria-label={loLabel}
        // When both anchors crowd the right end, lift the lo thumb so it stays grabbable.
        className={cn(thumb, lo > max - step * 4 && 'z-10')}
      />
      <input
        type="range" min={min} max={max} step={step} value={hi} disabled={disabled}
        onChange={e => onHi(Math.max(+e.target.value, lo))}
        aria-label={hiLabel}
        className={thumb}
      />
    </div>
  );
}

function SwitchRow({ label, hint, on, onToggle, mutedLabel }: {
  label: string; hint: string; on: boolean; onToggle: (v: boolean) => void; mutedLabel?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <div className={cn('text-[13px] font-semibold', mutedLabel && 'text-muted')}>{label}</div>
        <div className="font-mono text-[10px] text-muted">{hint}</div>
      </div>
      <Switch checked={on} onCheckedChange={onToggle} aria-label={label} />
    </div>
  );
}

// ── Energy tape-strip — slim per-track bars + dashed target arc. Collapsible,
// and every bar is a jump-link: click scrolls its track row into view. ────────

function EnergyGraph({ tracks, arc, open, onToggle, onBarClick }: {
  tracks: DraftTrack[]; arc: ArcShape; open: boolean; onToggle: () => void; onBarClick: (i: number) => void;
}) {
  const n = tracks.length;
  const arcLabel = ARCS.find(a => a.id === arc)?.label || 'Steady';
  const noneTagged = useMemo(() => tracks.every(t => !energyKnown(t.energy)), [tracks]);
  const targetPts = useMemo(() => {
    const f = (p: number): number => {
      if (arc === 'build') return p;
      if (arc === 'wind-down') return 1 - p;
      if (arc === 'peak-then-cool') return p < 0.6 ? p / 0.6 : 1 - ((p - 0.6) / 0.4) * 0.65;
      return 0.5;
    };
    return tracks.map((_, i) => {
      const p = n > 1 ? i / (n - 1) : 0;
      return `${(i + 0.5).toFixed(2)},${(82 - f(p) * 64).toFixed(2)}`;
    }).join(' ');
  }, [tracks, arc, n]);
  if (n === 0) return null;
  return (
    <div className="flex-none border-b border-separator-soft px-4 sm:px-6">
      <button
        type="button"
        onClick={onToggle}
        className="flex h-7 w-full items-center justify-between gap-3 text-left"
        title={open ? 'collapse the energy strip' : 'expand the energy strip'}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <Eyeb muted>Energy</Eyeb>
          {noneTagged && open && (
            <span className="truncate font-mono text-[9px] text-muted/80">
              untagged — run the library tagger (Library → Tag) to chart the real arc
            </span>
          )}
        </span>
        <span className="flex flex-none items-center gap-3 font-mono text-[9px] text-muted">
          {open && !noneTagged && (
            <>
              <span className="hidden items-center gap-1 sm:flex"><span className={cn('inline-block size-2', EN_LOW_BG)} />low</span>
              <span className="hidden items-center gap-1 sm:flex"><span className={cn('inline-block size-2', EN_MED_BG)} />med</span>
              <span className="hidden items-center gap-1 sm:flex"><span className={cn('inline-block size-2', EN_HIGH_BG)} />high</span>
            </>
          )}
          {open && (
            <span className="flex items-center gap-1">
              <svg width="14" height="8" aria-hidden><line x1="0" y1="4" x2="14" y2="4" stroke="var(--ink)" strokeWidth="1.5" strokeDasharray="3 2" /></svg>
              target · {arcLabel}
            </span>
          )}
          {open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </span>
      </button>
      {open && (
        <div className="relative h-11 pb-1.5">
          <svg viewBox={`0 0 ${n} 100`} preserveAspectRatio="none" className="block h-full w-full">
            {tracks.map((t, i) => {
              const pct = energyPct(t.energy);
              return (
                <rect
                  key={`${t.id}-${i}`}
                  x={(i + 0.1).toFixed(3)}
                  y={(100 - pct).toFixed(2)}
                  width={0.8}
                  height={pct}
                  fill={energyColor(t.energy)}
                  onClick={() => onBarClick(i)}
                  className={cn('cursor-pointer hover:opacity-70', !energyKnown(t.energy) && 'opacity-35')}
                >
                  <title>{i + 1}. {t.title} — {t.artist}</title>
                </rect>
              );
            })}
            <polyline
              points={targetPts}
              fill="none"
              stroke="var(--ink)"
              strokeWidth="1.5"
              strokeDasharray="3 2"
              vectorEffect="non-scaling-stroke"
              className="pointer-events-none opacity-60"
            />
          </svg>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export default function PlaylistBuilderPanel() {
  const { adminFetch } = useAdminAuth();

  // Recipe state
  const [prompt, setPrompt] = useState('');
  const [seeds, setSeeds] = useState<SeedChip[]>([]);
  const [seedArtist, setSeedArtist] = useState('');
  const [moods, setMoods] = useState<string[]>([]);
  const [genres, setGenres] = useState<string[]>([]);
  const [genreInput, setGenreInput] = useState('');
  const [energies, setEnergies] = useState<string[]>([]);
  const [yearFrom, setYearFrom] = useState(YEAR_MIN);
  const [yearTo, setYearTo] = useState(YEAR_MAX);
  const [bpmOn, setBpmOn] = useState(false);
  const [minBpm, setMinBpm] = useState(BPM_MIN);
  const [maxBpm, setMaxBpm] = useState(BPM_MAX);
  const [artists, setArtists] = useState<string[]>([]);
  const [arc, setArc] = useState<ArcShape>('flat');
  const [count, setCount] = useState(25);
  const [artistSpacing, setArtistSpacing] = useState(2);
  const [capOn, setCapOn] = useState(false);
  // Track-length band anchors (seconds). min at 0 = no floor; max at LEN_MAX = no cap.
  const [minSec, setMinSec] = useState(0);
  const [maxSec, setMaxSec] = useState(LEN_MAX);
  const [excludeRecent, setExcludeRecent] = useState(false);
  const [instrumentalOnly, setInstrumentalOnly] = useState(false);
  const [recentlyAdded, setRecentlyAdded] = useState(false);

  // Result state
  const [view, setView] = useState<View>('empty');
  const [name, setName] = useState('');
  const [description, setDescription] = useState<string | null>(null);
  const [tracks, setTracks] = useState<DraftTrack[]>([]);
  const [reasons, setReasons] = useState<string[]>([]);
  const [usedFallback, setUsedFallback] = useState(false);
  const [poolSize, setPoolSize] = useState<number | null>(null);
  // What the last generation op actually did — frozen so manual edits to the
  // deck don't rewrite history in the "chose N from M in pool" line. `poolVerb`
  // keeps 'more' honest: its pool excludes the current deck, so the line
  // describes that op ("added 15 from 23 in pool"), never a mixed total.
  const [chosenCount, setChosenCount] = useState(0);
  const [poolVerb, setPoolVerb] = useState<'chose' | 'added'>('chose');
  const [errorMsg, setErrorMsg] = useState('');
  const [existingId, setExistingId] = useState<string | undefined>();
  const [keepInSync, setKeepInSync] = useState(false);
  const [syncInfo, setSyncInfo] = useState<{ lastSyncedAt: string | null } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [saving, setSaving] = useState(false);

  // Modals + toast
  const [modal, setModal] = useState<null | 'open' | 'save'>(null);
  const [saveName, setSaveName] = useState('');
  const [saveMode, setSaveMode] = useState<'overwrite' | 'create'>('create');
  const [saveSync, setSaveSync] = useState(false);
  const [playlists, setPlaylists] = useState<PlaylistSummary[] | null>(null);
  const [playlistQuery, setPlaylistQuery] = useState('');
  // Two-click armed delete in the Open modal (the only delete surface since
  // the old Library Playlists tab became a pointer here).
  const [armedDelete, setArmedDelete] = useState<string | null>(null);

  // Deck chrome state — the list is the star, everything above it collapses.
  const [graphOpen, setGraphOpen] = useState(true);
  const [caveatsOpen, setCaveatsOpen] = useState(false);
  const [hotRow, setHotRow] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const hotTimer = useRef<number | null>(null);
  const [toast, setToast] = useState('');

  // Search (seeds + manual add)
  const [seedQuery, setSeedQuery] = useState('');
  const [seedResults, setSeedResults] = useState<RawTrackRow[] | null>(null);
  const [addQuery, setAddQuery] = useState('');
  const [addResults, setAddResults] = useState<RawTrackRow[] | null>(null);
  const [artistQuery, setArtistQuery] = useState('');
  const [artistResults, setArtistResults] = useState<string[] | null>(null);
  const [genreList, setGenreList] = useState<{ value: string; songCount: number }[] | null>(null);

  const dragIndex = useRef<number | null>(null);
  const toastTimer = useRef<number | null>(null);
  const lastMode = useRef<GenMode>('fresh');
  const generatingRef = useRef(false);

  // Fill the viewport: measure where the frame actually starts (header height,
  // Navidrome banner, breadcrumb wrap all vary) and stretch it to the bottom,
  // leaving the shell's 24px page gutter. The class-based calc() is only the
  // first-paint estimate. (The sidebar is a fixed full-height rail now, so it
  // no longer dictates a minimum frame height the way the old nav column did.)
  const frameRef = useRef<HTMLDivElement>(null);
  const [frameH, setFrameH] = useState<number | null>(null);
  useEffect(() => {
    const measure = () => {
      const el = frameRef.current;
      if (!el) return;
      if (window.innerWidth < 1024) { setFrameH(null); return; }
      const top = el.getBoundingClientRect().top + window.scrollY;
      const fit = window.innerHeight - top - 24;
      setFrameH(Math.max(480, Math.round(fit)));
    };
    measure();
    window.addEventListener('resize', measure);
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    return () => { window.removeEventListener('resize', measure); ro.disconnect(); };
  }, []);
  useDynamicStyle(frameRef, { height: frameH ? `${frameH}px` : null });

  const flash = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 4200);
  }, []);

  // Escape closes whichever modal is up. Document-level rather than on the
  // dialog markup, so it fires wherever focus happens to be.
  useEffect(() => {
    if (!modal) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setModal(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modal]);

  // Move focus into the dialog when it opens and hand it back to whatever
  // opened it on close. Without this the modal is only reachable by tabbing
  // through the page behind it, and closing leaves focus on <body>.
  const modalPanelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!modal) return;
    const restoreTo = document.activeElement as HTMLElement | null;
    modalPanelRef.current?.focus();
    return () => restoreTo?.focus?.();
  }, [modal]);

  // Energy-bar → track-row jump: center the row inside the LIST's own scroll
  // context (scrollIntoView would drag the page along) and flare it briefly.
  const jumpToRow = useCallback((i: number) => {
    // ScrollArea scrolls its internal radix viewport, not the Root that listRef
    // points at — resolve it so scrollTop/scrollTo act on the right element.
    const root = listRef.current;
    const list = root?.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]') ?? root;
    const row = list?.querySelector<HTMLElement>(`[data-row="${i}"]`);
    if (!list || !row) return;
    if (list.scrollHeight > list.clientHeight) {
      const delta = row.getBoundingClientRect().top - list.getBoundingClientRect().top;
      list.scrollTo({ top: list.scrollTop + delta - list.clientHeight / 2 + row.clientHeight / 2, behavior: 'smooth' });
    } else {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' }); // mobile: list flows with the page
    }
    setHotRow(i);
    if (hotTimer.current) window.clearTimeout(hotTimer.current);
    hotTimer.current = window.setTimeout(() => setHotRow(null), 1600);
  }, []);

  const totalSec = useMemo(() => tracks.reduce((s, t) => s + (t.durationSec || 0), 0), [tracks]);
  const dupeIds = useMemo(() => {
    const seen = new Set<string>();
    const dup = new Set<string>();
    for (const t of tracks) { if (seen.has(t.id)) dup.add(t.id); seen.add(t.id); }
    return dup;
  }, [tracks]);

  const buildBody = useCallback((excludeTrackIds: string[] = []) => ({
    prompt: prompt.trim() || undefined,
    seedTrackIds: seeds.map(s => s.id),
    seedArtist: seedArtist || undefined,
    knobs: {
      targetCount: count,
      energyArc: arc,
      moods,
      genres,
      energies,
      artists,
      eras: yearFrom > YEAR_MIN || yearTo < YEAR_MAX
        ? [{ fromYear: yearFrom > YEAR_MIN ? yearFrom : null, toYear: yearTo < YEAR_MAX ? yearTo : null }]
        : [],
      artistSpacing,
      excludeRecentlyPlayed: excludeRecent,
      instrumentalOnly,
      minTrackSeconds: capOn && minSec > 0 ? minSec : undefined,
      maxTrackSeconds: capOn && maxSec < LEN_MAX ? maxSec : undefined,
      minBpm: bpmOn && minBpm > BPM_MIN ? minBpm : undefined,
      maxBpm: bpmOn && maxBpm < BPM_MAX ? maxBpm : undefined,
    },
    sources: { recentlyAdded },
    excludeTrackIds,
  }), [prompt, seeds, seedArtist, count, arc, moods, genres, energies, artists, yearFrom, yearTo, artistSpacing, excludeRecent, instrumentalOnly, capOn, minSec, maxSec, bpmOn, minBpm, maxBpm, recentlyAdded]);

  const hasIntent = Boolean(
    prompt.trim() || seeds.length || seedArtist || recentlyAdded || moods.length ||
    genres.length || artists.length || energies.length || instrumentalOnly ||
    yearFrom > YEAR_MIN || yearTo < YEAR_MAX ||
    (bpmOn && (minBpm > BPM_MIN || maxBpm < BPM_MAX)),
  );

  const generating = view === 'generating';

  const generate = useCallback(async (mode: GenMode) => {
    if (generatingRef.current) return;
    generatingRef.current = true;
    lastMode.current = mode;
    const exclude = mode === 'fresh' ? [] : tracks.map(t => t.id);
    setView('generating');
    try {
      const r = await adminFetch('/playlists/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody(exclude)),
      });
      const j = await r.json();
      if (!r.ok) {
        setErrorMsg(j.error || 'generation failed');
        setView(mode === 'more' && tracks.length ? 'result' : 'error');
        if (mode === 'more' && tracks.length) flash(j.error || 'could not fetch more');
        return;
      }
      const got: DraftTrack[] = j.tracks || [];
      if (!got.length) {
        setView(mode === 'more' && tracks.length ? 'result' : 'nomatch');
        if (mode === 'more' && tracks.length) flash('nothing new matched — loosen the filters');
        return;
      }
      setReasons(j.reasons || []);
      setUsedFallback(!!j.usedFallback);
      setCaveatsOpen(!!j.usedFallback); // fallback matters — open the detail unprompted
      setPoolSize(typeof j.poolSize === 'number' ? j.poolSize : null);
      setChosenCount(got.length);
      setPoolVerb(mode === 'more' ? 'added' : 'chose');
      if (mode === 'more') {
        setTracks(prev => [...prev, ...got]);
        flash(`added ${got.length} more track${got.length === 1 ? '' : 's'}`);
      } else {
        setTracks(got);
        if (j.name && (!name.trim() || mode === 'fresh')) setName(j.name);
        setDescription(j.description || null);
        flash(`${got.length} tracks generated`);
      }
      setView('result');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'generation failed');
      setView(mode === 'more' && tracks.length ? 'result' : 'error');
    } finally {
      generatingRef.current = false;
    }
  }, [tracks, adminFetch, buildBody, flash, name]);

  // Seed search (debounced; `stale` guards a slow response from clobbering a
  // newer query's results)
  useEffect(() => {
    const q = seedQuery.trim();
    if (q.length < 2) { setSeedResults(null); return; }
    let stale = false;
    const h = window.setTimeout(async () => {
      try {
        const r = await adminFetch(`/dj/search?q=${encodeURIComponent(q)}&limit=8`);
        const j = await r.json();
        if (!stale) setSeedResults(j.results || j.songs || j.tracks || []);
      } catch { if (!stale) setSeedResults([]); }
    }, 250);
    return () => { stale = true; window.clearTimeout(h); };
  }, [seedQuery, adminFetch]);

  // Manual add search (debounced, same staleness guard)
  useEffect(() => {
    const q = addQuery.trim();
    if (q.length < 2) { setAddResults(null); return; }
    let stale = false;
    const h = window.setTimeout(async () => {
      try {
        const r = await adminFetch(`/dj/search?q=${encodeURIComponent(q)}&limit=10`);
        const j = await r.json();
        if (!stale) setAddResults(j.results || j.songs || j.tracks || []);
      } catch { if (!stale) setAddResults([]); }
    }, 250);
    return () => { stale = true; window.clearTimeout(h); };
  }, [addQuery, adminFetch]);

  // Genre vocabulary — fetched once on first focus; suggestions filter locally.
  const loadGenres = useCallback(async () => {
    if (genreList) return;
    try {
      const r = await adminFetch('/library/genres');
      const j = await r.json();
      setGenreList(j.genres || []);
    } catch { setGenreList([]); }
  }, [adminFetch, genreList]);

  const genreSuggestions = useMemo(() => {
    if (!genreList) return null;
    const q = genreInput.trim().toLowerCase();
    if (!q) return null;
    const chosen = new Set(genres.map(g => g.toLowerCase()));
    const hits = genreList.filter(g => g.value.toLowerCase().includes(q) && !chosen.has(g.value.toLowerCase()));
    return hits.slice(0, 8);
  }, [genreList, genreInput, genres]);

  // Artist-filter search (debounced) — suggests distinct artist credits.
  useEffect(() => {
    const q = artistQuery.trim();
    if (q.length < 2) { setArtistResults(null); return; }
    let stale = false;
    const h = window.setTimeout(async () => {
      try {
        const r = await adminFetch(`/dj/search?q=${encodeURIComponent(q)}&limit=20`);
        const j = await r.json();
        const seen = new Set(artists.map(a => a.toLowerCase()));
        const names: string[] = [];
        for (const row of (j.results || []) as RawTrackRow[]) {
          const a = (row.artist || '').trim();
          if (a && !seen.has(a.toLowerCase())) { seen.add(a.toLowerCase()); names.push(a); }
          if (names.length >= 6) break;
        }
        if (!stale) setArtistResults(names);
      } catch { if (!stale) setArtistResults([]); }
    }, 250);
    return () => { stale = true; window.clearTimeout(h); };
  }, [artistQuery, adminFetch, artists]);

  // Distinct artists in the seed results — the "seed the artist" rows.
  const seedArtists = useMemo(() => {
    if (!seedResults) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of seedResults) {
      const a = (r.artist || '').trim();
      if (a && !seen.has(a.toLowerCase())) { seen.add(a.toLowerCase()); out.push(a); }
      if (out.length >= 2) break;
    }
    return out;
  }, [seedResults]);

  const toggle = (list: string[], set: (v: string[]) => void, v: string) =>
    set(list.includes(v) ? list.filter(x => x !== v) : [...list, v]);

  const addGenre = () => {
    const g = genreInput.trim().replace(/,+$/, '');
    if (g && !genres.some(x => x.toLowerCase() === g.toLowerCase())) setGenres([...genres, g]);
    setGenreInput('');
  };

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
  const addTrack = (t: RawTrackRow) => {
    setTracks(prev => [...prev, rowToDraft(t)]);
    setAddQuery('');
    setAddResults(null);
  };

  const doNew = useCallback(() => {
    setTracks([]); setName(''); setDescription(null); setExistingId(undefined);
    setReasons([]); setUsedFallback(false); setPoolSize(null); setChosenCount(0);
    setErrorMsg(''); setKeepInSync(false); setSyncInfo(null); setView('empty');
  }, []);

  const openBrowse = useCallback(async () => {
    setModal('open');
    setPlaylistQuery('');
    setPlaylists(null);
    setArmedDelete(null);
    try {
      const r = await adminFetch('/playlists');
      const j = await r.json();
      setPlaylists(j.playlists || []);
    } catch { setPlaylists([]); }
  }, [adminFetch]);

  const deletePlaylist = useCallback(async (p: PlaylistSummary) => {
    try {
      const r = await adminFetch(`/playlists/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { flash(j.error || 'delete failed'); return; }
      setPlaylists(prev => (prev ? prev.filter(x => x.id !== p.id) : prev));
      // The deck keeps the tracks as an unsaved draft; only the server tie is gone.
      if (existingId === p.id) { setExistingId(undefined); setKeepInSync(false); setSyncInfo(null); }
      flash(`Deleted “${p.name}” from the music server`);
    } catch (err) {
      flash(err instanceof Error ? err.message : 'delete failed');
    } finally {
      setArmedDelete(null);
    }
  }, [adminFetch, existingId, flash]);

  const loadPlaylist = useCallback(async (p: PlaylistSummary) => {
    try {
      const r = await adminFetch(`/playlists/${encodeURIComponent(p.id)}`);
      const j = await r.json();
      setTracks((j.entries || []).map(rowToDraft));
      setName(p.name);
      setDescription(null);
      setExistingId(p.id);
      setKeepInSync(!!p.synced);
      setSyncInfo(p.synced ? { lastSyncedAt: p.lastSyncedAt ?? null } : null);
      setReasons([]); setUsedFallback(false); setPoolSize(null);
      setModal(null);
      setView('result');
      flash(`Loaded “${p.name}” from the music server`);
    } catch { flash('could not load playlist'); }
  }, [adminFetch, flash]);

  const openSave = useCallback(() => {
    if (!tracks.length) { flash('nothing to save'); return; }
    setSaveName(name.trim() || '');
    setSaveMode(existingId ? 'overwrite' : 'create');
    setSaveSync(keepInSync);
    setModal('save');
  }, [tracks.length, name, existingId, keepInSync, flash]);

  const doSave = useCallback(async () => {
    const finalName = saveName.trim();
    if (!finalName) { flash('name the playlist first'); return; }
    setSaving(true);
    try {
      const overwrite = saveMode === 'overwrite' && existingId;
      const r = await adminFetch('/playlists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: finalName,
          songIds: tracks.map(t => t.id),
          playlistId: overwrite ? existingId : undefined,
          keepInSync: saveSync,
          recipe: saveSync ? buildBody() : undefined,
        }),
      });
      const j = await r.json();
      if (!r.ok) { flash(j.error || 'save failed'); return; }
      const id = j.playlist?.id || (overwrite ? existingId : undefined);
      setName(finalName);
      setExistingId(id);
      setKeepInSync(saveSync);
      setSyncInfo(saveSync ? (syncInfo ?? { lastSyncedAt: null }) : null);
      setModal(null);
      flash(`Saved “${finalName}” to Navidrome${saveSync ? ' · sync on' : ''}`);
    } catch (err) {
      flash(err instanceof Error ? err.message : 'save failed');
    } finally {
      setSaving(false);
    }
  }, [saveName, saveMode, saveSync, existingId, tracks, syncInfo, buildBody, adminFetch, flash]);

  const syncNow = useCallback(async () => {
    if (!existingId || syncing) return;
    setSyncing(true);
    try {
      const r = await adminFetch(`/playlists/${encodeURIComponent(existingId)}/sync`, { method: 'POST' });
      const j = await r.json();
      if (!r.ok) { flash(j.error || 'sync failed'); return; }
      setSyncInfo({ lastSyncedAt: new Date().toISOString() });
      flash(j.added ? `Sync complete · added ${j.added} new track${j.added === 1 ? '' : 's'}` : 'Sync complete · nothing new');
      if (j.added) {
        const pr = await adminFetch(`/playlists/${encodeURIComponent(existingId)}`);
        const pj = await pr.json();
        if (pr.ok) setTracks((pj.entries || []).map(rowToDraft));
      }
    } catch (err) {
      flash(err instanceof Error ? err.message : 'sync failed');
    } finally {
      setSyncing(false);
    }
  }, [existingId, syncing, adminFetch, flash]);

  const showResult = view === 'result' && tracks.length > 0;
  const showEmpty = view === 'empty' || (view === 'result' && tracks.length === 0);
  const saveDisabled = !showResult || saving;
  const filteredPlaylists = useMemo(() => {
    if (!playlists) return null;
    const q = playlistQuery.trim().toLowerCase();
    return q ? playlists.filter(p => p.name.toLowerCase().includes(q)) : playlists;
  }, [playlists, playlistQuery]);

  const searchInputClass =
    'w-full border border-separator-strong bg-field px-[11px] py-[9px] text-sm text-ink outline-none placeholder:text-muted/60 focus:border-ink';

  return (
    <div className="min-w-0">
      {/* Open canvas — no box. One hairline divides recipe from deck; the page
          itself is the surface and the track list takes every spare pixel. */}
      <div ref={frameRef} className="flex min-w-0 flex-col lg:h-[calc(100dvh-146px)] lg:min-h-[480px] lg:flex-row">

        {/* ============ LEFT: RECIPE ============ */}
        {/* The recipe rail is a lifted controls panel (--card-bg, matching the
            other admin panels) so it reads distinct from the page/deck; the deck
            on the right stays the open canvas. */}
        <aside className="flex min-h-0 flex-none flex-col border-b border-ink bg-[var(--card-bg)] lg:w-[380px] lg:border-r lg:border-b-0">
          <ScrollArea className="min-h-0 flex-1">
            <div className="px-5 pt-4 pb-[26px]">

            <div className="mb-1.5 font-mono text-[10px] font-bold tracking-[0.2em] text-muted uppercase">Recipe</div>
            <h1 className="mb-[18px] font-display text-[22px] font-bold tracking-[-0.01em]">
              Describe the set
            </h1>

            {/* vibe */}
            <div className="mb-[22px]">
              <div className="mb-[7px]"><Eyeb>Vibe</Eyeb></div>
              <textarea
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                rows={3}
                placeholder={'“rainy sunday jazz that warms up halfway through”'}
                aria-label="Vibe"
                className={cn(searchInputClass, 'resize-none leading-[1.45]')}
              />
            </div>

            {/* seeds */}
            <div className="mb-[22px]">
              <div className="mb-[7px] flex items-center justify-between">
                <Eyeb>Seeds</Eyeb>
                <span className="font-mono text-[10px] text-muted">optional</span>
              </div>
              <div className="relative">
                <input
                  value={seedQuery}
                  onChange={e => setSeedQuery(e.target.value)}
                  placeholder="Search a track or artist to anchor on…"
                  aria-label="Search seeds"
                  className={searchInputClass}
                />
                {seedResults && (seedResults.length > 0 || seedArtists.length > 0) && (
                  <div className="absolute z-20 max-h-64 w-full overflow-auto border border-t-0 border-ink bg-bg">
                    {seedResults.map(s => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => {
                          if (!seeds.some(x => x.id === s.id)) setSeeds([...seeds, { id: s.id, title: s.title || '', artist: s.artist || '' }]);
                          setSeedQuery(''); setSeedResults(null);
                        }}
                        className="flex w-full items-center justify-between gap-2 border-b border-separator-soft px-[11px] py-2 text-left hover:bg-ink-soft"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-[13px]">{s.title}</span>
                          <span className="block truncate font-mono text-[10px] text-muted">{s.artist}</span>
                        </span>
                        <Plus className="size-3.5 flex-none text-muted" />
                      </button>
                    ))}
                    {seedArtists.map(a => (
                      <button
                        key={a}
                        type="button"
                        onClick={() => { setSeedArtist(a); setSeedQuery(''); setSeedResults(null); }}
                        className="flex w-full items-center justify-between gap-2 border-b border-separator-soft px-[11px] py-2 text-left last:border-b-0 hover:bg-ink-soft"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-[13px] text-vermilion">Artist · {a}</span>
                          <span className="block font-mono text-[10px] text-muted">seed everything similar to this artist</span>
                        </span>
                        <Plus className="size-3.5 flex-none text-vermilion" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {(seeds.length > 0 || seedArtist) && (
                <div className="mt-2.5 flex flex-wrap gap-[7px]">
                  {seeds.map(s => (
                    <Chip key={s.id} onRemove={() => setSeeds(seeds.filter(x => x.id !== s.id))}>
                      {s.title} · {s.artist}
                    </Chip>
                  ))}
                  {seedArtist && (
                    <Chip accent onRemove={() => setSeedArtist('')}>Artist · {seedArtist}</Chip>
                  )}
                </div>
              )}
            </div>

            <div className="mb-5 h-px bg-separator-strong" />

            {/* target length */}
            <div className="mb-5">
              <div className="mb-[9px] flex items-center justify-between">
                <Eyeb>Target length</Eyeb>
                <span className="font-mono text-[11px] font-bold text-vermilion">{count} tracks</span>
              </div>
              <input type="range" min={5} max={60} value={count} onChange={e => setCount(+e.target.value)} aria-label="Target length in tracks" className="w-full accent-[var(--accent)]" />
              <div className="mt-[5px] flex justify-between font-mono text-[9px] text-muted"><span>5</span><span>60</span></div>
            </div>

            {/* artist spacing */}
            <div className="mb-5">
              <div className="mb-[9px] flex items-center justify-between">
                <Eyeb>Artist spacing</Eyeb>
                <span className="font-mono text-[11px] text-muted">{artistSpacing ? `min ${artistSpacing} apart` : 'off'}</span>
              </div>
              <input type="range" min={0} max={5} value={artistSpacing} onChange={e => setArtistSpacing(+e.target.value)} aria-label="Artist spacing" className="w-full accent-[var(--accent)]" />
            </div>

            {/* track-length band — min/max anchors on one track */}
            <div className="mb-5">
              <div className="mb-[9px] flex items-center justify-between">
                <Eyeb muted={!capOn}>Track length</Eyeb>
                <div className="flex items-center gap-2.5">
                  {capOn && (
                    <span className="font-mono text-[11px] font-bold text-vermilion">
                      {minSec > 0 && maxSec < LEN_MAX ? `${fmtDur(minSec)} – ${fmtDur(maxSec)}`
                        : minSec > 0 ? `≥ ${fmtDur(minSec)}`
                          : maxSec < LEN_MAX ? `≤ ${fmtDur(maxSec)}`
                            : 'any'}
                    </span>
                  )}
                  <Switch checked={capOn} onCheckedChange={setCapOn} aria-label="Limit track length" />
                </div>
              </div>
              <DualRange
                min={0} max={LEN_MAX} step={LEN_STEP}
                lo={minSec} hi={maxSec} disabled={!capOn}
                onLo={setMinSec} onHi={setMaxSec}
                loLabel="minimum track length in seconds"
                hiLabel="maximum track length in seconds"
              />
              <div className="mt-[5px] flex justify-between font-mono text-[9px] text-muted">
                <span>{capOn && minSec > 0 ? `min ${fmtDur(minSec)}` : 'no min'}</span>
                <span>{capOn && maxSec < LEN_MAX ? `max ${fmtDur(maxSec)}` : 'no max'}</span>
              </div>
            </div>

            {/* bpm band — analyzer tempo */}
            <div className="mb-5">
              <div className="mb-[9px] flex items-center justify-between">
                <Eyeb muted={!bpmOn}>Tempo</Eyeb>
                <div className="flex items-center gap-2.5">
                  {bpmOn && (
                    <span className="font-mono text-[11px] font-bold text-vermilion">
                      {minBpm > BPM_MIN && maxBpm < BPM_MAX ? `${minBpm} – ${maxBpm} bpm`
                        : minBpm > BPM_MIN ? `≥ ${minBpm} bpm`
                          : maxBpm < BPM_MAX ? `≤ ${maxBpm} bpm`
                            : 'any bpm'}
                    </span>
                  )}
                  <Switch checked={bpmOn} onCheckedChange={setBpmOn} aria-label="Limit tempo" />
                </div>
              </div>
              <DualRange
                min={BPM_MIN} max={BPM_MAX} step={BPM_STEP}
                lo={minBpm} hi={maxBpm} disabled={!bpmOn}
                onLo={setMinBpm} onHi={setMaxBpm}
                loLabel="minimum tempo in bpm"
                hiLabel="maximum tempo in bpm"
              />
              <div className="mt-[5px] flex justify-between font-mono text-[9px] text-muted">
                <span>{BPM_MIN}</span>
                <span>{BPM_MAX} bpm</span>
              </div>
            </div>

            <div className="mb-5 h-px bg-separator-strong" />

            {/* energy arc */}
            <div className="mb-5">
              <div className="mb-[9px]"><Eyeb>Energy arc</Eyeb></div>
              <div className="flex flex-wrap gap-1.5">
                {ARCS.map(a => (
                  <Tog key={a.id} on={arc === a.id} onClick={() => setArc(a.id)} title={a.hint}>{a.label}</Tog>
                ))}
              </div>
            </div>

            {/* moods */}
            <div className="mb-5">
              <div className="mb-[9px]"><Eyeb>Moods</Eyeb></div>
              <div className="flex flex-wrap gap-1.5">
                {MOODS.map(m => (
                  <Tog key={m} on={moods.includes(m)} onClick={() => toggle(moods, setMoods, m)}>{m}</Tog>
                ))}
              </div>
            </div>

            {/* energy levels */}
            <div className="mb-5">
              <div className="mb-[9px]"><Eyeb>Energy levels</Eyeb></div>
              <div className="flex flex-wrap gap-1.5">
                {ENERGIES.map(e => (
                  <Tog key={e} on={energies.includes(e)} onClick={() => toggle(energies, setEnergies, e)}>
                    {e.charAt(0).toUpperCase() + e.slice(1)}
                  </Tog>
                ))}
              </div>
            </div>

            {/* release year band */}
            <div className="mb-5">
              <div className="mb-[9px] flex items-center justify-between">
                <Eyeb>Release year</Eyeb>
                <span className={cn(
                  'font-mono text-[11px]',
                  yearFrom > YEAR_MIN || yearTo < YEAR_MAX ? 'font-bold text-vermilion' : 'text-muted',
                )}>
                  {yearFrom > YEAR_MIN && yearTo < YEAR_MAX ? `${yearFrom} – ${yearTo}`
                    : yearFrom > YEAR_MIN ? `since ${yearFrom}`
                      : yearTo < YEAR_MAX ? `until ${yearTo}`
                        : 'any year'}
                </span>
              </div>
              <DualRange
                min={YEAR_MIN} max={YEAR_MAX} step={1}
                lo={yearFrom} hi={yearTo}
                onLo={setYearFrom} onHi={setYearTo}
                loLabel="earliest release year"
                hiLabel="latest release year"
              />
              <div className="mt-[5px] flex justify-between font-mono text-[9px] text-muted">
                <span>{YEAR_MIN}</span>
                <span>{YEAR_MAX}</span>
              </div>
            </div>

            {/* genres */}
            <div className="mb-5">
              <div className="mb-[9px]"><Eyeb>Genres</Eyeb></div>
              <div className="relative">
                <input
                  value={genreInput}
                  onChange={e => setGenreInput(e.target.value)}
                  onFocus={loadGenres}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addGenre(); } }}
                  onBlur={() => { if (genreInput.trim()) addGenre(); }}
                  placeholder="Add a genre…"
                  aria-label="Add a genre"
                  className={searchInputClass}
                />
                {genreSuggestions && genreSuggestions.length > 0 && (
                  <div className="absolute z-20 max-h-56 w-full overflow-auto border border-t-0 border-ink bg-bg">
                    {genreSuggestions.map(g => (
                      <button
                        key={g.value}
                        type="button"
                        // preventDefault on mousedown so the input's onBlur (which
                        // commits raw text) doesn't fire before this click lands.
                        onMouseDown={e => e.preventDefault()}
                        onClick={() => {
                          setGenres(prev => prev.some(x => x.toLowerCase() === g.value.toLowerCase()) ? prev : [...prev, g.value]);
                          setGenreInput('');
                        }}
                        className="flex w-full items-center justify-between gap-2 border-b border-separator-soft px-[11px] py-2 text-left last:border-b-0 hover:bg-ink-soft"
                      >
                        <span className="truncate text-[13px]">{g.value}</span>
                        <span className="flex flex-none items-center gap-2 font-mono text-[10px] text-muted">
                          {g.songCount} tracks <Plus className="size-3.5" />
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {genres.length > 0 && (
                <div className="mt-2.5 flex flex-wrap gap-[7px]">
                  {genres.map(g => (
                    <Chip key={g} onRemove={() => setGenres(genres.filter(x => x !== g))}>{g}</Chip>
                  ))}
                </div>
              )}
            </div>

            {/* artists — allow-list filter */}
            <div className="mb-5">
              <div className="mb-[9px] flex items-center justify-between">
                <Eyeb>Artists</Eyeb>
                <span className="font-mono text-[10px] text-muted">only these artists</span>
              </div>
              <div className="relative">
                <input
                  value={artistQuery}
                  onChange={e => setArtistQuery(e.target.value)}
                  placeholder="Add an artist…"
                  aria-label="Add an artist"
                  className={searchInputClass}
                />
                {artistResults && artistResults.length > 0 && (
                  <div className="absolute z-20 max-h-56 w-full overflow-auto border border-t-0 border-ink bg-bg">
                    {artistResults.map(a => (
                      <button
                        key={a}
                        type="button"
                        onClick={() => {
                          if (!artists.some(x => x.toLowerCase() === a.toLowerCase())) setArtists([...artists, a]);
                          setArtistQuery(''); setArtistResults(null);
                        }}
                        className="flex w-full items-center justify-between gap-2 border-b border-separator-soft px-[11px] py-2 text-left last:border-b-0 hover:bg-ink-soft"
                      >
                        <span className="truncate text-[13px]">{a}</span>
                        <Plus className="size-3.5 flex-none text-muted" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {artists.length > 0 && (
                <div className="mt-2.5 flex flex-wrap gap-[7px]">
                  {artists.map(a => (
                    <Chip key={a} onRemove={() => setArtists(artists.filter(x => x !== a))}>{a}</Chip>
                  ))}
                </div>
              )}
            </div>

            <div className="mb-[18px] h-px bg-separator-strong" />

            {/* boolean toggles */}
            <div className="grid gap-[13px]">
              <SwitchRow label="Instrumental only" hint="skip vocal-forward tracks · best-effort" on={instrumentalOnly} onToggle={setInstrumentalOnly} />
              <SwitchRow label="Recently added" hint="source from new library arrivals" on={recentlyAdded} onToggle={setRecentlyAdded} />
              <SwitchRow label="Skip recent plays" hint="avoid tracks that recently aired" on={excludeRecent} onToggle={setExcludeRecent} />
            </div>
            </div>
          </ScrollArea>

          {/* generate footer */}
          <div className="flex-none border-t border-ink px-5 py-3.5">
            <div className="mb-[9px] flex gap-2">
              <Button
                variant="accent"
                className="h-10 flex-1"
                disabled={generating || !hasIntent}
                onClick={() => generate('fresh')}
              >
                {generating ? 'Assembling…' : 'Generate'}
              </Button>
              <Button
                variant="secondary"
                className="h-10"
                disabled={generating || !tracks.length}
                onClick={() => generate('regenerate')}
                title="new set, same recipe — excludes current tracks"
              >
                Regenerate
              </Button>
              <Button
                variant="ghost"
                className="h-10"
                disabled={generating || !tracks.length}
                onClick={() => generate('more')}
                title="append new matches"
              >
                More
              </Button>
            </div>
            <div className="font-mono text-[10px] leading-[1.5] text-muted">
              Regenerate excludes current tracks · More appends new matches. Needs a vibe, seed, or any tuning.
            </div>
          </div>
        </aside>

        {/* ============ RIGHT: RESULT ============ */}
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">

            {/* RESULT */}
            {showResult && (
              <div className="flex min-h-0 flex-1 flex-col">
                {/* Deck head — one title row with the toolbar, one meta strip.
                    Caveats and sync fold into the strip; the list gets the rest. */}
                <div className="flex-none border-b border-ink px-4 pt-1.5 pb-2.5 sm:px-6">
                  <div className="flex items-center gap-3">
                    <input
                      value={name}
                      onChange={e => setName(e.target.value)}
                      placeholder="Untitled set"
                      aria-label="Playlist name"
                      className="min-w-0 flex-1 border-b border-transparent bg-transparent py-0.5 font-display text-2xl font-bold tracking-[-0.01em] text-ink outline-none placeholder:text-muted/50 hover:border-separator-soft focus:border-[var(--accent)]"
                    />
                    <div className="flex flex-none items-center gap-1.5">
                      <Button variant="ghost" size="sm" className="h-8" onClick={openBrowse} title="open a playlist from the music server">
                        <FolderOpen data-icon="inline-start" />Open
                      </Button>
                      <Button variant="ghost" size="sm" className="h-8" onClick={doNew} title="start a blank draft">
                        <FilePlus2 data-icon="inline-start" />New
                      </Button>
                      <Button variant="accent" size="sm" className="h-8" disabled={saveDisabled} onClick={openSave} title="save to Navidrome">
                        <Save data-icon="inline-start" />{existingId ? 'Update' : 'Save'}
                      </Button>
                    </div>
                  </div>
                  {description && (
                    <p className="mt-0.5 line-clamp-1 text-[13px] text-muted italic" title={description}>{description}</p>
                  )}
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-ink">
                    {poolSize !== null && (usedFallback ? (
                      <Chip>▲ Fallback</Chip>
                    ) : (
                      <Chip accent>✦ AI-curated</Chip>
                    ))}
                    <span><b>{tracks.length}</b> tracks</span>
                    <span className="text-separator-strong">/</span>
                    <span><b>{fmtRun(totalSec)}</b></span>
                    {poolSize !== null && (
                      <>
                        <span className="text-separator-strong">/</span>
                        <span className="text-muted">{poolVerb} {chosenCount} from {poolSize} in pool</span>
                      </>
                    )}
                    {(reasons.length > 0 || usedFallback) && (
                      <button
                        type="button"
                        onClick={() => setCaveatsOpen(v => !v)}
                        className={cn(
                          'flex items-center gap-1 border px-1.5 py-px text-[10px] font-bold uppercase transition',
                          caveatsOpen ? 'border-ink text-ink' : 'border-separator-strong text-muted hover:border-ink hover:text-ink',
                        )}
                      >
                        △ {usedFallback ? 'no-AI details' : `${reasons.length} caveat${reasons.length === 1 ? '' : 's'}`}
                        {caveatsOpen ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                      </button>
                    )}
                    {existingId && (keepInSync || syncInfo) && (
                      <span className="flex items-center gap-2 text-muted">
                        <span className="text-separator-strong">/</span>
                        <span>synced {syncInfo?.lastSyncedAt ? relTime(syncInfo.lastSyncedAt) : '· not yet'}</span>
                        <button
                          type="button"
                          onClick={syncNow}
                          disabled={syncing}
                          title="check the library for new matches now"
                          className="flex items-center gap-1 border border-separator-strong px-1.5 py-px text-[10px] font-bold uppercase transition hover:border-ink hover:text-ink disabled:opacity-40"
                        >
                          <RefreshCw className={cn('size-3', syncing && 'animate-spin')} />
                          {syncing ? 'syncing…' : 'sync now'}
                        </button>
                      </span>
                    )}
                  </div>
                </div>

                {/* caveats detail — opt-in fold, auto-opened on fallback */}
                {caveatsOpen && (reasons.length > 0 || usedFallback) && (
                  <div className="flex-none border-b border-separator-soft bg-ink-soft px-4 py-2 font-mono text-[11px] leading-[1.6] text-muted sm:px-6">
                    {usedFallback && (
                      <div className="font-bold text-vermilion">
                        arranged without AI — the curation model was unreachable, so this set was ordered by rules (energy + relevance). Regenerate to retry the curator.
                      </div>
                    )}
                    {reasons.map((r, i) => <div key={i}>· {r}</div>)}
                  </div>
                )}

                <EnergyGraph
                  tracks={tracks}
                  arc={arc}
                  open={graphOpen}
                  onToggle={() => setGraphOpen(v => !v)}
                  onBarClick={jumpToRow}
                />

                {/* add track (slim) */}
                <div className="relative flex flex-none items-center gap-2.5 border-b border-separator-soft px-4 py-2 sm:px-6">
                  <Search className="size-4 flex-none text-muted" />
                  <input
                    value={addQuery}
                    onChange={e => setAddQuery(e.target.value)}
                    placeholder="Add any track from your library…"
                    aria-label="Add a track"
                    className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-muted/60 focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
                  />
                  {addResults && addResults.length > 0 && (
                    <div className="absolute top-full right-4 left-4 z-20 max-h-64 overflow-auto border border-ink bg-bg shadow-drawer sm:right-6 sm:left-6">
                      {addResults.map(s => (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => addTrack(s)}
                          className="flex w-full items-center justify-between gap-2 border-b border-separator-soft px-[11px] py-2 text-left last:border-b-0 hover:bg-ink-soft"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-[13px]">{s.title}</span>
                            <span className="block truncate font-mono text-[10px] text-muted">{s.artist}{s.album ? ` · ${s.album}` : ''}</span>
                          </span>
                          <Plus className="size-3.5 flex-none text-muted" />
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* track list — the star of the screen; every spare pixel is here */}
                <ScrollArea ref={listRef} className="flex-1">
                  <div className="pb-8">
                  {tracks.map((t, i) => (
                    <div
                      key={`${t.id}-${i}`}
                      data-row={i}
                      draggable
                      onDragStart={() => { dragIndex.current = i; }}
                      onDragOver={e => e.preventDefault()}
                      onDrop={() => { if (dragIndex.current != null) move(dragIndex.current, i); dragIndex.current = null; }}
                      className={cn(
                        'group grid grid-cols-[24px_44px_minmax(0,1fr)_auto] items-center gap-3 border-b border-separator-soft px-4 py-[9px] transition-colors hover:bg-ink-soft sm:grid-cols-[18px_24px_44px_minmax(0,1fr)_auto] sm:px-6',
                        hotRow === i && 'bg-vermilion/10',
                      )}
                    >
                      <div className="hidden cursor-grab place-items-center text-muted sm:grid">
                        <GripVertical className="size-4" />
                      </div>
                      <div className="text-right font-mono text-xs text-muted">{i + 1}</div>
                      <img
                        src={`${API}/cover/${encodeURIComponent(t.id)}`}
                        alt=""
                        loading="lazy"
                        className="size-11 border border-ink bg-ink-soft object-cover"
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-semibold">{t.title}</span>
                          {dupeIds.has(t.id) && (
                            <span className="flex-none border border-[var(--accent)] px-1 py-px font-mono text-[9px] font-bold tracking-[0.08em] text-vermilion">DUPLICATE</span>
                          )}
                        </div>
                        <div className="mt-[3px] truncate font-mono text-[11px] text-muted">
                          {t.artist}{t.album ? ` · ${t.album}` : ''}
                        </div>
                        {((t.moods && t.moods.length > 0) || t.instrumental === true) && (
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                            {(t.moods || []).slice(0, 2).map(m => (
                              <span key={m} className="border border-separator-soft px-[5px] py-px font-mono text-[9px] tracking-[0.04em] text-muted uppercase">{m}</span>
                            ))}
                            {t.instrumental === true && (
                              <span className="border border-separator-soft px-[5px] py-px font-mono text-[9px] tracking-[0.04em] text-muted uppercase">instrumental</span>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="flex flex-col items-end gap-[3px]">
                          <span className="font-mono text-xs text-ink">{fmtDur(t.durationSec || 0)}</span>
                          <span className="flex items-center gap-[5px] font-mono text-[10px] text-muted">
                            <span className={cn('inline-block size-[7px]', energyBgClass(t.energy))} />
                            {energyLabel(t.energy)}{t.year ? ` · ${t.year}` : ''}
                          </span>
                        </div>
                        <div className="flex items-center gap-0.5 transition-opacity lg:opacity-0 lg:group-hover:opacity-100">
                          <IconBtn onClick={() => move(i, i - 1)} disabled={i === 0} title="Move up"><ArrowUp className="size-[15px]" /></IconBtn>
                          <IconBtn onClick={() => move(i, i + 1)} disabled={i === tracks.length - 1} title="Move down"><ArrowDown className="size-[15px]" /></IconBtn>
                          <IconBtn onClick={() => removeAt(i)} title="Remove"><X className="size-[15px]" /></IconBtn>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                </ScrollArea>
              </div>
            )}

            {/* EMPTY */}
            {showEmpty && (
              <div className="flex flex-1 items-center justify-center p-8 lg:p-10">
                <div className="w-full max-w-[520px]">
                  <div className="mb-2.5 font-mono text-[10px] font-bold tracking-[0.2em] text-muted uppercase">New draft</div>
                  <h2 className="mb-2.5 font-display text-[32px] font-bold tracking-[-0.01em]">
                    Nothing in the set yet.
                  </h2>
                  <p className="mb-[26px] text-sm leading-[1.55] text-muted">
                    Build a playlist two ways. The station reads its music library and returns an ordered set you can reshape by hand before saving to Navidrome.
                  </p>
                  <div className="grid gap-3">
                    <div className="flex gap-3.5 border border-ink p-4">
                      <div className="grid size-[26px] flex-none place-items-center border border-ink bg-[var(--accent)] font-mono text-xs font-bold text-white">1</div>
                      <div>
                        <div className="mb-0.5 text-sm font-bold">Describe a vibe, then Generate</div>
                        <div className="text-[13px] leading-[1.5] text-muted">Type a mood on the left, optionally add seed tracks and tuning, and let the curator assemble the set.</div>
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-3.5 border border-separator-strong p-4">
                      <div className="flex gap-3.5">
                        <div className="grid size-[26px] flex-none place-items-center border border-ink font-mono text-xs font-bold">2</div>
                        <div>
                          <div className="mb-0.5 text-sm font-bold">Open an existing playlist</div>
                          <div className="text-[13px] leading-[1.5] text-muted">Load one from the music server to edit or regenerate.</div>
                        </div>
                      </div>
                      <Button variant="secondary" size="sm" className="h-8" onClick={openBrowse}>Browse</Button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* GENERATING */}
            {view === 'generating' && (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex flex-none items-center justify-center gap-4 px-6 pt-10 pb-[26px]">
                  <div className="size-[34px] flex-none animate-spin rounded-full border-2 border-separator-strong border-t-[var(--accent)]" />
                  <div>
                    <div className="font-display text-[22px] font-bold">Assembling your set…</div>
                    <div className="mt-1 font-mono text-[11px] text-muted">Scanning candidate tracks · sequencing by energy arc</div>
                  </div>
                </div>
                <div className="flex-1 overflow-hidden px-4 sm:px-6">
                  <div className="grid gap-[9px]">
                    {[0, 1, 2, 3, 4].map(i => (
                      <div key={i} className="h-[60px] animate-pulse border border-separator-soft bg-ink-soft" />
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* NO MATCH */}
            {view === 'nomatch' && (
              <div className="flex flex-1 items-center justify-center p-8 lg:p-10">
                <div className="max-w-[460px] text-center">
                  <div className="mb-2.5 font-mono text-[10px] font-bold tracking-[0.2em] text-muted uppercase">0 results</div>
                  <h2 className="mb-2.5 font-display text-[28px] font-bold">
                    Nothing matched this recipe.
                  </h2>
                  <p className="mb-[22px] text-sm leading-[1.55] text-muted">
                    The filters were too tight for your library. Try widening the era, allowing more moods or energy levels, turning off <span className="text-ink">Instrumental only</span>, or dropping a genre.
                  </p>
                  <Button variant="accent" className="h-10" onClick={() => generate(lastMode.current)}>Loosen &amp; try again</Button>
                </div>
              </div>
            )}

            {/* ERROR */}
            {view === 'error' && (
              <div className="flex flex-1 items-center justify-center p-8 lg:p-10">
                <div className="w-full max-w-[480px]">
                  <V3Alert tone="error" title="generation failed">
                    {errorMsg || 'The request to the curation service failed.'} Your recipe is untouched. Try again in a moment.
                  </V3Alert>
                  <div className="mt-4 flex gap-2.5">
                    <Button variant="accent" className="h-10" onClick={() => generate(lastMode.current)}>Retry</Button>
                    <Button variant="ghost" className="h-10" onClick={doNew}>Start over</Button>
                  </div>
                </div>
              </div>
            )}
          </div>

        </section>
      </div>

      {/* TOAST */}
      {toast && (
        <div className="fixed top-[70px] right-6 z-[60] flex max-w-[340px] items-center gap-3 bg-ink px-3.5 py-3 text-bg shadow-drawer">
          <span className="text-[13px] leading-[1.4]">{toast}</span>
          <button type="button" onClick={() => setToast('')} className="flex-none text-bg/70 hover:text-bg" title="dismiss">
            <X className="size-3.5" />
          </button>
        </div>
      )}

      {/* OPEN-EXISTING MODAL */}
      {modal === 'open' && (
        <div
          // Backdrop only — no role, no tabIndex. Making it a `role="button"`
          // would put a full-viewport control in the tab order *and* wrap the
          // dialog in a role whose children are presentational, hiding the real
          // controls from assistive tech. Escape is handled once at the document
          // level (see the effect above) so it works wherever focus sits.
          className="fixed inset-0 z-[80] flex items-start justify-center bg-[rgba(20,18,14,0.42)] p-5 pt-16"
          // Close on a click landing on the backdrop itself (not bubbled from
          // the panel), so the panel needs no onClick stopPropagation of its own.
          onClick={e => { if (e.target === e.currentTarget) setModal(null); }}
        >
          <div
            ref={modalPanelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="pb-open-title"
            tabIndex={-1}
            className="flex max-h-[78vh] w-full max-w-[560px] flex-col border border-ink bg-bg shadow-drawer outline-none"
          >
            <div className="flex items-center justify-between border-b border-ink px-5 py-4">
              <div>
                <div className="font-mono text-[10px] font-bold tracking-[0.18em] text-muted uppercase">Music server</div>
                <h3 id="pb-open-title" className="mt-0.5 font-display text-xl font-bold">Open a playlist</h3>
              </div>
              <IconBtn onClick={() => setModal(null)} title="close"><X className="size-4" /></IconBtn>
            </div>
            <div className="px-5 pt-3.5 pb-2.5">
              <input
                value={playlistQuery}
                onChange={e => setPlaylistQuery(e.target.value)}
                placeholder="Search playlists…"
                aria-label="Search playlists"
                className={searchInputClass}
              />
            </div>
            <div className="flex-1 overflow-y-auto px-5 pb-4">
              {filteredPlaylists === null ? (
                <div className="px-3 py-8 text-center text-sm text-muted">Loading…</div>
              ) : filteredPlaylists.length === 0 ? (
                <div className="px-3 py-8 text-center text-sm text-muted">
                  {playlistQuery ? 'No playlists match.' : 'No playlists yet.'}
                </div>
              ) : filteredPlaylists.map(p => (
                <div
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => loadPlaylist(p)}
                  onKeyDown={e => { if (e.key === 'Enter') loadPlaylist(p); }}
                  className="mt-2 flex w-full cursor-pointer items-center justify-between gap-3 border border-separator-soft p-3 text-left transition-colors hover:bg-ink-soft"
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold">{p.name}</span>
                      {p.synced && (
                        <span className="flex-none border border-[var(--accent)] px-[5px] py-px font-mono text-[9px] font-bold tracking-[0.06em] text-vermilion">SYNCED</span>
                      )}
                    </span>
                    <span className="mt-[3px] block font-mono text-[11px] text-muted">
                      {p.songCount} tracks{p.synced && p.lastSyncedAt ? ` · synced ${relTime(p.lastSyncedAt)}` : ''}
                    </span>
                  </span>
                  <span className="flex flex-none items-center gap-1">
                    <button
                      type="button"
                      onClick={e => {
                        e.stopPropagation();
                        if (armedDelete === p.id) { void deletePlaylist(p); }
                        else { setArmedDelete(p.id); window.setTimeout(() => setArmedDelete(a => (a === p.id ? null : a)), 2600); }
                      }}
                      title={armedDelete === p.id ? 'click again to delete from Navidrome' : 'delete playlist'}
                      className={cn(
                        'flex items-center gap-1 border px-1.5 py-1 font-mono text-[9px] font-bold tracking-[0.06em] uppercase transition',
                        armedDelete === p.id
                          ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
                          : 'border-transparent text-muted hover:border-separator-strong hover:text-ink',
                      )}
                    >
                      <Trash2 className="size-3.5" />
                      {armedDelete === p.id && 'sure?'}
                    </button>
                    <ChevronRight className="size-4 flex-none text-muted" />
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* SAVE MODAL */}
      {modal === 'save' && (
        <div
          // See the OPEN modal above: backdrop stays a plain div; Escape is
          // owned by the document-level handler.
          className="fixed inset-0 z-[80] flex items-start justify-center bg-[rgba(20,18,14,0.42)] p-5 pt-16"
          onClick={e => { if (e.target === e.currentTarget) setModal(null); }}
        >
          <div
            ref={modalPanelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="pb-save-title"
            tabIndex={-1}
            className="w-full max-w-[480px] border border-ink bg-bg shadow-drawer outline-none"
          >
            <div className="flex items-center justify-between border-b border-ink px-5 py-4">
              <div>
                <div className="font-mono text-[10px] font-bold tracking-[0.18em] text-muted uppercase">
                  {tracks.length} tracks · {fmtRun(totalSec)}
                </div>
                <h3 id="pb-save-title" className="mt-0.5 font-display text-xl font-bold">Save playlist</h3>
              </div>
              <IconBtn onClick={() => setModal(null)} title="close"><X className="size-4" /></IconBtn>
            </div>
            <div className="grid gap-4 px-5 py-[18px]">
              <div>
                <div className="mb-[7px]"><Eyeb>Name</Eyeb></div>
                <input value={saveName} onChange={e => setSaveName(e.target.value)} placeholder="Untitled set" aria-label="Playlist name" className={searchInputClass} />
              </div>
              {existingId && (
                <div className="grid gap-2">
                  {([
                    { id: 'overwrite' as const, label: 'Overwrite existing', hint: `updates “${name || saveName || 'this playlist'}” on the server` },
                    { id: 'create' as const, label: 'Create a new playlist', hint: 'leaves the original untouched' },
                  ]).map(opt => {
                    const on = saveMode === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setSaveMode(opt.id)}
                        className={cn('flex items-center gap-[11px] border p-3 text-left', on ? 'border-[var(--accent)]' : 'border-separator-strong')}
                      >
                        <span className={cn('grid size-3.5 flex-none place-items-center rounded-full border', on ? 'border-[var(--accent)]' : 'border-separator-strong')}>
                          {on && <span className="size-[7px] rounded-full bg-[var(--accent)]" />}
                        </span>
                        <span>
                          <span className="block text-[13px] font-semibold">{opt.label}</span>
                          <span className="block font-mono text-[10px] text-muted">{opt.hint}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="flex items-center justify-between gap-3 border-t border-separator-soft pt-3.5">
                <div>
                  <div className="text-[13px] font-semibold">Keep in sync</div>
                  <div className="max-w-[280px] font-mono text-[10px] leading-[1.5] text-muted">
                    Remembers this recipe and appends new matching songs after library tagging.
                  </div>
                </div>
                <Switch checked={saveSync} onCheckedChange={setSaveSync} aria-label="Keep in sync" />
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-ink px-5 py-3.5">
              <span className="font-mono text-[10px] text-muted">
                Then pin it to a show in <a href="/admin/shows" className="text-vermilion hover:text-ink">Shows</a> →
              </span>
              <div className="flex gap-2.5">
                <Button variant="ghost" className="h-10" onClick={() => setModal(null)}>Cancel</Button>
                <Button variant="accent" className="h-10" disabled={saving || !saveName.trim()} onClick={doSave}>
                  {saving ? 'Saving…' : 'Save playlist'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

'use client';

// Fetch the voice catalogue on expansion. Google's speaker traits come from the selected voice, so derive accent and gender filters from the catalogue.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '../../ui/select';
import {
  flattenLibraryPages,
  normalizeLibraryInput,
  useGeminiLibraryQuery,
  type LibraryInput,
  type LibraryVoice,
} from './geminiLibraryQueries';
import { fetchPreviewSample } from './previewApi';
import { cn } from '../../../lib/cn';

/** Union the catalogue vocabulary with any value the operator has already
 *  chosen. A selection must never disappear from the menu that holds it —
 *  otherwise picking a value the catalogue has not confirmed yet silently
 *  resets the control. */
function withSelection(options: string[], selected: string): string[] {
  if (selected === ANY || options.includes(selected)) return options;
  return [...options, selected].sort();
}

/** Radix Select rejects an empty-string item value, so "no filter" and
 *  "every language" each need a placeholder. They are DIFFERENT requests — the
 *  first defers to the station's saved default, the second overrides it — so
 *  they get different placeholders. They were one value before, and the merged
 *  case sent `language=__any__` on the wire. Both are translated away by
 *  `normalizeLibraryInput`; neither is ever a server value. */
const ANY = 'any';
const STATION_DEFAULT = '__station_default__';
// Google's own page_size ceiling is 1000; 200 keeps a browse responsive while
// still covering one language in a single request (en-AU is 44).
const PAGE_SIZE = 200;

/** Derive a vocabulary from the voices actually on screen.
 *
 *  This is the COLD path only, and it is deliberately worse than the catalogue:
 *  it describes the current result rather than the whole library, so an accent
 *  the current page happens not to contain is simply absent from the menu. The
 *  alternative — empty dropdowns until the controller finishes its boot walk —
 *  reads as a broken control, and this component has to work on a controller
 *  that reports `ready: false`. Values are still Google's own, never a
 *  restated list. */
function facetsOf(voices: LibraryVoice[]) {
  const pick = (f: (v: LibraryVoice) => string | undefined) =>
    [...new Set(voices.map(f).filter((x): x is string => !!x && x !== ''))].sort();
  return {
    languages: pick(v => v.language),
    accents: pick(v => v.accent),
    genders: pick(v => v.gender),
    pitches: pick(v => v.pitch),
  };
}

interface Props {
  adminFetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** The persona's current voice, so a library pick is visible as selected. */
  value: string;
  onChange: (voice: string) => void;
  /** Auditioned WITHOUT selecting. A browse is a comparison, and a play button
   *  that quietly rewrote the persona's voice would make comparing voices a
   *  one-way trip. The sample is rendered by this component's own request so the
   *  voice under test is the one heard, not the saved one. */
  speed?: number;
  /** The persona's on-air language, which picks the sample SENTENCE server-side.
   *  Named apart from the `language` FILTER state below — they are unrelated
   *  and sharing one name shadowed the filter. */
  sampleLanguage?: string;
}

export function GeminiVoiceLibrary({ adminFetch, value, onChange, speed, sampleLanguage }: Props) {
  const [auditioning, setAuditioning] = useState<string | null>(null);
  const [auditionError, setAuditionError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // The object URL is tracked SEPARATELY from the element: revoking
  // `audioRef.current.src` reads a property that a detached or already-ended
  // element may not have, and a browser that has already released the blob
  // would silently leak the URL we just made.
  const audioUrl = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const auditionSeq = useRef(0);

  /** Stop playback and release the blob. Idempotent — every exit path calls it. */
  const releaseCurrent = useCallback(() => {
    const el = audioRef.current;
    if (el) { el.pause(); el.onended = null; el.src = ''; audioRef.current = null; }
    if (audioUrl.current) { URL.revokeObjectURL(audioUrl.current); audioUrl.current = null; }
  }, []);
  const stopCurrent = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    releaseCurrent();
  }, [releaseCurrent]);

  // Unmounting mid-render used to leave an Audio playing and its blob URL live,
  // because nothing on the way out released them. The Personas page renders one
  // of these per persona, so closing an editor mid-sample is a normal path.
  useEffect(() => () => { auditionSeq.current += 1; stopCurrent(); }, [stopCurrent]);

  const audition = useCallback(async (voiceId: string) => {
    // A second Play while the first is still rendering, or still playing, used
    // to overlap: the old element kept its src and kept going while the new one
    // started, so two voices talked over each other. Stop the outgoing element
    // and invalidate the request in flight so only the newest sample can play.
    auditionSeq.current += 1;
    const mine = auditionSeq.current;
    stopCurrent();
    const ac = new AbortController();
    abortRef.current = ac;
    setAuditioning(voiceId);
    setAuditionError(null);
    try {
      const res = await fetchPreviewSample(adminFetch, {
        engine: 'gemini', voice: voiceId, speed, language: sampleLanguage,
      }, ac.signal);
      // A superseded audition must not resurrect itself when it lands.
      if (mine !== auditionSeq.current) return;
      if (!res.ok) { setAuditionError(res.message); return; }
      const url = URL.createObjectURL(res.blob);
      const el = new Audio(url);
      el.onended = () => { if (audioRef.current === el) releaseCurrent(); };
      audioRef.current = el;
      audioUrl.current = url;
      await el.play().catch(() => {
        // A refused play() (autoplay policy) leaves a live object URL and a live
        // element that nothing will ever release: `onended` never fires for audio
        // that never started. The message also stays up until the next audition,
        // so a blocked sample reads as a permanent error rather than a retry.
        if (audioRef.current === el) releaseCurrent();
        if (mine === auditionSeq.current) setAuditionError('Playback was blocked — press play again');
      });
    } catch (e: unknown) {
      if ((e as { name?: string })?.name === 'AbortError' || mine !== auditionSeq.current) return;
      setAuditionError((e as { message?: string })?.message || 'Preview failed');
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      if (mine === auditionSeq.current) setAuditioning(null);
    }
  }, [adminFetch, speed, sampleLanguage, releaseCurrent, stopCurrent]);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [language, setLanguage] = useState<string>(STATION_DEFAULT);
  const [gender, setGender] = useState<string>(ANY);
  const [pitch, setPitch] = useState<string>(ANY);
  const [accent, setAccent] = useState<string>(ANY);
  // Keep draft controls separate until Apply. Each applied filter set owns its query cursor. Omit
  // language initially so the station default applies.
  const [appliedInput, setAppliedInput] = useState<LibraryInput>({});

  const library = useGeminiLibraryQuery(adminFetch, appliedInput, open);
  const { voices, facets } = useMemo(() => flattenLibraryPages(library.data?.pages), [library.data?.pages]);
  const loading = library.isPending || library.isFetchingNextPage;
  const error = library.isError
    ? (library.error?.message || 'Voice library unreachable')
    : null;

  const apply = useCallback(() => {
    setAppliedInput(normalizeLibraryInput({
      // STATION_DEFAULT -> undefined, so the request omits `language` and the
      // route applies the saved default. ANY -> 'any', sent explicitly so it
      // overrides that default rather than being absorbed by it.
      language: language === STATION_DEFAULT ? undefined : language,
      gender: gender === ANY ? undefined : gender,
      pitch: pitch === ANY ? undefined : pitch,
      accent: accent === ANY ? undefined : accent,
      search: search.trim() || undefined,
      pageSize: PAGE_SIZE,
    }));
  }, [language, gender, pitch, accent, search]);

  // The catalogue vocabulary is authoritative and identical for every persona
  // card, so it is preferred whenever the controller has one. `flattenLibraryPages`
  // only hands one back when it is `ready` — a walk that has not finished must
  // not claim to be the whole catalogue — so the on-screen page stands in.
  const catalogue = useMemo(() => {
    const base = facets ?? facetsOf(voices);
    return {
      languages: withSelection(base.languages, language),
      accents: withSelection(base.accents, accent),
      // Gender and pitch are low-cardinality, so a current page almost always
      // contains every value that exists; they need no selection union.
      genders: base.genders,
      pitches: base.pitches,
    };
  }, [facets, voices, language, accent]);

  // A saved library voice must stay visible even when a filter set excludes it,
  // or the operator cannot tell what the persona is actually using.
  // Whether the persona's SAVED voice is among the CURRENT results. Two separate
  // facts, previously conflated into one `selected` derived from `voices` and then
  // required to be absent from `voices` — a condition that can never hold, so the
  // "not in these results" note was dead code and a saved voice excluded by the
  // filters was invisible. `onList` is recorded on select so the name can still be
  // shown after it drops out of the page.
  const [savedLabel, setSavedLabel] = useState<string | null>(null);
  const onList = useMemo(() => {
    if (!value) return null;
    return voices.find(v => v.id === value || v.label === value) || null;
  }, [voices, value]);

  // Remember the label as long as the voice is on screen, so a filter change that
  // excludes it can still name it.
  useEffect(() => {
    if (onList) setSavedLabel(onList.label);
  }, [onList]);

  const selectedName = onList?.label ?? savedLabel;
  const savedIsHidden = !!value && !onList;

  if (!open) {
    return (
      <button
        type="button"
        className="mt-2 inline-flex cursor-pointer items-center gap-1.5 border border-ink bg-transparent px-2.5 py-[5px] text-[9px] font-bold tracking-[0.2em] text-ink uppercase hover:bg-[var(--ink-soft)]"
        onClick={() => setOpen(true)}
      >
        Browse Google&apos;s voice library
      </button>
    );
  }

  const filter = (
    label: string, value_: string, set: (v: string) => void, options: string[], allLabel: string,
  ) => (
    <div className="field">
      <Label>{label}</Label>
      <Select value={value_} onValueChange={set}>
        <SelectTrigger aria-label={label}><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>{allLabel}</SelectItem>
          {options.map(o => <SelectItem key={o} value={o}>{o}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <div className="mt-3 border border-ink/25 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold tracking-[0.16em] text-ink uppercase">
          Voice library
        </span>
        <button
          type="button"
          className="cursor-pointer text-[9px] font-bold tracking-[0.2em] text-muted uppercase hover:text-ink"
          onClick={() => { auditionSeq.current += 1; stopCurrent(); setOpen(false); }}
        >
          Close
        </button>
      </div>

      <div className="field">
        <Label>Search</Label>
        <Input
          aria-label="Search the Gemini voice library"
          value={search}
          maxLength={60}
          placeholder="e.g. narrator, warm, Sydney, newscaster"
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        {/* Station default omits the language parameter; every language sends 'any'. */}
        <div className="field">
          <Label>Language</Label>
          <Select value={language} onValueChange={setLanguage}>
            <SelectTrigger aria-label="Language"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={STATION_DEFAULT}>Station default</SelectItem>
              <SelectItem value={ANY}>Every language</SelectItem>
              {catalogue.languages.map(l => <SelectItem key={l} value={l}>{l}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        {filter('Gender', gender, setGender, catalogue.genders, 'Any')}
        {filter('Pitch', pitch, setPitch, catalogue.pitches, 'Any')}
        {filter('Accent', accent, setAccent, catalogue.accents, 'Any')}
      </div>

      <button
        type="button"
        disabled={loading}
        className="mt-3 w-full cursor-pointer border border-ink bg-transparent py-[6px] text-[9px] font-bold tracking-[0.2em] text-ink uppercase hover:bg-[var(--ink-soft)] disabled:opacity-40"
        onClick={apply}
      >
        {loading ? 'Searching…' : 'Apply filters'}
      </button>

      {error && (
        <div className="mt-2 text-[10px] text-[var(--danger)]">
          <div role="alert">{error}</div>
          {!library.isFetchNextPageError && (
            <button
              type="button"
              disabled={library.isFetching}
              className="mt-2 cursor-pointer border border-ink px-2 py-1 text-ink disabled:opacity-40"
              onClick={() => void library.refetch()}
            >
              Retry search
            </button>
          )}
        </div>
      )}
      {auditionError && <div className="mt-2 text-[10px] text-[var(--danger)]">{auditionError}</div>}

      {!loading && !error && voices.length === 0 && (
        <div className="mt-2 text-[10px] text-muted">
          No voices matched. Try widening the filters — the accent names come from
          Google and there is no &ldquo;Australian&rdquo;; Australian voices are
          labelled by city.
        </div>
      )}

      {savedIsHidden && (
        <div className="mt-2 text-[10px] text-muted">
          Currently saved: <strong>{selectedName || value}</strong> — not in these results.
        </div>
      )}

      <ul className="mt-3 grid gap-1.5">
        {voices.map(v => {
          const on = v.id === value || v.label === value;
          return (
            <li key={v.id} className={cn('flex items-center gap-2 border px-2 py-1.5',
              on ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-ink/25')}>
              <button
                type="button"
                className="min-w-0 flex-1 cursor-pointer text-left"
                onClick={() => onChange(v.id)}
                aria-pressed={on}
              >
                <span className="block truncate text-[11px] font-bold text-ink">{v.label}</span>
                <span className="block truncate text-[9px] text-muted">
                  {[v.accent, v.gender, v.pitch].filter(Boolean).join(' · ') || v.persona || v.id}
                </span>
              </button>
              <button
                type="button"
                className="flex-none cursor-pointer border border-ink bg-transparent px-2 py-1 text-[9px] font-bold tracking-[0.16em] text-ink uppercase hover:bg-[var(--ink-soft)]"
                onClick={() => void audition(v.id)}
                aria-label={`Play a sample of ${v.label}`}
              >
                {auditioning === v.id ? '…' : 'Play'}
              </button>
            </li>
          );
        })}
      </ul>

      {library.hasNextPage && (
        <button
          type="button"
          disabled={loading}
          className="mt-2 w-full cursor-pointer border border-ink bg-transparent py-[6px] text-[9px] font-bold tracking-[0.2em] text-ink uppercase hover:bg-[var(--ink-soft)] disabled:opacity-40"
          onClick={() => void library.fetchNextPage()}
        >
          {loading ? 'Loading…' : library.isFetchNextPageError ? 'Retry load more' : 'Load more'}
        </button>
      )}
    </div>
  );
}

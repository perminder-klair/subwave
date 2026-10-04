'use client';

// Browses Google's Extended Voice Library — the ~2,000 prebuilt voices BEYOND
// the 30 featured ones the persona card lists as presets.
//
// WHY A DISCLOSURE, NOT AN ALWAYS-OPEN PICKER
// -------------------------------------------
// The Personas page renders one of these per persona — twelve on a typical
// station — and each one would otherwise fire its own catalogue request on
// mount. So it is closed by default and fetches on first expand. The same
// reasoning keeps the request out of the station Voice panel's initial paint.
//
// WHY FILTERS AND NOT FREE TEXT FOR GENDER / ACCENT
// --------------------------------------------------
// Google is explicit: "Do not try to change immutable speaker traits in style:
// avoid putting age, gender, names, or permanent accent changes in
// speech_metadata.style. Instead, pick a regional voice from the Extended Voice
// Library." The accent comes from the VOICE, so the only honest control is a
// filter over real voices. The dropdown values are the distinct values Google
// actually served in the current page — derived, never a restated list. That
// matters concretely: there is no "Australian" accent to offer, because en-AU
// voices are labelled "Sydney English", and a hardcoded vocabulary would have
// offered a filter that returns nothing.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '../../ui/select';
import { adminResponse } from '../../../lib/admin-query';
import { fetchPreviewSample } from './previewApi';
import { cn } from '../../../lib/cn';

export interface LibraryVoice {
  id: string;
  label: string;
  language?: string;
  accent?: string;
  gender?: string;
  pitch?: string;
  persona?: string;
  description?: string;
}

const ANY = '__any__';
// Google's own page_size ceiling is 1000; 200 keeps a browse responsive while
// still covering one language in a single request (en-AU is 44).
const PAGE_SIZE = 200;

function facetsOf(voices: LibraryVoice[]) {
  const uniq = (pick: (v: LibraryVoice) => string | undefined) =>
    [...new Set(voices.map(pick).filter((s): s is string => !!s))].sort();
  return {
    languages: uniq(v => v.language),
    accents: uniq(v => v.accent),
    genders: uniq(v => v.gender),
    pitches: uniq(v => v.pitch),
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

  const audition = useCallback(async (voiceId: string) => {
    setAuditioning(voiceId);
    setAuditionError(null);
    try {
      const res = await fetchPreviewSample(adminFetch, {
        engine: 'gemini', voice: voiceId, speed, language: sampleLanguage,
      });
      if (!res.ok) { setAuditionError(res.message); return; }
      const url = URL.createObjectURL(res.blob);
      // Revoke the PREVIOUS object URL before replacing the element, or a long
      // browse leaks one blob per row played.
      if (audioRef.current) { URL.revokeObjectURL(audioRef.current.src); }
      const el = new Audio(url);
      audioRef.current = el;
      await el.play().catch(() => { setAuditionError('Playback was blocked — press play again'); });
    } catch (e: unknown) {
      setAuditionError((e as { message?: string })?.message || 'Preview failed');
    } finally {
      setAuditioning(null);
    }
  }, [adminFetch, speed, sampleLanguage]);
  const [open, setOpen] = useState(false);
  const [voices, setVoices] = useState<LibraryVoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [language, setLanguage] = useState<string>(ANY);
  const [gender, setGender] = useState<string>(ANY);
  const [pitch, setPitch] = useState<string>(ANY);
  const [accent, setAccent] = useState<string>(ANY);
  const [pageToken, setPageToken] = useState<string | undefined>();
  // Guards a late response from a superseded filter set — the same reason the
  // preview sampler carries a sequence ref.
  const seq = useRef(0);

  // `language` starts as ANY, which the route reads as "ignore the station's
  // saved libraryLanguage default" so the operator's first browse is every
  // language and the facets below can show what exists. The saved default is
  // applied by the station panel's own "apply default" affordance instead of
  // being silently imposed here.
  const load = useCallback(async (opts: { append?: boolean; token?: string } = {}) => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    const q = new URLSearchParams({ provider: 'gemini', pageSize: String(PAGE_SIZE) });
    if (language !== ANY) q.set('language', language);
    if (gender !== ANY) q.set('gender', gender);
    if (pitch !== ANY) q.set('pitch', pitch);
    if (accent !== ANY) q.set('accent', accent);
    if (search.trim()) q.set('search', search.trim());
    if (opts.token) q.set('pageToken', opts.token);
    try {
      const res = await adminResponse(adminFetch, `/settings/tts/voices?${q}`);
      const body = await res.json() as {
        ok: boolean; voices?: LibraryVoice[]; nextPageToken?: string; error?: string;
      };
      if (mine !== seq.current) return; // a newer filter set won
      if (!body.ok) { setError(body.error || 'Voice library unavailable'); return; }
      const rows = Array.isArray(body.voices) ? body.voices : [];
      setVoices(prev => (opts.append ? [...prev, ...rows] : rows));
      setPageToken(body.nextPageToken);
    } catch (e: unknown) {
      if (mine !== seq.current) return;
      setError((e as { message?: string })?.message || 'Voice library unreachable');
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [adminFetch, language, gender, pitch, accent, search]);

  // First expand only. Afterwards the operator drives it with the controls, so
  // re-running this on every filter change would double-request.
  const started = useRef(false);
  useEffect(() => {
    if (open && !started.current) { started.current = true; void load(); }
  }, [open, load]);

  const facets = useMemo(() => facetsOf(voices), [voices]);

  // A saved library voice must stay visible even when a filter set excludes it,
  // or the operator cannot tell what the persona is actually using.
  const selected = useMemo(() => {
    if (!value) return null;
    return voices.find(v => v.id === value || v.label === value) || null;
  }, [voices, value]);

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
          onClick={() => { setOpen(false); }}
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
        {filter('Language', language, setLanguage, facets.languages, 'Every language')}
        {filter('Gender', gender, setGender, facets.genders, 'Any')}
        {filter('Pitch', pitch, setPitch, facets.pitches, 'Any')}
        {filter('Accent', accent, setAccent, facets.accents, 'Any')}
      </div>

      <button
        type="button"
        disabled={loading}
        className="mt-3 w-full cursor-pointer border border-ink bg-transparent py-[6px] text-[9px] font-bold tracking-[0.2em] text-ink uppercase hover:bg-[var(--ink-soft)] disabled:opacity-40"
        onClick={() => void load()}
      >
        {loading ? 'Searching…' : 'Apply filters'}
      </button>

      {error && <div className="mt-2 text-[10px] text-[var(--danger)]">{error}</div>}
      {auditionError && <div className="mt-2 text-[10px] text-[var(--danger)]">{auditionError}</div>}

      {!loading && !error && voices.length === 0 && (
        <div className="mt-2 text-[10px] text-muted">
          No voices matched. Try widening the filters — the accent names come from
          Google and there is no &ldquo;Australian&rdquo;; Australian voices are
          labelled by city.
        </div>
      )}

      {selected && !voices.some(v => v.id === selected.id) && (
        <div className="mt-2 text-[10px] text-muted">
          Currently saved: <strong>{selected.label}</strong> — not in these results.
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

      {pageToken && (
        <button
          type="button"
          disabled={loading}
          className="mt-2 w-full cursor-pointer border border-ink bg-transparent py-[6px] text-[9px] font-bold tracking-[0.2em] text-ink uppercase hover:bg-[var(--ink-soft)] disabled:opacity-40"
          onClick={() => void load({ append: true, token: pageToken })}
        >
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}
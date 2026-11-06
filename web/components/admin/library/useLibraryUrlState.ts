'use client';

import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { Energy, SearchMode, Sort, Tab, TrackMode, Vocal } from './types';
import { SORTS, TABS } from './types';

// The library page's query-string mirror: which tab is open, the browse
// filters, and the search query. Restored once on mount (post-hydration, so no
// SSR mismatch) and written back via history.replaceState, not a Next.js
// navigation — a router push would remount the panel on every keystroke.
//
// Browse's `page` is deliberately NOT here: it is not mirrored to the URL, so
// it belongs to whichever component owns the browse fetch.
export interface LibraryUrlState {
  tab: Tab; setTab: (t: Tab) => void;
  trackMode: TrackMode; setTrackMode: (m: TrackMode) => void;
  moods: string[]; setMoods: Dispatch<SetStateAction<string[]>>;
  energy: Energy; setEnergy: (e: Energy) => void;
  vocal: Vocal; setVocal: (v: Vocal) => void;
  genre: string; setGenre: (g: string) => void;
  language: string; setLanguage: (l: string) => void;
  yearFrom: string; setYearFrom: (y: string) => void;
  yearTo: string; setYearTo: (y: string) => void;
  q: string; setQ: (q: string) => void;
  sort: Sort; setSort: (s: Sort) => void;
  searchQuery: string; setSearchQuery: (s: string) => void;
  searchMode: SearchMode; setSearchMode: (m: SearchMode) => void;
  /** False until the mount-time restore has run. Gates the write-back (so an
   *  empty initial state can't wipe a deep link) and the search tab's
   *  one-shot deep-link auto-search. */
  restored: boolean;
}

export function useLibraryUrlState(): LibraryUrlState {
  const [tab, setTab] = useState<Tab>('tracks');
  const [trackMode, setTrackMode] = useState<TrackMode>('all');

  const [moods, setMoods] = useState<string[]>([]);
  const [energy, setEnergy] = useState<Energy>('any');
  const [vocal, setVocal] = useState<Vocal>('any');
  const [genre, setGenre] = useState<string>('');
  const [language, setLanguage] = useState<string>('');
  const [yearFrom, setYearFrom] = useState<string>('');
  const [yearTo, setYearTo] = useState<string>('');
  const [q, setQ] = useState<string>('');
  const [sort, setSort] = useState<Sort>('artist');

  const [searchQuery, setSearchQuery] = useState('');
  const [searchMode, setSearchMode] = useState<SearchMode>('library');

  const [restored, setRestored] = useState(false);

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const t = sp.get('tab');
    // Legacy links: Recent/Untagged are now Tracks modes, Playlists its own screen.
    if (t === 'untagged') { setTab('tracks'); setTrackMode('needs'); }
    else if (t === 'recent') setTab('tracks');
    else if (t === 'playlists') { window.location.replace('/admin/playlists'); return; }
    else if (t && (TABS as string[]).includes(t)) setTab(t as Tab);
    const view = sp.get('view');
    if (view === 'needs') { setTab('tracks'); setTrackMode('needs'); }
    else if (view === 'liked') { setTab('tracks'); setTrackMode('liked'); }
    const m = (sp.get('moods') || '').split(',').map(s => s.trim()).filter(Boolean);
    if (m.length) setMoods(m);
    const en = sp.get('energy');
    if (en === 'low' || en === 'medium' || en === 'high') setEnergy(en);
    const vo = sp.get('vocal');
    if (vo === 'vocal' || vo === 'instrumental') setVocal(vo);
    const g = sp.get('genre');
    if (g) setGenre(g);
    const lang = sp.get('language');
    if (lang) setLanguage(lang);
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
    setRestored(true);
  }, []);

  useEffect(() => {
    if (!restored) return;
    const sp = new URLSearchParams();
    if (tab !== 'tracks') sp.set('tab', tab);
    if (tab === 'tracks' && trackMode !== 'all') sp.set('view', trackMode);
    if (moods.length) sp.set('moods', moods.join(','));
    if (energy !== 'any') sp.set('energy', energy);
    if (vocal !== 'any') sp.set('vocal', vocal);
    if (genre) sp.set('genre', genre);
    if (language) sp.set('language', language);
    if (yearFrom) sp.set('from', yearFrom);
    if (yearTo) sp.set('to', yearTo);
    if (q.trim()) sp.set('q', q.trim());
    if (sort !== 'artist') sp.set('sort', sort);
    if (searchQuery.trim()) sp.set('sq', searchQuery.trim());
    if (searchMode === 'sound') sp.set('smode', 'sound');
    const qs = sp.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`);
  }, [restored, tab, trackMode, moods, energy, vocal, genre, language, yearFrom, yearTo, q, sort, searchQuery, searchMode]);

  return {
    tab, setTab, trackMode, setTrackMode,
    moods, setMoods, energy, setEnergy, vocal, setVocal, genre, setGenre, language, setLanguage,
    yearFrom, setYearFrom, yearTo, setYearTo, q, setQ, sort, setSort,
    searchQuery, setSearchQuery, searchMode, setSearchMode,
    restored,
  };
}

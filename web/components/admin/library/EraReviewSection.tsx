'use client';

// Era review: the albums whose release year the walk refuses to take as
// the recordings' year. Each album gets a KIND (pre-filled from its title, set
// here) and a DECISION, and the decision is what takes it out of "To review":
//   - Year is right: every track uses its file year;
//   - One year: that year becomes every track's hand-set year, for good;
//   - Per track: each track keeps its own looked-up or hand-set year — the
//     album leaves the list once every track has one (edit them inline).
// "Decided" keeps every handled album, for undoing. The detector's reason
// (why the album looked suspect) is a small hint only: several kinds share it.
import { Fragment, useEffect, useMemo, useState } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { CalendarClock, ChevronDown, ChevronRight, Download, Search } from 'lucide-react';
import { adminJson, adminResponse } from '../../../lib/admin-query';
import { notify } from '../../../lib/notify';
import { cn } from '../../../lib/cn';
import { ALBUM_KINDS, ALBUM_KIND_LABELS, type AlbumKind, type EraVerdict } from '../../../lib/schemas.generated';
import { Btn, Pill } from '../ui';
import { Input } from '../../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select';
import { formatTrackLength, shortFolder, yearTargets } from './era-display';
import { eraYearError, eraYearInputProps, eraYearInvalid, parseEraYear } from './era-year';
import { SEARCH_ENGINES, buildSearchUrl, searchTermsOf, isSearchEngine, loadSearchEngine, saveSearchEngine, type SearchEngine } from './era-search';
import { applyEraYearEvent, libraryKeys } from './queries';
import { useLibrary } from './LibraryContext';
import { useAdminMutation, useAdminQuery } from './useAdminQuery';

// The decision list is the controller's (schemas/library.ts ERA_VERDICTS).
type Verdict = EraVerdict;

export interface EraAlbum {
  albumKey: string;
  album: string | null;
  albumArtist: string | null;
  reason: string | null;
  tracks: number;
  yearResolved: number;
  yearNotFound: number;
  yearUnchecked: number;
  year: number | null;
  overridden: boolean;
  /** False until a library scan has judged the album since the update. */
  scanned: boolean;
  verdict: Verdict | null;
  forcedYear: number | null;
  kind: AlbumKind | null;
  /** The operator chose the kind; false = the title's suggestion. */
  kindSet: boolean;
  suggestedVerdict: Verdict | null;
  /** Out of "To review". */
  done: boolean;
  /** The folder holding most of the album's files. */
  mainFolder: string | null;
  /** Files that are another copy of a recording already listed. */
  copies: number;
}

export interface EraSummary {
  albums: number;
  tracks: number;
  byReason: Record<string, number>;
  overridden: number;
}

interface EraTrack {
  id: string;
  title: string | null;
  artist: string | null;
  year: number | null;
  originalYear: number | null;
  originalYearSource: string | null;
  yearState: 'resolved' | 'not found' | 'unchecked';
  durationSec: number | null;
  fileName: string | null;
  /** Set only when the file is outside the album's main folder. */
  folder: string | null;
  /** Other copies of the same recording; a year set here goes to them too. */
  copies: Array<{ id: string; folder: string | null }>;
}

interface EraResponse { albums: EraAlbum[]; summary: EraSummary }
interface WriteResponse { ok: boolean; affected: number }

const NO_ALBUMS: EraAlbum[] = [];
const NO_KIND = '__none';

// Why the detector flagged it, in the operator's words. Various Artists and
// many artists are one signal here: several artists on the record.
const REASON_LABEL: Record<string, string> = {
  'compilation-flag': 'compilation tag',
  'various-artists': 'several artists',
  'many-artists': 'several artists',
  'title-compilation': 'best-of title',
  'title-year-range': 'year range in title',
};
const REASON_HINT: Record<string, string> = {
  'compilation-flag': "The files carry a compilation tag (COMPILATION / iTunes 'cpil'), so Navidrome marks the album a compilation.",
  'various-artists': "Several artists: the album artist is 'Various Artists'.",
  'many-artists': 'Several artists: no lead artist dominates (at least 5 different leads over 8+ tracks, none on 30% of them).',
  'title-compilation': "The title reads like a compilation: 'Best of', 'Greatest Hits', 'Anthology', 'The Collection', 'Rarities', a DJ mix… (checked before a year range, so it wins).",
  'title-year-range': "The title spans years, like 'Singles 1968-1974'.",
};

const DECISION_LABEL: Record<Verdict, string> = { trusted: 'Year is right', year: 'One year', suspect: 'Per track' };
const DECISION_HINT: Record<Verdict, string> = {
  trusted: "Every track uses its file year (an original album, a dated compilation whose tracks are that year's).",
  year: 'One year for every track, set by hand and kept for good: no lookup overwrites it, and tracks added later get it too.',
  suspect: 'Each track keeps its own year, looked up or set by hand. The album leaves the list once every track has one.',
};

const yearTally = (a: EraAlbum) => {
  const missing = a.yearNotFound + a.yearUnchecked;
  return missing ? `${a.yearResolved}/${a.tracks} years known` : `all ${a.tracks} years known`;
};

type View = 'review' | 'decided';

export default function EraReviewSection() {
  const { adminFetch } = useLibrary();
  const [filter, setFilter] = useState('');
  const [view, setView] = useState<View>('review');
  const [kindPick, setKindPick] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [yearDraft, setYearDraft] = useState<Record<string, string>>({});
  // Read after mount: localStorage does not exist on the server render.
  const [engine, setEngine] = useState<SearchEngine>('google');
  useEffect(() => { setEngine(loadSearchEngine()); }, []);

  const data = useAdminQuery<EraResponse>({ key: libraryKeys.era(), path: '/library/era', toastOnError: true });

  const refresh = async (qc: QueryClient) => {
    // A decision flips era_untrusted or writes years on every row of the album,
    // which the browse filters and coverage tallies read too.
    await Promise.all([
      qc.invalidateQueries({ queryKey: libraryKeys.era() }),
      qc.invalidateQueries({ queryKey: libraryKeys.rows }),
      qc.invalidateQueries({ queryKey: libraryKeys.coverage() }),
    ]);
  };

  const decide = useAdminMutation<WriteResponse, { album: string; albumArtist: string | null; verdict: Verdict | null; year?: number }>({
    request: (vars, fetcher) => adminJson<WriteResponse>(fetcher, '/library/era/override', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(vars),
    }),
    onDone: async (out, vars, qc) => {
      const n = `${out.affected} track${out.affected === 1 ? '' : 's'}`;
      notify.ok(vars.verdict === null
        ? `Decision removed: ${n} back to the library scan's verdict`
        : `Saved: ${DECISION_LABEL[vars.verdict]}${vars.verdict === 'year' ? ` ${vars.year}` : ''} · ${n} changed`);
      await refresh(qc);
    },
  });

  const setKind = useAdminMutation<WriteResponse, { album: string; albumArtist: string | null; kind: AlbumKind | null }>({
    request: (vars, fetcher) => adminJson<WriteResponse>(fetcher, '/library/era/kind', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(vars),
    }),
    onDone: async (_out, vars, qc) => {
      notify.ok(vars.kind ? `Saved: ${ALBUM_KIND_LABELS[vars.kind]}` : 'Kind cleared: back to the title suggestion');
      await refresh(qc);
    },
  });

  const pending = decide.isPending || setKind.isPending;
  const run = (a: EraAlbum, fn: () => void) => {
    if (pending) return; // one save at a time; clicks are ignored while pending
    setBusyKey(a.albumKey);
    fn();
  };
  const settle = { onSettled: () => setBusyKey(null) };
  const post = (a: EraAlbum, verdict: Verdict | null, year?: number) =>
    run(a, () => decide.mutate({ album: a.album ?? '', albumArtist: a.albumArtist, verdict, ...(year != null && { year }) }, settle));
  const postKind = (a: EraAlbum, kind: AlbumKind | null) =>
    run(a, () => setKind.mutate({ album: a.album ?? '', albumArtist: a.albumArtist, kind }, settle));
  const postYear = (a: EraAlbum) => {
    const y = parseEraYear(yearDraft[a.albumKey] ?? String(a.forcedYear ?? a.year ?? ''));
    if (y == null) { notify.err(eraYearError()); return; }
    post(a, 'year', y);
  };

  const [downloading, setDownloading] = useState(false);
  const downloadCsv = async () => {
    setDownloading(true);
    try {
      // admin-query-imperative: era-csv-export
      const r = await adminResponse(adminFetch, '/library/era/csv');
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'era-suspects.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      notify.err(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading(false);
    }
  };

  const albums = data.data?.albums ?? NO_ALBUMS;
  const inView = useMemo(() => albums.filter(a => (view === 'decided' ? a.done : !a.done)), [albums, view]);
  const counts = useMemo(() => ({
    review: albums.filter(a => !a.done).length,
    decided: albums.filter(a => a.done).length,
  }), [albums]);
  const kindCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of inView) m.set(a.kind ?? NO_KIND, (m.get(a.kind ?? NO_KIND) ?? 0) + 1);
    return m;
  }, [inView]);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return inView.filter(a => {
      if (kindPick && (a.kind ?? NO_KIND) !== kindPick) return false;
      return !q || (a.album ?? '').toLowerCase().includes(q) || (a.albumArtist ?? '').toLowerCase().includes(q);
    });
  }, [inView, filter, kindPick]);

  const switchView = (v: View) => { setView(v); setKindPick(null); };

  return (
    <div className="grid gap-3 border border-ink bg-bg p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-ink">
          <CalendarClock size={13} /> Era review
        </span>
        <Pill tone={view === 'review' ? 'accent' : 'ink'} pressed={view === 'review'} onClick={() => switchView('review')}
          title="Albums still waiting for a decision, or for track years">
          to review: {counts.review}
        </Pill>
        <Pill tone={view === 'decided' ? 'accent' : 'ink'} pressed={view === 'decided'} onClick={() => switchView('decided')}
          title="Albums you decided on, or whose every track has a year: normal entries, kept here so you can undo">
          decided: {counts.decided}
        </Pill>
        <span className="ml-auto flex items-center gap-2">
          <Select value={engine} onValueChange={v => { if (isSearchEngine(v)) { setEngine(v); saveSearchEngine(v); } }}>
            <SelectTrigger className="h-7 w-[150px] text-xs" title="Where a track's Search button looks (remembered in this browser)">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SEARCH_ENGINES) as SearchEngine[]).map(k => (
                <SelectItem key={k} value={k}>Search: {SEARCH_ENGINES[k].label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Btn sm onClick={downloadCsv} disabled={downloading} title="Every track on an era-suspect album, as CSV">
            <Download size={13} /> {downloading ? 'Preparing…' : 'Download CSV'}
          </Btn>
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="caption">kind:</span>
        {[...ALBUM_KINDS, NO_KIND].filter(k => kindCounts.has(k)).map(k => (
          <Pill key={k} tone={kindPick === k ? 'accent' : 'ink'} pressed={kindPick === k}
            onClick={() => setKindPick(cur => (cur === k ? null : k))}>
            {k === NO_KIND ? 'unclassified' : ALBUM_KIND_LABELS[k as AlbumKind]}: {kindCounts.get(k)}
          </Pill>
        ))}
      </div>

      <span className="caption !tracking-[0.04em] !normal-case">
        Set what each album is, then how its tracks get their year: <b>Year is right</b>, <b>One year</b> for every
        track, or <b>Per track</b> (open the album to type the missing ones). A decided album is a normal entry
        again. Saved as soon as you click.
      </span>

      <Input
        className="h-7 w-full max-w-xs px-2 text-xs"
        placeholder="Filter by album or artist…"
        value={filter}
        aria-label="Filter era-suspect albums"
        onChange={e => setFilter(e.currentTarget.value)}
      />

      {data.isPending ? (
        <span className="caption">loading…</span>
      ) : shown.length === 0 ? (
        <span className="caption">
          {albums.length === 0
            ? 'No era-suspect albums. The walk flags compilations, various-artist releases and titles like “Best of” or “Singles 1968-1974”.'
            : view === 'review' && !kindPick && !filter ? 'Nothing left to review.' : 'No album matches this filter.'}
        </span>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-[12px]">
            <thead>
              <tr className="caption text-left">
                <th className="py-1 pr-3 font-bold">Album — artist</th>
                <th className="py-1 pr-3 font-bold">Kind</th>
                <th className="py-1 pr-3 font-bold">Years</th>
                <th className="py-1 font-bold">Decision</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(a => {
                const blocked = !a.scanned || !a.album;
                const open = openKey === a.albumKey;
                return (
                  <Fragment key={a.albumKey}>
                    <tr className="border-t border-ink align-middle">
                      <td className="max-w-[300px] py-1.5 pr-3">
                        <button type="button" className="flex max-w-full items-start gap-1 text-left"
                          onClick={() => setOpenKey(open ? null : a.albumKey)} aria-expanded={open}
                          title={open ? 'Hide the tracks' : 'Show the tracks and their years'}>
                          {open ? <ChevronDown size={13} className="mt-0.5 shrink-0" /> : <ChevronRight size={13} className="mt-0.5 shrink-0" />}
                          <span className="min-w-0">
                            <span className="block truncate text-ink">{a.album ?? '(no album tag)'}</span>
                            <span className="caption block truncate">
                              {a.albumArtist ?? '(no album artist)'}{a.year != null ? ` · ${a.year}` : ''} · {a.tracks} tracks
                              {a.copies > 0 && ` (${a.copies} ${a.copies === 1 ? 'is a copy' : 'are copies'})`}
                            </span>
                            {a.mainFolder && (
                              <span className="caption block truncate" title={a.mainFolder}>📁 {shortFolder(a.mainFolder, 3)}</span>
                            )}
                          </span>
                        </button>
                        {a.reason && (
                          <span className="caption mt-0.5 block pl-4" title={REASON_HINT[a.reason]}>
                            flagged: {REASON_LABEL[a.reason] ?? a.reason}
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 pr-3">
                        <Select value={a.kind ?? NO_KIND} disabled={blocked || pending}
                          onValueChange={v => postKind(a, v === NO_KIND ? null : (v as AlbumKind))}>
                          <SelectTrigger className={a.kindSet ? 'h-7 w-[170px] text-xs' : 'h-7 w-[170px] text-xs italic'}
                            aria-label={`Kind of ${a.album ?? 'album'}`}
                            title={a.kindSet ? 'Set by you' : 'Suggested from the title: pick one to confirm or correct it'}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NO_KIND}>{a.kindSet ? 'use the title suggestion' : 'unclassified'}</SelectItem>
                            {ALBUM_KINDS.map(k => <SelectItem key={k} value={k}>{ALBUM_KIND_LABELS[k]}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        {!a.kindSet && a.kind && <span className="caption mt-0.5 block">suggested</span>}
                      </td>
                      <td className="caption py-1.5 pr-3 whitespace-nowrap">{yearTally(a)}</td>
                      <td className="py-1.5">
                        {blocked ? (
                          <span className="caption">{!a.album ? 'no album tag' : 'run a library scan (Reconcile) first'}</span>
                        ) : (
                          <span className="flex flex-wrap items-center gap-1.5">
                            <Btn sm tone={a.verdict === 'trusted' ? 'accent' : undefined} disabled={pending || a.verdict === 'trusted'}
                              onClick={() => post(a, 'trusted')} title={DECISION_HINT.trusted}>
                              {DECISION_LABEL.trusted}
                            </Btn>
                            <span className="inline-flex items-center gap-1">
                              <Input className={`h-7 w-[68px] px-1.5 text-xs${eraYearInvalid(yearDraft[a.albumKey] ?? '') ? ' border-[var(--danger)]' : ''}`}
                                aria-label={`One year for every track of ${a.album}`}
                                value={yearDraft[a.albumKey] ?? String(a.forcedYear ?? a.year ?? '')}
                                {...eraYearInputProps(
                                  yearDraft[a.albumKey] ?? String(a.forcedYear ?? a.year ?? ''),
                                  a.forcedYear ?? a.year,
                                  v => setYearDraft(d => ({ ...d, [a.albumKey]: v })),
                                )} />
                              <Btn sm tone={a.verdict === 'year' ? 'accent' : undefined} disabled={pending}
                                onClick={() => postYear(a)} title={DECISION_HINT.year}>
                                {DECISION_LABEL.year}
                              </Btn>
                            </span>
                            <Btn sm tone={a.verdict === 'suspect' ? 'accent' : undefined} disabled={pending || a.verdict === 'suspect'}
                              onClick={() => { post(a, 'suspect'); setOpenKey(a.albumKey); }} title={DECISION_HINT.suspect}>
                              {DECISION_LABEL.suspect}
                            </Btn>
                            {a.verdict && (
                              <Btn sm disabled={pending} onClick={() => post(a, null)}
                                title="Drop the decision and go back to the library scan's verdict">Reset</Btn>
                            )}
                            {!a.verdict && a.suggestedVerdict && (
                              <span className="caption">suggested: {DECISION_LABEL[a.suggestedVerdict]}</span>
                            )}
                            {busyKey === a.albumKey && <span className="caption">saving…</span>}
                          </span>
                        )}
                      </td>
                    </tr>
                    {open && !blocked && (
                      <tr className="align-top">
                        <td colSpan={4} className="pb-3 pl-5">
                          <AlbumTracks album={a} engine={engine} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  manual: 'set by hand', musicbrainz: 'MusicBrainz', 'album-tag': 'album tag',
};

// One album's tracks with their recording years; a missing or wrong one is
// typed in place (the Library's own hand-set year, POST /library/original-year).
function AlbumTracks({ album, engine }: { album: EraAlbum; engine: SearchEngine }) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const q = new URLSearchParams({ album: album.album ?? '', albumArtist: album.albumArtist ?? '' });
  const tracks = useAdminQuery<{ tracks: EraTrack[] }>({
    key: libraryKeys.eraAlbum(album.albumKey),
    path: `/library/era/album?${q}`,
    toastOnError: true,
  });
  // A year goes to the entry and to every copy folded under it, one call each
  // (the route sets one track), in order so a failure stops the rest. One Set
  // saves every line with a year typed in, so several can be filled in first.
  const save = useAdminMutation<{ ok: boolean }, { groups: Array<{ entryId: string; ids: string[]; originalYear: number | null }> }>({
    request: async (vars, fetcher) => {
      for (const g of vars.groups) {
        for (const id of g.ids) {
          await adminJson<{ ok: boolean }>(fetcher, '/library/original-year', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, originalYear: g.originalYear, applyToAlbum: false }),
          });
        }
      }
      return { ok: true };
    },
    onDone: async (_out, vars, qc) => {
      const ids = vars.groups.flatMap(g => g.ids);
      const lines = vars.groups.length;
      const cleared = vars.groups.every(g => g.originalYear == null);
      notify.ok(cleared
        ? `Year cleared${ids.length > 1 ? ` (${ids.length} copies)` : ''}`
        : lines > 1
          ? `${lines} years saved${ids.length > lines ? ` (${ids.length} files with copies)` : ''}`
          : `Year ${vars.groups[0]?.originalYear} saved${ids.length > 1 ? ` (${ids.length} copies)` : ''}`);
      for (const g of vars.groups) applyEraYearEvent(qc, { originalYear: g.originalYear, trackIds: g.ids });
      setDraft(d => {
        const next = { ...d };
        for (const g of vars.groups) delete next[g.entryId];
        return next;
      });
      await qc.invalidateQueries({ queryKey: libraryKeys.era() });
    },
  });
  const rowsNow = tracks.data?.tracks ?? [];
  // Lines with something typed in: what any Set saves.
  const pending = rowsNow.filter(t => (draft[t.id] ?? '').trim() !== '');
  const commitAll = () => {
    if (save.isPending || pending.length === 0) return;
    // All or nothing: a typo stops the save, so no line is half committed.
    const bad = pending.filter(t => parseEraYear(draft[t.id]) == null);
    if (bad.length) {
      notify.err(`${eraYearError()}${bad.length > 1 ? ` (${bad.length} lines)` : ''}: ${bad.map(t => t.title ?? '?').slice(0, 3).join(', ')}`);
      return;
    }
    save.mutate({
      groups: pending.map(t => ({ entryId: t.id, ids: yearTargets(t), originalYear: parseEraYear(draft[t.id]) as number })),
    });
  };
  const setLabel = pending.length > 1 ? `Set ${pending.length}` : 'Set';
  // An empty field's spinner starts from the track's own recording year when
  // it has one, else the album's year, else the file's.
  const yearProps = (t: EraTrack) =>
    eraYearInputProps(draft[t.id] ?? '', t.originalYear ?? album.year ?? t.year, v => setDraft(d => ({ ...d, [t.id]: v })));
  const searchUrl = (t: EraTrack) => buildSearchUrl(engine, { artist: t.artist, title: t.title });

  if (tracks.isPending) return <span className="caption">loading tracks…</span>;
  const rows = rowsNow;
  return (
    <table className="w-full border-collapse text-[11px]">
      <tbody>
        {rows.map(t => (
          <tr key={t.id} className="border-t border-[var(--separator)]">
            <td className="max-w-[320px] py-1 pr-3">
              <span className="block truncate" title={t.fileName ?? undefined}>
                {t.title ?? '(untitled)'} <span className="caption">— {t.artist ?? '?'}{t.durationSec ? ` · ${formatTrackLength(t.durationSec)}` : ''}</span>
              </span>
              {t.fileName && <span className="caption block truncate" title={t.folder ?? album.mainFolder ?? undefined}>{t.folder ? `${shortFolder(t.folder)}/` : ''}{t.fileName}</span>}
              {t.copies.length > 0 && (
                <span className="caption block truncate" title={t.copies.map(c => c.folder ?? '').join('\n')}>
                  also in {t.copies.map(c => shortFolder(c.folder)).join(', ')}
                </span>
              )}
            </td>
            <td className="caption py-1 pr-3 whitespace-nowrap">file {t.year ?? '—'}</td>
            <td className="py-1 pr-3 whitespace-nowrap">
              {t.originalYear != null
                ? <>{t.originalYear} <span className="caption">({SOURCE_LABEL[t.originalYearSource ?? ''] ?? t.originalYearSource})</span></>
                : <span className="caption">{t.yearState === 'not found' ? 'not found' : 'not looked up yet'}</span>}
            </td>
            <td className="py-1">
              <span className="inline-flex items-center gap-1">
                <Input className={cn('h-6 w-[64px] px-1.5 text-[11px]',
                  // Red for a typo; the accent outline marks the lines still waiting for a year.
                  eraYearInvalid(draft[t.id]) ? 'border-[var(--danger)]'
                    : t.originalYear == null ? 'border-[var(--accent)] ring-1 ring-[var(--accent)]' : null)}
                  aria-label={`Recording year of ${t.title}`}
                  value={draft[t.id] ?? ''}
                  {...yearProps(t)}
                  onKeyDown={e => { if (e.key === 'Enter') commitAll(); else yearProps(t).onKeyDown(e); }} />
                <Btn sm disabled={save.isPending || pending.length === 0} onClick={commitAll}
                  title={pending.length > 1 ? `Save the ${pending.length} years typed in this album` : 'Save the year typed in'}>{setLabel}</Btn>
                {t.originalYearSource === 'manual' && (
                  <Btn sm disabled={save.isPending} onClick={() => save.mutate({ groups: [{ entryId: t.id, ids: yearTargets(t), originalYear: null }] })}
                    title="Clear the hand-set year on this line only; the lookups take the track back">Clear</Btn>
                )}
                <Btn sm onClick={() => window.open(searchUrl(t), '_blank', 'noopener,noreferrer')}
                  title={`Search ${SEARCH_ENGINES[engine].label} for ${searchTermsOf(engine, { artist: t.artist, title: t.title })} in a new tab`}>
                  <Search size={11} aria-hidden /> Search
                </Btn>
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

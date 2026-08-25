'use client';

// Show definitions. A scheduled show puts its persona on air and overrides the
// autonomous mood (empty moods = Any/auto); an empty hour runs autonomously.
// The weekly plan lives at /admin/shows/schedule, which owns the board and
// PUT /schedule — this page loads the schedule read-only for the hours-a-week
// counts. Putting a show on air right now is a takeover, and lives on the dash.
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { z } from 'zod';
import {
  useFieldArray,
  type Control,
  type FieldErrors,
  type UseFormGetValues,
  type UseFormReset,
  type UseFormSetValue,
  type UseFormTrigger,
  type UseFormWatch,
} from 'react-hook-form';
import { Users, Share2 } from 'lucide-react';
import { useAdminAuth } from '../../lib/adminAuth';
import { notify, errorMessage } from '../../lib/notify';
import { AdminResponseError, adminJson, useAdminMutation } from '../../lib/admin-query';
import { useZodForm, applyServerFieldErrors } from '@/lib/form';
import { showSchema, type ShowSchemaContext } from '@/lib/schemas.generated';
import { Button } from '../ui/button';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../ui/select';
import { Card, Btn, Pill, Eyebrow, Metric } from './ui';
import RosterViewToggle from './RosterViewToggle';
import RosterToolbar from './RosterToolbar';
import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { V3AlertDialog } from '../ui/alert-dialog';
import { Modal } from '../ui/modal';
import ShowsTable from './shows/ShowsTable';
import { useRosterView, useRosterSort } from '../../lib/adminView';
import { showSubmitUrl } from '../../lib/repo';
import { ShowDefRow } from './shows/ShowDefRow';
import { ShowEditor } from './shows/ShowEditor';
import { clientMintId, emptyWeek, hydrateShow, showContext, showPayload, showRow } from './shows/lib';
import type {
  CommunityShow,
  Persona,
  PlaylistIndexStatus,
  Schedule,
  SettingsResponse,
  Show,
  ShowsFormValues,
  SkillOption,
} from './shows/types';
import { SHOWS_MAX } from './shows/types';
// Radix Select forbids an empty-string item value, so "all hosts" travels as a
// sentinel and is mapped back to '' — the same shape ANY_SENTINEL takes in the
// show editor's own pickers.
const ANY_HOST = '__any_host__';
import {
  SHOW_SORTS,
  SHOW_SORT_LABELS,
  orderShowRoster,
  showFilterActive,
  showTagVocabulary,
  type ShowSort,
} from './shows/roster-order';
import { useSettingsQuery } from './settings/queries';
import {
  patchShowSettings,
  useCommunityShowsQuery,
  useShowGenresQuery,
  useShowPlaylistsQuery,
  useShowSkillsQuery,
} from './shows/queries';
import { useAdminThemesQuery } from './themes-queries';

// `showSchema` is a factory (a show can't be validated against itself — it has
// to name a real persona, mood and theme), so the resolver is rebuilt whenever
// `showCtx` changes identity rather than built once at module scope. `schedule`
// is deliberately not part of the shape: this panel only reads it, for the
// hours-a-week counts.
function showsFormSchema(ctx: ShowSchemaContext) {
  return z.object({ shows: z.array(showSchema(ctx)) });
}

function showWriteError(error: unknown): string {
  if (error instanceof AdminResponseError) {
    return typeof error.body.error === 'string' && error.body.error
      ? error.body.error
      : `failed (${error.status})`;
  }
  return errorMessage(error);
}

export default function ShowsPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [schedule, setSchedule] = useState<Schedule>(emptyWeek());
  const [communityOpen, setCommunityOpen] = useState(false);          // catalog modal open?
  const [view, setView] = useRosterView('shows');
  // Sort is remembered per browser; the filters deliberately are not — see
  // useRosterSort's note on why a filter that survives a reload is worse than
  // one you have to set again.
  const [sort, setSort] = useRosterSort<ShowSort>('shows', SHOW_SORTS, 'az');
  const [query, setQuery] = useState('');
  const [tagSel, setTagSel] = useState<string[]>([]);
  const [hostSel, setHostSel] = useState('');

  // Shows are edited in place — no modal, no draft copy; edits land straight on
  // the RHF field array and persist on Save show. null = none open.
  const [focusIdx, setFocusIdx] = useState<number | null>(null);
  // The AI-draft field shows only while creating.
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const scrollToEditorRef = useRef(false);
  // Both the list ✕ and the editor's Remove route through this, so deletes
  // always need confirming.
  const [confirmDeleteIdx, setConfirmDeleteIdx] = useState<number | null>(null);
  const queryEnabled = hydrated && !needsAuth;
  const settingsQuery = useSettingsQuery<SettingsResponse>({ adminFetch, enabled: queryEnabled });
  const themesQuery = useAdminThemesQuery(adminFetch, queryEnabled);
  const skillsQuery = useShowSkillsQuery(adminFetch, queryEnabled);
  const genresQuery = useShowGenresQuery(adminFetch, queryEnabled);
  const playlistsQuery = useShowPlaylistsQuery(adminFetch, queryEnabled);
  const communityQuery = useCommunityShowsQuery(adminFetch, queryEnabled);
  const data = settingsQuery.data ?? null;
  const themes = useMemo(() => themesQuery.data?.themes ?? [], [themesQuery.data?.themes]);
  const activeThemeId = themesQuery.data?.active ?? '';
  const err = settingsQuery.error && !data ? errorMessage(settingsQuery.error) : null;
  const skills: SkillOption[] = skillsQuery.data ?? [];
  const genres = genresQuery.data ?? [];
  const playlists = playlistsQuery.data ?? [];
  const playlistsStatus: PlaylistIndexStatus = playlistsQuery.isPending
    ? 'loading'
    : playlistsQuery.isError
      ? 'error'
      : 'ready';
  // Best-effort: a failed community catalog is the same empty, usable modal as
  // before; only the initial request keeps the button disabled.
  const community: CommunityShow[] | null = communityQuery.data
    ?? (communityQuery.isError ? [] : null);
  // Guarded by scrollToEditorRef so unrelated re-renders don't yank the page.
  useEffect(() => {
    if (!scrollToEditorRef.current) return;
    scrollToEditorRef.current = false;
    editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [focusIdx]);

  const load = async (): Promise<SettingsResponse | null> => {
    const result = await settingsQuery.refetch();
    return result.data ?? null;
  };

  // Memoised because `x || []` is a fresh array every render, and showCtx
  // identity is what decides whether the resolver is rebuilt.
  const personas: Persona[] = useMemo(() => data?.values?.personas || [], [data?.values?.personas]);
  const moods: string[] = useMemo(() => data?.tts?.moods || [], [data?.tts?.moods]);
  // The four inputs the shared show schema needs, built once so the row badges,
  // the Save gate and the editor all judge a show the way the controller will.
  const showCtx = useMemo(
    () => showContext({
      personas, moods,
      themeIds: themes.map(t => t.id),
      minTrackSeconds: data?.values?.minTrackSeconds ?? null,
    }),
    [personas, moods, themes, data?.values?.minTrackSeconds],
  );
  // showSchema(ctx) builds a fresh schema per call, so keep this memoised on
  // ctx identity rather than rebuilding it every render.
  const formSchema = useMemo(() => showsFormSchema(showCtx), [showCtx]);

  const form = useZodForm(formSchema, { shows: [] });
  // showSchema's output is reached through z.preprocess/z.unknown() pipelines
  // (the legacy-field migration wraps the whole object), so z.input<> types it
  // `unknown` and no nested path would type-check as a FieldPath. Type-only
  // casts onto the shape the resolver actually produces.
  const control = form.control as unknown as Control<ShowsFormValues>;
  const setValue = form.setValue as unknown as UseFormSetValue<ShowsFormValues>;
  const getValues = form.getValues as unknown as UseFormGetValues<ShowsFormValues>;
  const watch = form.watch as unknown as UseFormWatch<ShowsFormValues>;
  const resetForm = form.reset as unknown as UseFormReset<ShowsFormValues>;
  const trigger = form.trigger as unknown as UseFormTrigger<ShowsFormValues>;

  // `keyName: '_rhfKey'` is load-bearing — shows carry their own `id`, which
  // RHF's default keyName ('id') would clobber. `fields` goes unused: renders
  // below read live values via `watch('shows')`, as PersonasPanel does.
  const { append: appendShowField, remove: removeShowField } =
    useFieldArray({ control, name: 'shows', keyName: '_rhfKey' });

  // `showCtx` changes after mount as personas/moods and themes arrive from
  // separate queries. Re-validating
  // from an effect (rather than remounting the form) is enough — RHF rewrites
  // `control._options` on every render, so by the time this runs `trigger()`
  // reads the current resolver. Without it every valid show reads as
  // "incomplete" after load; verify-forms.py's shows() covers the regression.
  useEffect(() => {
    void form.trigger();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCtx]);

  // Server cache revisions must not reset a half-edited show. A remount starts
  // from the latest cache entry; this mounted form hydrates exactly once.
  const formHydratedRef = useRef(false);
  useEffect(() => {
    if (!data?.values || formHydratedRef.current) return;
    formHydratedRef.current = true;
    const week = emptyWeek();
    const sched: Schedule | Record<string, (string | null)[]> = data.values.schedule || {};
    for (let d = 0; d < 7; d++) {
      const day = (sched as Record<number, (string | null)[] | undefined>)[d];
      if (Array.isArray(day)) for (let h = 0; h < 24; h++) week[d]![h] = day[h] ?? null;
    }
    setSchedule(week);
    resetForm({ shows: (data.values.shows || []).map(hydrateShow) });
    // Unlike the old imperative loader, the query data and its showCtx land in
    // the same render. The ctx effect above therefore runs before this reset;
    // validate the newly-hydrated rows once with that render's current schema.
    void trigger();
  }, [data, resetForm, trigger]);

  const apiBase = (process.env.NEXT_PUBLIC_API_URL as string | undefined) || '/api';
  const personaName = (id: string): string => personas.find(p => p.id === id)?.name || '—';

  const deleteShowMutation = useAdminMutation<{
    shows: Array<Partial<Show>>;
    schedule: Schedule;
  } | null, string>({
    adminFetch,
    request: async (id, fetcher) => {
      try {
        return await adminJson(fetcher, `/shows/${encodeURIComponent(id)}`, { method: 'DELETE' });
      } catch (error) {
        if (error instanceof AdminResponseError && error.status === 404) return null;
        throw error;
      }
    },
    onDone: (result, _id, client) => {
      if (result) patchShowSettings(client, result);
    },
    toastOnError: false,
  });

  const installShowMutation = useAdminMutation<{
    shows?: Array<Partial<Show>>;
    show?: Partial<Show> | null;
  }, string>({
    adminFetch,
    request: (slug, fetcher) => adminJson(
      fetcher,
      `/shows/community/${encodeURIComponent(slug)}/install`,
      { method: 'POST' },
    ),
    onDone: (result, _slug, client) => {
      if (result.shows) patchShowSettings(client, { shows: result.shows });
    },
    toastOnError: false,
  });

  const saveShowMutation = useAdminMutation<{
    shows?: Array<Partial<Show>>;
    show?: Partial<Show> | null;
  }, { show: Show }>({
    adminFetch,
    request: ({ show }, fetcher) => adminJson(fetcher, '/shows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ show: showPayload(show) }),
    }),
    onDone: (result, _vars, client) => {
      if (result.shows) patchShowSettings(client, { shows: result.shows });
    },
    toastOnError: false,
  });
  const installing = installShowMutation.isPending ? installShowMutation.variables : null;
  const busy = saveShowMutation.isPending;

  const focusShow = (i: number) => { scrollToEditorRef.current = true; setCreatingId(null); setFocusIdx(i); };

  // Only used by the AI-draft "apply", which hands back several fields at once;
  // every keystroke field binds straight to `control` instead.
  const applyShowPatch = (i: number, patch: Partial<Show>) => {
    const current = getValues(`shows.${i}`);
    if (!current) return;
    setValue(`shows.${i}`, { ...current, ...patch }, { shouldDirty: true, shouldValidate: true });
  };

  // Name stays blank so the new show reads as incomplete until named.
  const addShow = () => {
    const current = getValues('shows');
    if (current.length >= SHOWS_MAX || personas.length === 0) return;
    const id = clientMintId();
    const newIdx = current.length;
    appendShowField({
      id, name: '', topic: '',
      personaId: personas[0]?.id || '', guestPersonaIds: [], banter: false, moods: [],
      themeId: '', genres: [], eras: [], energies: [], vocals: '',
      filtersStrict: false, maxTrackSeconds: null,
      playlistIds: [], playlistStrict: false, excludedPlaylistIds: [],
      programme: false, segmentSkill: '', tags: [],
    });
    // errors populate only once a field is touched, so without this the new
    // row's "incomplete" badge stays silent about why.
    void form.trigger();
    scrollToEditorRef.current = true;
    setCreatingId(id);
    setFocusIdx(newIdx);
    notify.ok('New show added — give it a name and a persona, then Save show.');
  };

  const removeShow = async (i: number) => {
    const current = getValues('shows');
    const target = current[i];
    if (!target) return;
    // Persisted immediately, not deferred to Save schedule. A 404 means a
    // locally-added show never saved server-side, so the local splice is enough.
    try {
      await deleteShowMutation.mutateAsync(target.id);
    } catch (e) {
      notify.err(`Delete failed: ${showWriteError(e)}`);
      return;
    }
    // Splice by id, resolved at call time — the await may have elapsed and
    // other rows may have shifted. Unsaved edits to other shows are preserved.
    const latest = getValues('shows');
    const idx = latest.findIndex(sh => sh.id === target.id);
    if (idx !== -1) removeShowField(idx);
    setSchedule(prev => {
      const week: Schedule = JSON.parse(JSON.stringify(prev));
      for (let d = 0; d < 7; d++)
        for (let h = 0; h < 24; h++)
          if (week[d]![h] === target.id) week[d]![h] = null;
      return week;
    });
    // Keep editor focus aligned with the shifted list.
    setFocusIdx(cur => (cur == null ? cur : cur === i ? null : cur > i ? cur - 1 : cur));
    notify.ok(`Deleted “${target.name.trim() || 'show'}”.`);
  };

  // The controller persists the install (unscheduled, owned by the active
  // persona); the returned show is appended to the local form as well so
  // unsaved edits to other shows survive.
  const install = async (slug: string) => {
    try {
      const j = await installShowMutation.mutateAsync(slug);
      const added = j.show ? hydrateShow(j.show) : null;
      if (added) {
        appendShowField(added);
        void form.trigger(); // see addShow's comment
      }
      const host = added?.personaId ? personaName(added.personaId) : 'your active DJ';
      notify.ok(`Installed “${added?.name || slug}” — added unscheduled with ${host} as host. Assign a persona/guests, then schedule it on the Rundown.`);
    } catch (e) {
      notify.err(`Install failed: ${showWriteError(e)}`);
    }
  };

  const scheduledHours = Object.values(schedule).flat().filter(Boolean).length;
  const countHours = (id: string): number => Object.values(schedule).flat().filter(c => c === id).length;

  // Persists ONE show, independent of any other half-finished show in the
  // panel — gated on THIS row's own errors, not form.formState.isValid (which
  // would require every OTHER open-but-unsaved show to be valid too).
  const saveShow = async (index: number): Promise<boolean> => {
    const s = getValues(`shows.${index}`);
    if (!s || form.formState.errors.shows?.[index]) return false;
    try {
      const j = await saveShowMutation.mutateAsync({ show: s });
      const saved = j.show ? hydrateShow(j.show) : null;
      if (saved) setValue(`shows.${index}`, saved, { shouldDirty: true, shouldValidate: true });
      notify.ok('Show saved.');
      return true;
    } catch (e) {
      if (e instanceof AdminResponseError && e.body.fieldErrors) {
        // POST /shows sends ONE show, so refusals come back keyed `show.<field>`
        // and need remapping onto this row's own field-array path.
        const remapped: Record<string, string> = {};
        for (const [key, value] of Object.entries(e.body.fieldErrors)) {
          if (typeof value === 'string') {
            remapped[key.replace(/^show\./, `shows.${index}.`)] = value;
          }
        }
        applyServerFieldErrors(form, remapped);
      }
      notify.err(showWriteError(e));
      return false;
    }
  };

  if (err) {
    return (
      <div className="grid gap-4">
        <Card title="Shows" sub="definitions">
          <ErrorState error={err} onRetry={load} />
        </Card>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="grid gap-4">
        <Card title="Shows" sub="definitions">
          <SkeletonRows rows={4} />
        </Card>
      </div>
    );
  }

  const shows = watch('shows');
  // focusIdx can briefly point past the end after a removal, so an out-of-range
  // index coerces to "nothing open".
  const focused = focusIdx != null ? (shows[focusIdx] ?? null) : null;
  // Same type-only cast as `control`/`setValue` above.
  const focusedErrors = (focusIdx != null ? form.formState.errors.shows?.[focusIdx] : undefined) as
    FieldErrors<Show> | undefined;

  // Display order only — every entry carries its form-array `index`, which is
  // what focusShow, Save show and delete key off. See shows/roster-order.ts.
  const filter = { query, tags: tagSel, personaId: hostSel };
  const filterOn = showFilterActive(filter);
  const allTags = showTagVocabulary(shows);
  const entries = orderShowRoster(shows, { sort, filter, personas, hoursFor: countHours });
  const clearFilters = () => { setQuery(''); setTagSel([]); setHostSel(''); };
  // Suggestions come from the WHOLE list, not the filtered view: the point of
  // offering them is to converge on one vocabulary, and a filtered list would
  // hide exactly the tags the operator should be reusing.
  const tagSuggestions = allTags;

  return (
    <div className="grid gap-4">
      <section className="card">
        <div className="stack-mobile grid grid-cols-[1fr_auto] items-center gap-4 p-4">
          <div>
            <Eyebrow className="text-vermilion">show plan · the rundown</Eyebrow>
            <div className="mt-1.5 text-[22px] font-extrabold tracking-[-0.02em]">
              Build your shows here. Put them on the air on the Rundown.
            </div>
            <div className="mt-1 max-w-[62ch] text-[11px] leading-[1.6] text-muted">
              This page is the roster — each show&apos;s name, host, brief, and
              sound. The Rundown is the week itself: the board and the on-air
              listing, hour by hour.
            </div>
          </div>
          <div className="flex flex-none flex-col items-start gap-2.5 sm:items-end">
            <div className="flex gap-4">
              <Metric n={String(scheduledHours)} l="hours scheduled" />
              <Metric n={String(168 - scheduledHours)} l="silent" accent={scheduledHours < 168} />
            </div>
            <Button asChild variant="accent" size="sm" className="min-h-9 sm:min-h-0">
              <Link href="/admin/shows/schedule">Open the schedule →</Link>
            </Button>
          </div>
        </div>
      </section>

      {personas.length === 0 && (
        <Card title="Personas required" sub="setup">
          <div className="text-[13px] text-[var(--danger)]">
            No personas defined. Create one under Personas first.
          </div>
        </Card>
      )}

      <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
        <span className="caption">show definitions · {shows.length}/{SHOWS_MAX} shows</span>
        {/* Own line on a phone: sharing a row with the caption folds the
            Cards/List toggle into two stacked icons. */}
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap">
          <Btn
            className="min-h-9 sm:min-h-0"
            onClick={() => setCommunityOpen(true)}
            disabled={!community}
            title="Browse and install shows shared by other stations"
          >
            <Users size={14} /> Community
            {community && community.length > 0 && (
              <span className="ml-1 text-vermilion">{community.length}</span>
            )}
          </Btn>
          <Btn
            tone="accent"
            className="min-h-9 sm:min-h-0"
            onClick={addShow}
            disabled={shows.length >= SHOWS_MAX || personas.length === 0}
          >
            + Add show
          </Btn>
        </div>
      </div>
      {/* Hidden below a handful of shows: a filter bar over four rows is
          furniture, and the list this exists for is the 40-show one. */}
      {shows.length > 5 && (
        <RosterToolbar<ShowSort>
          query={query}
          onQueryChange={setQuery}
          noun="shows"
          sort={sort}
          onSortChange={setSort}
          sortOptions={SHOW_SORTS.map(k => [k, SHOW_SORT_LABELS[k]] as const)}
          tags={allTags}
          selectedTags={tagSel}
          onTagsChange={setTagSel}
          filtered={filterOn}
          onClear={clearFilters}
          view={view}
          onViewChange={setView}
          summary={filterOn ? `${entries.length} of ${shows.length}` : undefined}
          extraFilters={personas.length > 1 && (
            <Select value={hostSel || ANY_HOST} onValueChange={v => setHostSel(v === ANY_HOST ? '' : v)}>
              <SelectTrigger className="min-w-0 flex-1 sm:w-[170px] sm:flex-none" aria-label="Filter by host">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY_HOST}>All hosts</SelectItem>
                {personas.map(p => (
                  <SelectItem key={p.id} value={p.id}>{p.name?.trim() || 'Unnamed'}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
      )}
      {/* The toolbar carries the view toggle once it is on screen; below the
          threshold the header row above keeps it, so it never disappears. */}
      {shows.length > 0 && shows.length <= 5 && (
        <div className="flex justify-end">
          <RosterViewToggle view={view} onChange={setView} />
        </div>
      )}

      {shows.length === 0 && (
        <EmptyState
          title="No shows scheduled"
          description="Add one to start programming the week."
        />
      )}

      {shows.length > 0 && entries.length === 0 && (
        <EmptyState
          title="No shows match"
          description="Nothing fits the current filters."
          action={<Btn onClick={clearFilters}>Clear filters</Btn>}
        />
      )}

      {view === 'list' && entries.length > 0 && (
        <ShowsTable
          rows={entries.map(e => showRow(e.show, e.index, personas, apiBase, countHours(e.show.id), !form.formState.errors.shows?.[e.index]))}
          onEdit={r => focusShow(r.index)}
        />
      )}

      {view === 'cards' && entries.map(({ show: s, index: i }) => {
        const ok = !form.formState.errors.shows?.[i];
        const hrs = countHours(s.id);
        const host = personas.find(p => p.id === s.personaId) ?? null;
        const guests = (s.guestPersonaIds || [])
          .map(id => personas.find(p => p.id === id))
          .filter((p): p is Persona => Boolean(p));
        return (
          <ShowDefRow
            key={s.id}
            show={s}
            index={i}
            ok={ok}
            hrs={hrs}
            host={host}
            guests={guests}
            apiBase={apiBase}
            onEdit={() => focusShow(i)}
          />
        );
      })}

      {focused && focusIdx != null && (
        <ShowEditor
          key={focused.id}
          show={focused}
          index={focusIdx}
          control={control}
          trigger={trigger}
          errors={focusedErrors}
          tagSuggestions={tagSuggestions}
          editorRef={editorRef}
          personas={personas}
          moods={moods}
          themes={themes}
          skills={skills}
          activeThemeId={activeThemeId}
          genres={genres}
          playlists={playlists}
          playlistsStatus={playlistsStatus}
          apiBase={apiBase}
          adminFetch={adminFetch}
          minTrackSeconds={data?.values?.minTrackSeconds}
          busy={busy}
          isNew={focused.id === creatingId}
          valid={!focusedErrors}
          onApplyDraft={(patch) => applyShowPatch(focusIdx, patch)}
          onSave={async () => { if (await saveShow(focusIdx)) setFocusIdx(null); }}
          onClose={() => setFocusIdx(null)}
          onRemove={() => setConfirmDeleteIdx(focusIdx)}
        />
      )}

      <V3AlertDialog
        open={confirmDeleteIdx !== null}
        onOpenChange={(o) => { if (!o) setConfirmDeleteIdx(null); }}
        title="Delete show"
        description={
          <>
            Remove{' '}
            <b>{confirmDeleteIdx !== null ? (shows[confirmDeleteIdx]?.name.trim() || 'this show') : 'this show'}</b>
            ? This deletes it right away and clears it from any scheduled hours.
            You don&apos;t need to Save schedule.
          </>
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        danger
        onConfirm={() => {
          if (confirmDeleteIdx !== null) removeShow(confirmDeleteIdx);
          setConfirmDeleteIdx(null);
        }}
      />

      <Modal
        open={communityOpen}
        onOpenChange={setCommunityOpen}
        title="community"
        sub="shows shared by other stations"
        width={640}
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-3">
            <span className="w-full text-[11px] leading-[1.5] text-muted sm:w-auto sm:flex-1">
              Made a show worth sharing? Submit it to the community catalog — a
              maintainer reviews it, then it ships to every station.
            </span>
            <Btn
              className="min-h-9 flex-none sm:min-h-0"
              onClick={() => window.open(showSubmitUrl(), '_blank', 'noopener,noreferrer')}
              title="Open a prefilled community submission on GitHub"
            >
              <Share2 size={14} /> Share a show
            </Btn>
          </div>
        }
      >
        <div className="text-[12px] leading-[1.65] text-muted">
          These shows are shared by other stations and ship with SUB/WAVE.
          <strong> Install</strong> adds one to your show list as your own
          editable show — it arrives <strong>unscheduled</strong> with your
          active persona as host, so assign a persona (and any guest co-hosts),
          then paint it into the weekly grid above.
        </div>
        <div className="mt-4 grid gap-3">
          {community && community.length > 0 ? (
            community.map(c => {
              // Shows can't be installed twice — the controller 409s on a name
              // clash — so flag ones already in your list instead of a button.
              const inShows = shows.some(
                s => s.name.trim().toLowerCase() === c.name.trim().toLowerCase(),
              );
              const tags = [...c.moods, ...c.genres, ...c.energies].slice(0, 6);
              return (
                <div
                  key={c.slug}
                  className="grid grid-cols-1 gap-3 border border-ink p-3 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-4"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-extrabold">{c.name}</span>
                      {c.programme && <Pill className="text-[8px]">programme</Pill>}
                      {c.banter && <Pill className="text-[8px]">banter</Pill>}
                      {c.filtersStrict && <Pill className="text-[8px]">strict filters</Pill>}
                    </div>
                    {c.topic && (
                      <div className="mt-1 line-clamp-3 text-[12px] leading-[1.6] text-muted">{c.topic}</div>
                    )}
                    {tags.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {tags.map((t, i) => (
                          <Pill key={`${t}-${i}`} className="text-[8px]">{t}</Pill>
                        ))}
                      </div>
                    )}
                    {(c.submittedBy || c.dateAdded) && (
                      <div className="mt-1.5 text-[10px] leading-[1.5] text-muted">
                        {c.submittedBy && (
                          <>
                            by{' '}
                            <a
                              href={`https://github.com/${c.submittedBy}`}
                              target="_blank"
                              rel="noreferrer"
                              className="font-bold text-vermilion underline decoration-[1.5px] underline-offset-2"
                            >
                              @{c.submittedBy}
                            </a>
                          </>
                        )}
                        {c.submittedBy && c.dateAdded && ' · '}
                        {c.dateAdded && <>added {c.dateAdded}</>}
                        {c.dateAdded && c.dateModified && c.dateModified !== c.dateAdded && (
                          <> · updated {c.dateModified}</>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col items-start gap-2 sm:items-end">
                    {inShows ? (
                      <Pill tone="accent" dot>in your shows</Pill>
                    ) : (
                      <Btn
                        tone="accent"
                        className="min-h-9 sm:min-h-0"
                        onClick={() => install(c.slug)}
                        disabled={installing === c.slug || shows.length >= SHOWS_MAX}
                        title={shows.length >= SHOWS_MAX ? 'The show list is full' : undefined}
                      >
                        {installing === c.slug ? 'Installing…' : 'Install'}
                      </Btn>
                    )}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="py-6 text-center text-[13px] text-muted italic">
              No community shows yet.
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}

'use client';

import Link from 'next/link';
import { ShowGenerationDialog, ShowGenerationNotice } from './shows/ShowGenerationNotice';
import { ChevronDown, RefreshCw, Save, Shuffle, ExternalLink } from 'lucide-react';
import type { AdminFetch } from '@/lib/admin-query';
import { fieldAria } from '@/lib/form';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';
import { errorMessage, notify } from '../../lib/notify';
import { useDynamicStyle } from '../../hooks/useDynamicStyle';
import { Button } from '../ui/button';
import { V3AlertDialog } from '../ui/alert-dialog';
import { GeneratedShowEditor } from './shows/GeneratedShowEditor';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { SkeletonRows } from '@/components/ui/skeleton';
import { Card, Eyebrow, MetaChip, Pill } from './ui';
import {
  GENERATED_SHOW_TEMPLATES,
  generatedShowColor,
} from './schedule/lib';
import { hydrateShow, joinNames } from './shows/lib';
import { ShowAvatar } from './shows/ShowAvatar';
import type { SettingsResponse } from './shows/types';
import {
  useGeneratedEpisodeHistoryQuery,
  useGeneratedShowDraftMutation,
  useShuffleGeneratedEpisodeMutation,
  useRegenerateGeneratedEpisodeMutation,
  useShowSkillsQuery,
} from './shows/queries';
import type { GeneratedShowDraft, ShuffledEpisodeCast, GeneratedEpisodeHistory } from './shows/queries';
import type { Persona } from './shows/types';
import {
  useSettingsMutation,
  useSettingsQuery,
} from './settings/queries';
import type { SubShowsSettings } from '@/lib/schemas.generated';

type PoolKey = 'eligibleHostPersonaIds' | 'eligibleGuestPersonaIds' | 'eligibleSkillNames';
type PoolItem = { id: string; label: string };
type EpisodePhase = 'upcoming' | 'live' | 'past';
const DEFAULT_POOLS: SubShowsSettings = { eligibleHostPersonaIds: null, eligibleGuestPersonaIds: null, eligibleSkillNames: null };

export default function TemplateShowsPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const enabled = hydrated && !needsAuth;
  const apiBase = (process.env.NEXT_PUBLIC_API_URL as string | undefined) || '/api';
  const query = useSettingsQuery<SettingsResponse>({ adminFetch, enabled });
  const history = useGeneratedEpisodeHistoryQuery(adminFetch, enabled);
  const skillsQuery = useShowSkillsQuery(adminFetch, enabled);
  const saveSettings = useSettingsMutation<SettingsResponse>({ adminFetch });
  const data = query.data;
  const personas = data?.values?.personas ?? [];
  const variants = useMemo(
    () => (data?.values?.shows ?? []).map(hydrateShow)
      .filter(show => show.generation?.mode === 'generated'),
    [data?.values?.shows],
  );
  const savedPools = data?.values?.subShows ?? DEFAULT_POOLS;
  const [draft, setDraft] = useState<SubShowsSettings | null>(null);
  const [baseline, setBaseline] = useState<SubShowsSettings | null>(null);
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(baseline);
  const conflict = dirty && JSON.stringify(savedPools) !== JSON.stringify(baseline);

  useEffect(() => {
    // Unrelated show saves also refresh Settings; preserve unfinished pool edits.
    if (data && !dirty) {
      setDraft(savedPools);
      setBaseline(savedPools);
    }
  }, [data, savedPools, dirty]);

  const hostItems = personas.map(persona => ({ id: persona.id, label: persona.name || 'Unnamed DJ' }));
  const guestItems = hostItems;
  const skillItems = (skillsQuery.data ?? [])
    .filter(skill => skill.enabled !== false && skill.ready !== false && skill.name)
    .map(skill => ({ id: skill.name!, label: skill.label || skill.name! }));

  const now = history.dataUpdatedAt;
  const episodes = history.data ?? [];
  const episodeGroups: Array<{ title: string; phase: EpisodePhase; episodes: GeneratedEpisodeHistory[] }> = [
    { title: 'On air', phase: 'live', episodes: episodes.filter(ep => ep.occurrence.startsAt <= now && ep.occurrence.endsAt > now) },
    { title: 'Upcoming shows', phase: 'upcoming', episodes: episodes.filter(ep => ep.occurrence.startsAt > now)
      .sort((a, b) => a.occurrence.startsAt - b.occurrence.startsAt) },
    { title: 'Past shows', phase: 'past', episodes: episodes.filter(ep => ep.occurrence.endsAt <= now)
      .sort((a, b) => b.occurrence.startsAt - a.occurrence.startsAt) },
  ];

  const setPool = (key: PoolKey, selected: string[] | null) => {
    if (!draft) return;
    setDraft({ ...draft, [key]: selected } as SubShowsSettings);
  };

  const togglePool = (key: PoolKey, items: PoolItem[], id: string, checked: boolean) => {
    if (!draft) return;
    const current = draft[key];
    const selected = new Set(current ?? items.map(item => item.id));
    if (checked) selected.add(id);
    else selected.delete(id);
    const allSelected = selected.size === items.length && items.every(item => selected.has(item.id));
    setPool(key, allSelected ? null : [...selected]);
  };

  const savePools = async () => {
    if (!draft || conflict) return;
    if (draft.eligibleHostPersonaIds?.length === 0 && variants.some(show => show.generation?.hostMode === 'random')) {
      notify.err('Select at least one eligible host while a variant uses Random Host.');
      return;
    }
    if (draft.eligibleGuestPersonaIds?.length === 0 && variants.some(show =>
      show.generation?.guestMode === 'random' && show.generation.guestCount.min > 0,
    )) {
      notify.err('Select at least one eligible guest for variants that require guests.');
      return;
    }
    try {
      const receipt = await saveSettings.mutateAsync({ subShows: draft });
      if (receipt.refreshError) notify.err(`Saved Sub/Shows settings, but could not refresh them: ${receipt.refreshError}`);
      else {
        setBaseline(draft);
        notify.ok('Sub/Shows settings saved. Upcoming generated shows are being refreshed.');
      }
    } catch (error) {
      notify.err(`Could not save Sub/Shows settings: ${errorMessage(error)}`);
    }
  };

  if (query.error && !data) {
    return (
      <div className="grid gap-4">
        <Card title="Sub/Shows">
          <ErrorState error={errorMessage(query.error)} onRetry={() => query.refetch()} retrying={query.isFetching} />
        </Card>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="grid gap-4">
        <Card title="Sub/Shows">
          <SkeletonRows rows={4} />
        </Card>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <section className="card">
        <div className="grid gap-4 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <Eyebrow className="text-vermilion">show plan · Sub/Shows</Eyebrow>
              <h1 className="mt-1.5 text-[22px] font-extrabold tracking-[-0.02em]">Sub/Shows</h1>
            </div>
            <Button asChild variant="accent" size="sm" className="min-h-11 sm:min-h-9">
              <Link href="/admin/shows/schedule">Open the schedule →</Link>
            </Button>
          </div>
          <div>
            <p className="mt-1 max-w-[68ch] text-[11px] leading-[1.6] text-muted">
              Plan fresh episodes from your DJs’ personalities and musical tastes. Drag a Sub/Show from the schedule
              shelf. Click a template to choose its host, guests and episode-name rules before dragging, or click a slot to adjust it later.
            </p>
            <p className="mt-2 max-w-[68ch] text-[11px] leading-[1.6] text-muted">
              Episode plans are prepared for the next 48 hours. Preparation runs daily at 05:00 station time,
              on startup, and after saving the week or changing a slot’s host or guests. Slots further ahead
              stay scheduled and get a plan when a preparation run reaches them. Accepted plans are kept on restart.
              Takeovers are prepared when you select them.
            </p>
            <dl className="mt-3 grid max-w-[78ch] gap-2 text-[12px] leading-[1.6]">
              {GENERATED_SHOW_TEMPLATES.map(template => (
                <div key={template.id} className={`border border-separator-soft px-3 py-2 ${template.stripeClassName}`}>
                  <dt className="font-semibold text-ink">{template.label}</dt>
                  <dd className="text-muted">{template.summary}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </section>

      <Card
        title="Sub/Shows settings"
        headingLevel={2}
        sub={dirty ? 'Unsaved changes · used by every generated slot' : 'Used by every generated slot'}
        right={(
          <Button size="sm" variant="accent" className="min-h-11 sm:min-h-0" disabled={!draft || !dirty || conflict || saveSettings.isPending} onClick={() => void savePools()}>
            {saveSettings.isPending ? 'Saving…' : 'Save settings'}
          </Button>
        )}
      >
        {draft && (
          <div className="grid gap-0">
            {conflict && <div role="alert" className="mb-3 grid gap-2 text-[12px]">
              <p>Eligibility settings changed elsewhere. Your edits are kept here. Discard them and load the saved settings before editing again.</p>
              <Button type="button" className="min-h-11 w-fit" onClick={() => { setDraft(savedPools); setBaseline(savedPools); }}>
                Discard edits and load saved settings
              </Button>
            </div>}
            <EligibilityPicker
              title="Random hosts"
              description="DJs available for Random Host and both Common Ground participants. Everyone is selected by default."
              items={hostItems}
              selected={draft.eligibleHostPersonaIds}
              onChange={(id, checked) => togglePool('eligibleHostPersonaIds', hostItems, id, checked)}
              onAll={() => setPool('eligibleHostPersonaIds', null)}
              onNone={() => setPool('eligibleHostPersonaIds', [])}
            />
            <EligibilityPicker
              title="Random guests"
              description="Random guests for DJ’s Choice, Deep Discovery and Time Capsule. Common Ground uses Random Hosts for both DJs. The selected host is always excluded."
              items={guestItems}
              selected={draft.eligibleGuestPersonaIds}
              onChange={(id, checked) => togglePool('eligibleGuestPersonaIds', guestItems, id, checked)}
              onAll={() => setPool('eligibleGuestPersonaIds', null)}
              onNone={() => setPool('eligibleGuestPersonaIds', [])}
            />
            <EligibilityPicker
              title="DJ Skills"
              allLabel="All skills"
              description="Skills available to automatic segments in Sub/Shows, when the host has the skill."
              items={skillItems}
              selected={draft.eligibleSkillNames}
              onChange={(id, checked) => togglePool('eligibleSkillNames', skillItems, id, checked)}
              onAll={() => setPool('eligibleSkillNames', null)}
              onNone={() => setPool('eligibleSkillNames', [])}
              empty={skillsQuery.isLoading
                ? 'Loading DJ Skills…'
                : skillsQuery.error
                  ? `Could not load DJ Skills: ${errorMessage(skillsQuery.error)}`
                  : 'No enabled, ready DJ Skills are available.'}
            />
          </div>
        )}
      </Card>

      {history.error && !history.data ? (
        <Card title="Episode plans">
          <ErrorState error={errorMessage(history.error)} onRetry={() => history.refetch()} retrying={history.isFetching} />
        </Card>
      ) : !history.data ? (
        <Card title="Episode plans"><SkeletonRows rows={3} /></Card>
      ) : episodeGroups.filter(group => group.phase !== 'live' || group.episodes.length > 0).map(group => (
        <section key={group.phase} className="grid gap-3" aria-label={group.title}>
          <div className="flex items-baseline justify-between gap-3 px-1 pt-2">
            <h2 className="text-[16px] font-extrabold text-ink">{group.title}</h2>
            <span className="text-[10px] text-muted">
              {group.episodes.length} episode{group.episodes.length === 1 ? '' : 's'}
              {group.phase === 'past' ? ' · kept for 30 days' : ''}
            </span>
          </div>
          {group.episodes.length ? (
            <div
              className={group.phase === 'live' ? 'grid gap-3' : 'grid max-h-[72rem] grid-cols-[minmax(0,1fr)] gap-3 overflow-y-auto overscroll-contain pr-1 focus-visible:outline-2 focus-visible:outline-[var(--accent)] sm:max-h-[36rem]'}
              role={group.phase === 'live' ? undefined : 'region'}
              aria-label={group.phase === 'live' ? undefined : `${group.title} list`}
              tabIndex={group.phase === 'live' ? undefined : 0}
            >
              {group.episodes.map(episode => (
                <GeneratedEpisodeRow
                  key={episode.occurrence.id}
                  episode={episode}
                  personas={personas}
                  timezone={data.values?.timezone}
                  apiBase={apiBase}
                  adminFetch={adminFetch}
                  phase={group.phase}
                  settings={data}
                />
              ))}
            </div>
          ) : (
            <EmptyState
              compact
              title={group.phase === 'past' ? 'No past episodes yet' : 'No upcoming episodes prepared'}
              description={group.phase === 'past'
                ? 'Episodes move here after their scheduled slot finishes.'
                : 'Plans appear here as scheduled Sub/Shows are prepared within the next 48 hours. Slots further ahead remain in the schedule.'}
            />
          )}
        </section>
      ))}
    </div>
  );
}

function EligibilityPicker({
  title,
  description,
  items,
  selected,
  onChange,
  onAll,
  onNone,
  empty = 'No DJs are available.',
  allLabel = 'Everyone',
}: {
  title: string;
  description: string;
  items: PoolItem[];
  selected: string[] | null;
  onChange: (id: string, checked: boolean) => void;
  onAll: () => void;
  onNone: () => void;
  empty?: string;
  allLabel?: string;
}) {
  const aria = fieldAria(`sub-shows-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, undefined, { hasDescription: true });
  const selectedCount = items.filter(item => selected === null || selected.includes(item.id)).length;
  return (
    <details className="group min-w-0 border-b border-separator-soft last:border-0">
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 py-3 focus-visible:outline-2 focus-visible:outline-vermilion [&::-webkit-details-marker]:hidden">
        <span {...aria.labelledByProps} className="flex-1 text-[11px] font-bold tracking-[0.22em] text-ink uppercase">{title}</span>
        <span className="text-[11px] text-muted">{selectedCount} / {items.length} selected</span>
        <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted transition-transform group-open:rotate-180 motion-reduce:transition-none" />
      </summary>
      <fieldset {...aria.groupProps} className="min-w-0 pb-4">
        <legend className="sr-only">{title}</legend>
        <div className="mt-1 flex flex-wrap gap-2.5">
          {items.length ? items.map(item => {
            const isSelected = selected === null || selected.includes(item.id);
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={isSelected}
                onClick={() => onChange(item.id, !isSelected)}
                className={`inline-flex min-h-11 cursor-pointer items-center gap-2.5 border px-3.5 py-2 text-[13px] transition-colors sm:min-h-10 ${
                  isSelected
                    ? 'border-ink bg-ink font-semibold text-bg'
                    : 'border-separator-strong bg-transparent font-medium text-muted hover:border-ink hover:text-ink'
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`size-[9px] shrink-0 border ${
                    isSelected ? 'border-vermilion bg-vermilion' : 'border-ink/40 bg-transparent'
                  }`}
                />
                <span>{item.label}</span>
              </button>
            );
          }) : <span className="py-2 text-[10px] text-muted">{empty}</span>}
        </div>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <p {...aria.descriptionProps} className="max-w-[78ch] text-[12px] leading-[1.6] text-muted">{description}</p>
          <div className="flex shrink-0 gap-2">
            <Button type="button" size="sm" className="min-h-11 sm:min-h-8" onClick={onAll}>{allLabel}</Button>
            <Button type="button" size="sm" className="min-h-11 sm:min-h-8" onClick={onNone}>Clear</Button>
          </div>
        </div>
      </fieldset>
    </details>
  );
}

function GeneratedEpisodeRow({ episode, personas, timezone, apiBase, adminFetch, phase, settings }: {
  episode: GeneratedEpisodeHistory;
  personas: Persona[];
  timezone?: string;
  apiBase: string;
  adminFetch: AdminFetch;
  phase: EpisodePhase;
  settings: SettingsResponse;
}) {
  const regenerate = useRegenerateGeneratedEpisodeMutation(adminFetch);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const draftMutation = useGeneratedShowDraftMutation(adminFetch);
  const shuffle = useShuffleGeneratedEpisodeMutation(adminFetch);
  const [saveDraft, setSaveDraft] = useState<GeneratedShowDraft | null>(null);
  const [castPreview, setCastPreview] = useState<ShuffledEpisodeCast | null>(null);
  const busy = regenerate.isPending || shuffle.isPending || draftMutation.isPending;
  const openSave = async () => {
    try { setSaveDraft(await draftMutation.mutateAsync(episode.occurrence.id)); }
    catch { /* Mutation displays the error. */ }
  };
  const previewShuffle = async () => {
    try { setCastPreview(await shuffle.mutateAsync(episode.occurrence.id)); }
    catch (error) { setGenerationError(errorMessage(error)); }
  };
  const confirmShuffle = async () => {
    if (!castPreview) return;
    try {
      await regenerate.mutateAsync({ occurrenceId: episode.occurrence.id, castSeed: castPreview.castSeed,
        cast: { hostPersonaId: castPreview.hostPersonaId, guestPersonaIds: castPreview.guestPersonaIds } });
      notify.ok('Cast shuffled and episode regenerated.');
    } catch (error) { setGenerationError(errorMessage(error)); }
    finally { setCastPreview(null); }
  };
  const [briefExpanded, setBriefExpanded] = useState(false);
  const reroll = async () => {
    try {
      await regenerate.mutateAsync(episode.occurrence.id);
      notify.ok('Episode plan regenerated.');
    } catch (error) { setGenerationError(errorMessage(error)); }
  };
  const spineRef = useRef<HTMLSpanElement>(null);
  useDynamicStyle(spineRef, { background: generatedShowColor(episode.template) });

  const hostPersona = personas.find(persona => persona.id === episode.hostPersonaId) ?? null;
  const guestPersonas = episode.guestPersonaIds
    .map(id => personas.find(persona => persona.id === id) ?? null);
  const host = hostPersona?.name?.trim() || 'Unknown DJ';
  const guests = guestPersonas.map(persona => persona?.name?.trim() || 'Unknown DJ');
  const template = GENERATED_SHOW_TEMPLATES.find(item => item.id === episode.template)?.label || episode.template;
  const startsAt = new Date(episode.occurrence.startsAt);
  const endsAt = new Date(episode.occurrence.endsAt);
  const dateOptions = timezone ? { timeZone: timezone } : {};
  const when = new Intl.DateTimeFormat(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    ...dateOptions,
  }).format(startsAt);
  const until = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric', minute: '2-digit', ...dateOptions,
    ...(startsAt.toLocaleDateString(undefined, dateOptions) !== endsAt.toLocaleDateString(undefined, dateOptions)
      ? { weekday: 'short', month: 'short', day: 'numeric' } : {}),
  }).format(endsAt);
  const durationMinutes = Math.round((episode.occurrence.endsAt - episode.occurrence.startsAt) / 60_000);
  const duration = [
    Math.floor(durationMinutes / 60) ? `${Math.floor(durationMinutes / 60)}h` : '',
    durationMinutes % 60 ? `${durationMinutes % 60}m` : '',
  ].filter(Boolean).join(' ');
  const plan = episode.plan;
  const titleId = useId();

  return (
    <>
    <article className="card group relative min-w-0" aria-busy={busy} aria-labelledby={titleId}>
      <span ref={spineRef} aria-hidden="true" className="absolute inset-y-0 left-0 w-1" />
      <div className="card-body flex gap-3.5">
        <div className="flex flex-none flex-col items-center">
          <ShowAvatar persona={hostPersona} apiBase={apiBase} size="lg" />
          {guestPersonas.length > 0 && (
            <div className="mt-1 flex">
              {guestPersonas.map((persona, index) => (
                <ShowAvatar
                  key={episode.guestPersonaIds[index]}
                  persona={persona}
                  apiBase={apiBase}
                  size="sm"
                  className={index > 0 ? '-ml-2 ring-2 ring-[var(--card-bg)]' : ''}
                />
              ))}
            </div>
          )}
        </div>

        <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] gap-2.5">
          <div className="flex flex-col items-start gap-3 sm:flex-row">
            <div className="w-full min-w-0 flex-1">
              <div className="mb-1 flex flex-wrap items-center gap-1.5">
                <Pill tone="solid" dot>Sub/Show</Pill>
                <Pill>{template}</Pill>
              </div>
              <h3 id={titleId} className="text-[17px] font-extrabold tracking-[-0.01em] break-words text-ink">
                {plan?.name || (episode.status === 'failed' ? 'Plan generation failed' : template)}
              </h3>
              <div className="mt-0.5 text-[12px] break-words text-muted">
                host · <span className="font-semibold text-ink">{host}</span>
                {guests.length > 0 && <> · with {joinNames(guests)}</>}
              </div>
            </div>

            <div className="flex flex-none flex-wrap items-center gap-2 sm:flex-col sm:items-end sm:gap-1.5 sm:text-right">
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                <div className="text-[11px] font-semibold text-ink">
                  <time dateTime={startsAt.toISOString()}>{when}</time>
                  {' – '}<time dateTime={endsAt.toISOString()}>{until}</time>
                  <span className="ml-2 text-muted">{duration}</span>
                </div>
                {phase === 'upcoming' && (
                  <Button
                    type="button" variant="ghost" size="icon" className="size-11 sm:size-8" aria-describedby={titleId}
                    aria-label="Regenerate show, keeping host and guests"
                    title="Regenerate show, keeping host and guests"
                    disabled={busy}
                    onClick={() => void reroll()}
                  >
                    <RefreshCw aria-hidden="true" className={regenerate.isPending ? 'animate-spin motion-reduce:animate-none' : ''} />
                  </Button>
                )}
                {phase === 'upcoming' && episode.canShuffle && (
                  <Button type="button" variant="ghost" size="icon" className="size-11 sm:size-8" aria-describedby={titleId}
                    aria-label="Shuffle random host/guests and regenerate show"
                    title="Shuffle random host/guests and regenerate show"
                    disabled={busy} onClick={() => void previewShuffle()}>
                    <Shuffle aria-hidden="true" />
                  </Button>
                )}
                {plan && (
                  <Button type="button" variant="ghost" size="icon" className="size-11 sm:size-8" aria-describedby={titleId}
                    aria-label={episode.savedShowId ? 'Open saved show' : 'Save as regular show'}
                    title={episode.savedShowId ? 'Open saved show' : 'Save as regular show'}
                    disabled={busy} onClick={() => void openSave()}>
                    {episode.savedShowId ? <ExternalLink aria-hidden="true" /> : <Save aria-hidden="true" />}
                  </Button>
                )}
              </div>
              <span role="status">
                <Pill tone={episode.status === 'failed' ? 'accent' : 'ink'}>
                  {regenerate.isPending ? 'Regenerating…' : episode.status === 'failed' ? 'Generation failed'
                    : phase === 'live' ? 'On air' : phase === 'past' ? 'Past slot' : 'Ready'}
                </Pill>
              </span>
              {(phase !== 'past' || episode.occurrence.source !== 'scheduled') && (
                <span className="caption uppercase">{episode.occurrence.source}</span>
              )}
            </div>
          </div>
          {episode.status === 'failed' && episode.reason && <div className="grid justify-items-start gap-2">
            <ShowGenerationNotice message={episode.reason} />
            <Button type="button" variant="outline" size="sm" onClick={() => setGenerationError(episode.reason!)}>
              View guidance
            </Button>
          </div>}
          {plan ? (
            <>
              <div className="flex flex-wrap gap-1">
                {[...plan.moods, ...plan.genres, ...plan.energies].map((tag, index) => (
                  <MetaChip key={`${tag}-${index}`}>{tag}</MetaChip>
                ))}
                {plan.eras.map((era, index) => (
                  <MetaChip key={`era-${index}`}>
                    {era.fromYear ?? 'Earlier'}–{era.toYear ?? 'Now'}
                  </MetaChip>
                ))}
                <MetaChip accent={plan.filtersStrict}>
                  {plan.filtersStrict ? 'Strict filters' : 'Soft filters'}
                </MetaChip>
              </div>
              <div>
                <p className={`${briefExpanded ? '' : 'line-clamp-2 '}max-w-[90ch] text-[12px] leading-[1.55] break-words text-muted italic`}>{plan.topic}</p>
                <Button
                  type="button" variant="link" size="sm" className="mt-1 min-h-11 px-0 sm:min-h-0"
                  aria-expanded={briefExpanded}
                  aria-label={`${briefExpanded ? 'Collapse' : 'Read full'} brief for ${plan.name}`}
                  onClick={() => setBriefExpanded(expanded => !expanded)}
                >
                  {briefExpanded ? 'Collapse brief' : 'Read full brief'}
                </Button>
              </div>
              {plan.rationale && (
                <details className="text-[10px] text-muted">
                  <summary className="min-h-11 w-fit cursor-pointer py-3 hover:text-ink sm:min-h-0 sm:py-0">Why these settings</summary>
                  <p className="mt-1 max-w-[90ch] leading-[1.5]">{plan.rationale}</p>
                </details>
              )}
            </>
          ) : episode.status !== 'failed' && <p className="text-[10px] text-muted">{episode.reason || 'The plan has not been generated yet.'}</p>}
        </div>
      </div>
    </article>
    <ShowGenerationDialog message={generationError} onDismiss={() => setGenerationError(null)} />
    <V3AlertDialog open={!!castPreview} onOpenChange={open => { if (!open) setCastPreview(null); }}
      title="Shuffle host and guests"
      description={castPreview ? <>
        Host: <b>{personas.find(p => p.id === castPreview.hostPersonaId)?.name || 'Unknown DJ'}</b>.
        {' Guests: '}{castPreview.guestPersonaIds.length ? joinNames(castPreview.guestPersonaIds.map(id => personas.find(p => p.id === id)?.name || 'Unknown DJ')) : 'None'}.
        {' Generate a new show with this cast? Fixed host and guest options are preserved.'}
      </> : ''}
      confirmLabel="Generate show" cancelLabel="Cancel" onConfirm={() => void confirmShuffle()}
    />
    {saveDraft && <GeneratedShowEditor key={`${episode.occurrence.id}:${saveDraft.generatedAt}`}
      draft={saveDraft} occurrenceId={episode.occurrence.id} settings={settings}
      apiBase={apiBase} adminFetch={adminFetch} onClose={() => setSaveDraft(null)} />}
    </>
  );
}

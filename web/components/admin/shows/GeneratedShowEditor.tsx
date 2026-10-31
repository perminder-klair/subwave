'use client';

import { useEffect, useMemo, useRef } from 'react';
import { z } from 'zod';
import type { Control, FieldErrors, UseFormTrigger, UseFormWatch } from 'react-hook-form';
import type { AdminFetch } from '@/lib/admin-query';
import { useZodForm } from '@/lib/form';
import { showSchema } from '@/lib/schemas.generated';
import { notify } from '@/lib/notify';
import { useAdminThemesQuery } from '../themes-queries';
import { ShowEditor } from './ShowEditor';
import { hydrateShow, showContext } from './lib';
import type { SettingsResponse, ShowsFormValues } from './types';
import {
  useShowGenresQuery, useShowPlaylistsQuery, useShowSkillsQuery,
  useSaveGeneratedShowMutation, type GeneratedShowDraft,
} from './queries';

/** Use the ordinary show editor on an isolated copy; no schedule is written. */
export function GeneratedShowEditor({ draft, occurrenceId, settings, apiBase, adminFetch, onClose }: {
  draft: GeneratedShowDraft;
  occurrenceId: string;
  settings: SettingsResponse;
  apiBase: string;
  adminFetch: AdminFetch;
  onClose: () => void;
}) {
  const themes = useAdminThemesQuery(adminFetch, true);
  const skills = useShowSkillsQuery(adminFetch, true);
  const genres = useShowGenresQuery(adminFetch, true);
  const playlists = useShowPlaylistsQuery(adminFetch, true);
  const save = useSaveGeneratedShowMutation(adminFetch);
  const editorRef = useRef<HTMLDivElement>(null);
  const context = useMemo(() => showContext({
    personas: settings.values?.personas ?? [], moods: settings.tts?.moods ?? [],
    themeIds: (themes.data?.themes ?? []).map(theme => theme.id),
    minTrackSeconds: settings.values?.minTrackSeconds ?? null,
  }), [settings, themes.data]);
  const schema = useMemo(() => z.object({ shows: z.array(showSchema(context)) }), [context]);
  const form = useZodForm(schema, { shows: [hydrateShow(draft.show)] });
  const control = form.control as unknown as Control<ShowsFormValues>;
  const watch = form.watch as unknown as UseFormWatch<ShowsFormValues>;
  const trigger = form.trigger as unknown as UseFormTrigger<ShowsFormValues>;
  const errors = form.formState.errors as FieldErrors<ShowsFormValues>;
  const show = watch('shows.0');
  useEffect(() => { void trigger(); }, [context, trigger]);

  const submit = form.handleSubmit(async values => {
    try {
      await save.mutateAsync({ show: hydrateShow(values.shows[0]!), occurrenceId, generatedAt: draft.generatedAt, saved: draft.saved });
      notify.ok(draft.saved ? 'Show updated.' : 'Saved as a regular show. Find it in Shows and The Shelf.');
      onClose();
    } catch { /* Mutation displays the error; keep the draft open. */ }
  });

  return <ShowEditor
    show={show} index={0} control={control} trigger={trigger} errors={errors.shows?.[0]}
    editorRef={editorRef} personas={settings.values?.personas ?? []} moods={settings.tts?.moods ?? []}
    themes={themes.data?.themes ?? []} skills={skills.data ?? []} activeThemeId={themes.data?.active ?? ''}
    genres={genres.data ?? []} tagSuggestions={[]} playlists={playlists.data ?? []}
    playlistsStatus={playlists.isPending ? 'loading' : playlists.isError ? 'error' : 'ready'}
    apiBase={apiBase} adminFetch={adminFetch} minTrackSeconds={settings.values?.minTrackSeconds}
    stationMinTrackLengthSeconds={settings.values?.picker?.minTrackLengthSeconds}
    busy={save.isPending} isNew={false} valid={form.formState.isValid}
    title={draft.saved ? 'Edit saved show' : 'Save as regular show'}
    onApplyDraft={() => {}} onSave={() => void submit()} onClose={onClose}
  />;
}

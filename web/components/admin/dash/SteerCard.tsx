'use client';

import { useEffect, useState } from 'react';
import { Controller } from 'react-hook-form';
import type { z } from 'zod';
import { useAdminAuth } from '../../../lib/adminAuth';
import { useAdminMutation, useAdminQuery } from '../../../lib/admin-query';
import { notify, errorMessage } from '../../../lib/notify';
import { fmtClock } from '../../../lib/format';
import type { StationLocale } from '../../../lib/types';
import { cn } from '../../../lib/cn';
import { useZodForm, applyServerFieldErrors } from '@/lib/form';
import { SwitchField, TextField, TextareaField } from '@/lib/form-fields';
import { Card, Btn, Pill, Seg } from '../ui';
import { SlotMenu } from '../schedule/bits';
import { useShowPlaylistsQuery } from '../shows/queries';
import {
  steerRequestSchema,
  STEER_MIN_MINUTES,
  STEER_MAX_MINUTES,
  STEER_PROMPT_MAX,
  type Steer,
} from '@/lib/schemas.generated';
import {
  dashKeys,
  fetchSteer,
  fetchTakeoverWindow,
  writeSteer,
  writeTakeoverOverride,
  type SteerData,
  type SteerTrack,
  type TakeoverWindow,
} from './queries';
import { previewKey, previewState, startSentence, type SteerPreview } from './steer-start';

const PRESETS = [15, 30, 60, 120];
// Seg ids for the two ends that are not a minute count.
const ONCE_SEG = 'once';
const SCHEDULE_SEG = 'schedule';

type SteerVars = z.output<typeof steerRequestSchema>;
const EMPTY: z.input<typeof steerRequestSchema> = { playlistId: null, prompt: '', until: 'fixed', minutes: 60, startNow: false, introduce: false };

interface StartResult {
  steer?: Steer;
  /** The opening tracks the controller queued, in play order. */
  tracks?: SteerTrack[];
  skipped?: number;
  warnings?: string[];
  dropped?: number;
  kept?: number;
  /** A pick was already running when the steer started. */
  pickInFlight?: boolean;
  /** The opening tracks were the remembered preview, not a new model call. */
  cached?: boolean;
}

class SteerError extends Error {
  constructor(message: string, readonly fieldErrors?: Record<string, string>) {
    super(message);
  }
}

export function SteerCard({ tz, locale }: { tz?: string; locale?: StationLocale }) {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [now, setNow] = useState(() => Date.now());
  const form = useZodForm(steerRequestSchema, EMPTY);

  const steerQuery = useAdminQuery<SteerData>({
    key: dashKeys.steer(),
    adminFetch,
    enabled: hydrated && !needsAuth,
    staleTime: 0,
    refetchInterval: () => 30_000,
    request: fetchSteer,
  });
  const steer = steerQuery.data?.steer ?? null;
  const budgetMode = steerQuery.data?.budgetMode ?? 'normal';
  const queued = steerQuery.data?.queued ?? [];
  // The opening tracks last worked out, and what they were worked out for.
  const [preview, setPreview] = useState<SteerPreview | null>(null);

  const playlistsQuery = useShowPlaylistsQuery(adminFetch, hydrated && !needsAuth);
  const playlists = playlistsQuery.data ?? [];
  const playlistName = (id: string | null | undefined) => (id && playlists.find(p => p.id === id)?.name) || null;

  const minutes = form.watch('minutes');
  const until = form.watch('until');
  const promptValue = form.watch('prompt') || '';
  const promptLength = promptValue.length;
  const formKey = previewKey(form.watch('playlistId'), promptValue, until === 'once');
  const shown = previewState(preview, formKey, now);
  // The resolved end for "until the schedule changes", read only while that is
  // selected (the takeover card's own preview, and the same reason).
  const untilSchedule = until === 'schedule-change';
  const windowQuery = useAdminQuery<TakeoverWindow>({
    key: dashKeys.takeoverWindow(),
    adminFetch,
    enabled: hydrated && !needsAuth && untilSchedule,
    staleTime: 0,
    refetchInterval: () => 30_000,
    request: fetchTakeoverWindow,
  });

  useEffect(() => {
    if (steerQuery.dataUpdatedAt) setNow(Date.now());
  }, [steerQuery.dataUpdatedAt]);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const live = steer && steer.expiresAt > now ? steer : null;

  const startMutation = useAdminMutation<StartResult, SteerVars>({
    adminFetch,
    toastOnError: false,
    request: async (values, fetcher) => {
      const response = await fetcher('/steer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const body = await response.json().catch(() => ({})) as StartResult & {
        error?: string;
        fieldErrors?: Record<string, string>;
      };
      if (!response.ok) throw new SteerError(body.error || `failed (${response.status})`, body.fieldErrors);
      return body;
    },
    onDone: async (data, values, client) => {
      // A single track stores nothing and leaves a steer or takeover running.
      if (values.until === 'once') return;
      writeSteer(client, data.steer ?? null, data.tracks ?? []);
      // Starting a steer cancels a live takeover on the controller.
      writeTakeoverOverride(client, null);
      await client.invalidateQueries({ queryKey: dashKeys.takeover() });
    },
  });
  const clearMutation = useAdminMutation<void, void>({
    adminFetch,
    toastOnError: false,
    request: async (_vars, fetcher) => {
      const response = await fetcher('/steer', { method: 'DELETE' });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || `failed (${response.status})`);
    },
    onDone: (_data, _vars, client) => writeSteer(client, null),
  });
  const previewMutation = useAdminMutation<{ picks?: SteerTrack[]; warnings?: string[] }, SteerVars>({
    adminFetch,
    toastOnError: false,
    request: async (values, fetcher) => {
      const response = await fetcher('/steer/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const body = await response.json().catch(() => ({})) as {
        picks?: SteerTrack[]; warnings?: string[]; error?: string; fieldErrors?: Record<string, string>;
      };
      if (!response.ok) throw new SteerError(body.error || `failed (${response.status})`, body.fieldErrors);
      return body;
    },
  });
  const busy = startMutation.isPending || clearMutation.isPending || previewMutation.isPending;

  const runPreview = form.handleSubmit(async (values) => {
    try {
      const result = await previewMutation.mutateAsync(values);
      // Stamped on the card's own clock, which ticks every 30 s, not the
      // controller's: the two may disagree. A list the controller has since
      // forgotten is caught when Start answers.
      setPreview({ key: previewKey(values.playlistId, values.prompt, values.until === 'once'), at: now, picks: result.picks ?? [] });
      for (const warning of result.warnings ?? []) notify.err(`Steer: ${warning}`);
    } catch (e) {
      if (e instanceof SteerError) applyServerFieldErrors(form, e.fieldErrors);
      notify.err(errorMessage(e));
    }
  });

  const start = form.handleSubmit(async (values) => {
    try {
      const promised = shown === 'valid';
      const started = await startMutation.mutateAsync(values);
      setPreview(null);
      if (promised && started.cached === false) {
        notify.err('Steer: the previewed tracks were no longer remembered, so new ones were worked out.');
      }
      if (values.until === 'once') {
        const queued = started.tracks?.[0];
        notify.ok(queued ? `Queued: ${queued.title}.` : 'That track is already queued or on air.');
        return;
      }
      notify.ok(started.pickInFlight
        ? 'Steer started — a pick was already running, so it applies to the one after.'
        : values.startNow && started.kept
          ? 'Steer started — one track was already on its way to air and will play first.'
          : 'Steer started — its opening tracks are queued.');
      for (const warning of started.warnings ?? []) notify.err(`Steer: ${warning}`);
    } catch (e) {
      if (e instanceof SteerError) applyServerFieldErrors(form, e.fieldErrors);
      notify.err(errorMessage(e));
    }
  });

  const clear = async () => {
    try {
      await clearMutation.mutateAsync();
      form.reset(EMPTY);
      notify.ok('Steer cleared — back to the show as written.');
    } catch (e) {
      notify.err(errorMessage(e));
    }
  };

  return (
    <Card
      title="Steer"
      sub={live ? undefined : 'lean the music and the talk for a while'}
      className={cn(live && 'shadow-[0_0_0_2px_color-mix(in_oklab,var(--accent)_28%,transparent)]')}
      right={live ? <Pill tone="accent" dot>steering</Pill> : undefined}
    >
      {live ? (
        <div className="grid gap-2.5">
          <div className="grid gap-1 border border-[color-mix(in_oklab,var(--accent)_35%,transparent)] bg-[var(--accent-soft)] px-2.5 py-2">
            {live.playlistId && (
              <span className="text-[13px] font-bold break-words text-ink">
                only “{playlistName(live.playlistId) ?? 'the chosen playlist'}”
              </span>
            )}
            {live.prompt && <span className="text-[13px] font-bold break-words text-ink">{live.prompt}</span>}
            <span className="mono-num text-[10px] text-muted">
              {`ends ${fmtClock(live.expiresAt, tz, locale)} · ${Math.max(1, Math.ceil((live.expiresAt - now) / 60_000))} min left`}
            </span>
          </div>
          {queued.length > 0 && (
            <div className="grid gap-0.5 text-[11px] text-ink">
              <span className="text-[10px] text-muted">opening tracks still to play, no model call needed for them</span>
              {queued.map(t => (
                <span key={t.id} className="truncate">
                  {t.title} <span className="text-muted">— {t.artist}</span>
                </span>
              ))}
            </div>
          )}
          {budgetMode !== 'normal' && (
            <div className="text-[10px] text-muted">
              {budgetMode === 'hard'
                ? 'the daily token cap is reached — picks are paused, so the steer has nothing to act on'
                : 'the token budget is in its saving tier — the steer only re-orders the tracks already in reach'}
            </div>
          )}
          <Btn sm className="w-full" disabled={busy} onClick={clear}>
            {busy ? 'clearing…' : 'Clear steer'}
          </Btn>
        </div>
      ) : (
        <div className="@container grid gap-4">
          <div className="grid gap-2">
            <span className="text-sm font-medium">Playlist</span>
            <Controller
              control={form.control}
              name="playlistId"
              render={({ field }) => (
                <SlotMenu<string | null>
                  ariaLabel="Choose a playlist to play exclusively"
                  className="min-h-9 w-full min-w-0 justify-between text-[12px]"
                  label={(
                    <span className="min-w-0 flex-1 truncate text-left">
                      {playlistName(field.value) ?? (playlistsQuery.isError ? 'playlists unavailable' : 'No playlist — steer by direction only')}
                    </span>
                  )}
                  options={[
                    { key: null, label: 'No playlist' },
                    ...playlists.map(p => ({ key: p.id, label: p.songCount != null ? `${p.name} · ${p.songCount}` : p.name })),
                  ]}
                  onSelect={key => field.onChange(key)}
                />
              )}
            />
            <span className="text-[10px] text-muted">
              with a playlist, only its tracks play: none repeats until all have aired, then it starts over
            </span>
          </div>
          <div className="grid gap-1">
            <TextareaField
              control={form.control}
              name="prompt"
              label="Direction (optional with a playlist)"
              rows={3}
              maxLength={STEER_PROMPT_MAX}
              placeholder="more upbeat 2020s pop, and keep the talk short"
            />
            <div className="flex justify-between gap-3 text-[10px] text-muted">
              <span>leans picks within your library and what the host says — it cannot add music</span>
              <span className="mono-num whitespace-nowrap">{promptLength} / {STEER_PROMPT_MAX}</span>
            </div>
          </div>
          <div className="grid items-end gap-3 @min-[420px]:grid-cols-[minmax(0,1fr)_8rem]">
            <div className="grid min-w-0 gap-2">
              <span className="text-sm font-medium">For how long</span>
              <Controller
                control={form.control}
                name="until"
                render={({ field }) => (
                  <Seg
                    aria-label="Steer duration"
                    value={field.value === 'once' ? ONCE_SEG : field.value === 'schedule-change' ? SCHEDULE_SEG : String(minutes ?? '')}
                    options={[
                      { id: ONCE_SEG, label: 'once', title: 'Queue one track; nothing else changes' },
                      ...PRESETS.map(m => ({ id: String(m), label: m < 60 ? `${m}m` : `${m / 60}h` })),
                      { id: SCHEDULE_SEG, label: 'til change', title: 'End when the weekly schedule moves on' },
                    ]}
                    onChange={id => {
                      if (id === ONCE_SEG || id === SCHEDULE_SEG) {
                        field.onChange(id === ONCE_SEG ? 'once' : 'schedule-change');
                        form.setValue('minutes', undefined, { shouldValidate: true });
                        return;
                      }
                      field.onChange('fixed');
                      form.setValue('minutes', Number(id), { shouldValidate: true });
                    }}
                  />
                )}
              />
            </div>
            {until === 'fixed' && (
              <TextField
                control={form.control}
                name="minutes"
                label="Steer minutes"
                numeric
                className="min-w-0"
                min={STEER_MIN_MINUTES}
                max={STEER_MAX_MINUTES}
              />
            )}
          </div>
          {untilSchedule && (
            <div className="mono-num text-[10px] text-muted">
              {windowQuery.isError
                ? 'could not read the schedule — the end is worked out again when you start'
                : windowQuery.data
                  ? `ends ${fmtClock(windowQuery.data.expiresAt, tz, locale)} · ${windowQuery.data.minutes} min`
                  : 'reading the schedule…'}
            </div>
          )}
          <SwitchField
            control={form.control}
            name="startNow"
            label="Start now"
            description="also drop the track the DJ has already queued, instead of waiting for it to play"
          />
          <SwitchField
            control={form.control}
            name="introduce"
            label="Introduce on air"
            description="one host link before the first track that says where the music is heading, in the host's own words, and trails what follows (an announce-only host just names the track). The opening tracks otherwise play back to back with no links"
          />
          {preview && preview.picks.length > 0 && (
            <div className={cn('grid gap-0.5 border px-2.5 py-2 text-[11px]', shown === 'valid' ? 'border-ink/30 text-ink' : 'border-ink/15 text-muted line-through')}>
              <span className="text-[10px] text-muted no-underline">a sample of what this steer would pick, not the whole queue</span>
              {preview.picks.map((t, i) => (
                <span key={t.id} className="truncate">
                  <span className="mono-num text-muted">{i + 1}.</span> {t.title} <span className="text-muted">— {t.artist}</span>
                </span>
              ))}
            </div>
          )}
          <div className="text-[11px] text-ink">{startSentence(preview, formKey, now, until === 'once')}</div>
          <div className="grid grid-cols-2 gap-2">
            <Btn
              sm
              disabled={busy || !form.formState.isValid || shown === 'valid'}
              onClick={runPreview}
              title={shown === 'valid' ? 'Change the playlist or direction to preview again' : 'One model call'}
            >
              {previewMutation.isPending ? 'working it out…' : 'Preview (one model call)'}
            </Btn>
            <Btn tone="accent" sm disabled={busy || !form.formState.isValid} onClick={start}>
              {startMutation.isPending ? 'starting…' : 'Start steer →'}
            </Btn>
          </div>
          <div className="text-[10px] text-muted">
            the schedule is not changed · starting it cancels a takeover · listeners see ordinary picks
          </div>
        </div>
      )}
    </Card>
  );
}

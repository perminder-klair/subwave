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
import { FieldLabel } from '@/components/ui/field';
import { Card, Btn, Pill, Seg } from '../ui';
import { SlotMenu } from '../schedule/bits';
import { useShowPlaylistsQuery } from '../shows/queries';
import {
  steerRequestSchema,
  STEER_MIN_MINUTES,
  STEER_MAX_MINUTES,
  STEER_PROMPT_MAX,
  steerActiveAt,
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
import { previewKeyOf, previewSizeKey, previewState, startSentence, type SteerPreview, type SteerStartInputs } from './steer-start';

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
  /** Opening tracks left out because they would start after the steer ends. */
  unfit?: number;
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
  const hasPlaylist = !!form.watch('playlistId');
  const inputs: SteerStartInputs = {
    // `minutes` is the coerced field's raw input: only a number sizes anything.
    playlistId: form.watch('playlistId'), prompt: promptValue, until,
    minutes: typeof minutes === 'number' ? minutes : undefined, startNow: form.watch('startNow'),
  };
  const shown = previewState(preview, inputs, now);
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

  const live = steerActiveAt(steer, now);
  // When this steer would end, for the readout beside "For how long".
  const endsAt = until === 'fixed'
    ? (typeof minutes === 'number' && minutes >= STEER_MIN_MINUTES && minutes <= STEER_MAX_MINUTES ? now + minutes * 60_000 : null)
    : untilSchedule ? windowQuery.data?.expiresAt ?? null : null;

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
  const previewMutation = useAdminMutation<{ picks?: SteerTrack[]; fit?: number; warnings?: string[] }, SteerVars>({
    adminFetch,
    toastOnError: false,
    request: async (values, fetcher) => {
      const response = await fetcher('/steer/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const body = await response.json().catch(() => ({})) as {
        picks?: SteerTrack[]; fit?: number; warnings?: string[]; error?: string; fieldErrors?: Record<string, string>;
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
      const picks = result.picks ?? [];
      setPreview({ key: previewKeyOf(values), size: previewSizeKey(values), at: now, picks, fit: result.fit ?? picks.length });
      for (const warning of result.warnings ?? []) notify.err(`Steer: ${warning}`);
    } catch (e) {
      if (e instanceof SteerError) applyServerFieldErrors(form, e.fieldErrors);
      notify.err(errorMessage(e));
    }
  });

  const start = form.handleSubmit(async (values) => {
    try {
      const promised = shown === 'valid' || shown === 'resized';
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
      const queuedCount = started.tracks?.length ?? 0;
      const opening = queuedCount === 1 ? '1 opening track queued' : `${queuedCount} opening tracks queued`;
      const unfit = started.unfit
        ? `; ${started.unfit} more would have started after it ends`
        : '';
      notify.ok(started.pickInFlight
        ? `Steer started — ${opening}${unfit}. A pick already under way lands after them, chosen before the steer.`
        : values.startNow && started.kept
          ? `Steer started — ${opening}${unfit}. One track was already on its way to air and plays first.`
          : `Steer started — ${opening}${unfit}.`);
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
              <span className="text-[10px] text-muted">opening tracks to come</span>
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
                ? 'token cap reached: opening tracks still play, then the station coasts'
                : 'saving tokens: the steer only reorders tracks already in reach'}
            </div>
          )}
          <Btn sm className="w-full" disabled={busy} onClick={clear}>
            {busy ? 'clearing…' : 'Clear steer'}
          </Btn>
        </div>
      ) : (
        <div className="@container grid gap-5">
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <FieldLabel>Playlist</FieldLabel>
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
                plays only this list, no repeats until it runs through
              </span>
            </div>
            <div className="grid gap-1">
              <TextareaField
                control={form.control}
                name="prompt"
                label={hasPlaylist ? 'Direction (optional)' : 'Direction'}
                rows={2}
                maxLength={STEER_PROMPT_MAX}
                placeholder="more upbeat 2020s pop, and keep the talk short"
              />
              <div className="flex justify-between gap-3 text-[10px] text-muted">
                <span>nudges picks and talk; can't add music</span>
                <span className="mono-num whitespace-nowrap">{promptLength} / {STEER_PROMPT_MAX}</span>
              </div>
            </div>
          </div>
          <div className="grid gap-1.5">
            <div className="flex items-end justify-between gap-3">
              <FieldLabel>For how long</FieldLabel>
              <span className="mono-num flex items-baseline gap-1.5 text-[var(--accent)]" aria-live="polite">
                {until === 'once'
                  ? <span className="text-[12px] font-bold tracking-[0.12em] uppercase">one track</span>
                  : endsAt != null
                    ? <><span className="text-[10px] text-muted">until</span><span className="text-[22px] leading-none font-bold">{fmtClock(endsAt, tz, locale)}</span></>
                    : <span className="text-[12px] text-muted">—</span>}
              </span>
            </div>
            <Controller
              control={form.control}
              name="until"
              render={({ field }) => (
                <Seg
                  aria-label="Steer duration"
                  fill="grid-cols-3 @min-[440px]:grid-cols-6"
                  value={field.value === 'once' ? ONCE_SEG : field.value === 'schedule-change' ? SCHEDULE_SEG : String(minutes ?? '')}
                  options={[
                    { id: ONCE_SEG, label: 'once', title: 'Queue one track and store no steer' },
                    ...PRESETS.map(m => ({ id: String(m), label: m < 60 ? `${m}m` : `${m / 60}h` })),
                    { id: SCHEDULE_SEG, label: 'next show', title: 'Until the weekly schedule moves to the next show' },
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
            {until === 'fixed' && (
              <div className="flex items-center gap-2 text-[10px] text-muted">
                <span>or exactly</span>
                <TextField
                  control={form.control}
                  name="minutes"
                  label="Minutes"
                  numeric
                  className="w-20 min-w-0 [&_[data-slot=field-label]]:sr-only"
                  min={STEER_MIN_MINUTES}
                  max={STEER_MAX_MINUTES}
                />
                <span>min</span>
              </div>
            )}
            {untilSchedule && (
              <span className="text-[10px] text-muted">
                {windowQuery.isError
                  ? 'schedule unavailable; the end is set when you start'
                  : windowQuery.data ? `until the next show · ${windowQuery.data.minutes} min` : 'reading the schedule…'}
              </span>
            )}
            {until === 'once' && <span className="text-[10px] text-muted">no steer kept</span>}
          </div>
          <div className="grid gap-3 @min-[480px]:grid-cols-2 [&_[data-slot=field-description]]:text-[11px] [&_[data-slot=field-description]]:leading-snug">
            <SwitchField
              control={form.control}
              name="startNow"
              label="Start now"
              description="skip the track already queued"
            />
            <SwitchField
              control={form.control}
              name="introduce"
              label="Introduce on air"
              description="the host flags the change before the first track"
            />
          </div>
          {preview && preview.picks.length > 0 && (
            <div className={cn('grid gap-0.5 border px-2.5 py-2 text-[11px]', shown === 'stale' ? 'border-ink/15 text-muted line-through' : 'border-ink/30 text-ink')}>
              <span className="text-[10px] text-muted no-underline">opening tracks</span>
              {preview.picks.map((t, i) => (
                <span key={t.id} className={cn('truncate', shown === 'valid' && i >= preview.fit && 'text-muted')}>
                  <span className="mono-num text-muted">{i + 1}.</span> {t.title} <span className="text-muted">— {t.artist}</span>
                </span>
              ))}
              {shown === 'valid' && preview.fit < preview.picks.length && (
                <span className="text-[10px] text-muted">
                  {preview.picks.length - preview.fit === 1
                    ? 'the last runs past the end, so it is dropped'
                    : `the last ${preview.picks.length - preview.fit} run past the end, so they are dropped`}
                </span>
              )}
            </div>
          )}
          <div className="grid gap-2 border-t border-ink/15 pt-3">
          <div className="text-[11px] text-ink">{startSentence(preview, inputs, now)}</div>
          <div className="grid grid-cols-2 gap-2">
            <Btn
              sm
              disabled={busy || !form.formState.isValid || shown === 'valid'}
              onClick={runPreview}
              title={shown === 'valid'
                ? 'Change the playlist, direction or length to preview again'
                : shown === 'resized' ? 'No model call: the tracks are remembered' : 'One model call'}
            >
              {previewMutation.isPending
                ? 'working it out…'
                : shown === 'resized' ? 'Preview (no model call)' : 'Preview (one model call)'}
            </Btn>
            <Btn tone="accent" sm disabled={busy || !form.formState.isValid} onClick={start}>
              {startMutation.isPending ? 'starting…' : 'Start steer →'}
            </Btn>
          </div>
          <div className="text-[10px] text-muted">
            schedule untouched · ends any takeover
          </div>
          </div>
        </div>
      )}
    </Card>
  );
}

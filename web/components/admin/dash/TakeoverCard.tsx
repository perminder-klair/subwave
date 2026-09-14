'use client';

// Show takeover (#930/#1507) -- pin a show or Default programming over the
// weekly grid for a bounded window. Unlike the other dash cards this one fetches
// for itself: GET /schedule and the two /schedule/override mutations are the
// only calls on this screen no other card wants.

import { useEffect, useState } from 'react';
import { Controller } from 'react-hook-form';
import type { z } from 'zod';
import Link from 'next/link';
import { useAdminAuth } from '../../../lib/adminAuth';
import { useAdminMutation, useAdminQuery } from '../../../lib/admin-query';
import { notify, errorMessage } from '../../../lib/notify';
import { fmtClock } from '../../../lib/format';
import type { StationLocale } from '../../../lib/types';
import { cn } from '../../../lib/cn';
import { useZodForm, applyServerFieldErrors } from '@/lib/form';
import { TextField } from '@/lib/form-fields';
import { Card, Btn, Pill, Seg } from '../ui';
import { ColorChip, SlotMenu } from '../schedule/bits';
import { SHOW_COLORS } from '../schedule/lib';
// The pin's shape and its minute bounds come from the shared schema, and POST
// /schedule/override runs the same rule at the route.
import {
  isDefaultTakeover,
  scheduleOverrideRequestSchema,
  takeoverShowId,
  OVERRIDE_MIN_MINUTES,
  OVERRIDE_MAX_MINUTES,
  type ScheduleOverride,
} from '@/lib/schemas.generated';
import {
  dashKeys,
  fetchTakeover,
  fetchTakeoverWindow,
  writeTakeoverOverride,
  type TakeoverData,
  type TakeoverWindow,
} from './queries';

const PRESETS = [
  { minutes: 60, label: '1h' },
  { minutes: 120, label: '2h' },
  { minutes: 180, label: '3h' },
];

// The Seg's id for "until the schedule changes" (#1601). Not a duration, so it
// cannot be a minute count like the three presets beside it.
const SCHEDULE_SEG = 'schedule';

// The submitted body IS the schema's output, spelled that way rather than
// re-typed, so a field added to the request cannot be dropped silently.
type PinVars = z.output<typeof scheduleOverrideRequestSchema>;

// One line saying WHY the resolved end is where it is, keyed by the source the
// controller reports. There is no 'minimum': a near boundary resolves to that
// boundary, so 'schedule' covers it.
const WINDOW_REASON: Record<TakeoverWindow['source'], string> = {
  schedule: 'when the schedule moves on',
  maximum: 'no schedule change in reach',
  ceiling: 'the next change is further out than a takeover can run',
};

export function TakeoverCard({ tz, locale }: { tz?: string; locale?: StationLocale }) {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [now, setNow] = useState(() => Date.now());

  // Empty string is the untouched picker and remains invalid; null is a
  // deliberate Default programming selection. The shared schema preserves that
  // distinction all the way to POST /schedule/override.
  const form = useZodForm(scheduleOverrideRequestSchema, { showId: '', minutes: 60, until: 'fixed' });
  // The 30s tick refreshes `shows` and `override`, never the form -- a poll must
  // not clobber a half-typed window, which is why there is no `values` prop.

  // GET /schedule carries the roster and the pin in force. Query success also
  // advances the "min left" clock.
  const takeoverQuery = useAdminQuery<TakeoverData>({
    key: dashKeys.takeover(),
    adminFetch,
    enabled: hydrated && !needsAuth,
    staleTime: 0,
    refetchInterval: () => 30_000,
    request: fetchTakeover,
  });
  const shows = takeoverQuery.data?.shows ?? [];
  const override = takeoverQuery.data?.override ?? null;

  // The resolved end time for "until the schedule changes", fetched only while
  // that option is selected: the controller's scan walks a minute at a time
  // across twelve hours.
  const minutes = form.watch('minutes');
  const untilSchedule = form.watch('until') === 'schedule-change';
  const windowQuery = useAdminQuery<TakeoverWindow>({
    key: dashKeys.takeoverWindow(),
    adminFetch,
    enabled: hydrated && !needsAuth && untilSchedule,
    staleTime: 0,
    refetchInterval: () => 30_000,
    request: fetchTakeoverWindow,
  });
  // When this selection began. React Query keeps `data` both while a query is
  // DISABLED and after a refetch FAILS, and an `expiresAt` is an absolute
  // instant, so a cached one from an earlier visit paints an end time that may
  // already be past. Requiring the data to be newer than the selection is what
  // shows "reading the schedule..." for one round trip instead.
  const [selectedAt, setSelectedAt] = useState(0);
  useEffect(() => { setSelectedAt(untilSchedule ? Date.now() : 0); }, [untilSchedule]);
  const windowIsCurrent = untilSchedule
    && selectedAt > 0
    && !windowQuery.isError
    && windowQuery.dataUpdatedAt >= selectedAt;
  const resolvedWindow = windowIsCurrent ? windowQuery.data ?? null : null;
  useEffect(() => {
    if (takeoverQuery.dataUpdatedAt) setNow(Date.now());
  }, [takeoverQuery.dataUpdatedAt]);
  // Query polling stops in hidden tabs and a failed poll has no dataUpdatedAt,
  // so advance the local display clock independently.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // Same index-into-the-roster colour the board and the shows page paint with.
  const colorOf = (id: string): string => {
    const idx = shows.findIndex(s => s.id === id);
    return idx >= 0 ? (SHOW_COLORS[idx % SHOW_COLORS.length] ?? 'transparent') : 'transparent';
  };
  const showById = (id: string) => shows.find(s => s.id === id) ?? null;

  const live = override && override.expiresAt > now ? override : null;
  const pinnedId = takeoverShowId(live);
  const pinned = pinnedId ? showById(pinnedId) : null;
  const defaultTakeover = isDefaultTakeover(live);
  const minutesLeft = live ? Math.max(1, Math.ceil((live.expiresAt - now) / 60_000)) : 0;

  interface PinResult {
    override?: ScheduleOverride;
  }
  class TakeoverError extends Error {
    constructor(message: string, readonly fieldErrors?: Record<string, string>) {
      super(message);
    }
  }
  const pinMutation = useAdminMutation<PinResult, PinVars>({
    adminFetch,
    toastOnError: false,
    request: async (values, fetcher) => {
      const response = await fetcher('/schedule/override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const body = await response.json().catch(() => ({})) as PinResult & {
        error?: string;
        fieldErrors?: Record<string, string>;
      };
      if (!response.ok) {
        throw new TakeoverError(body.error || `failed (${response.status})`, body.fieldErrors);
      }
      return body;
    },
    onDone: async (data, _values, client) => {
      writeTakeoverOverride(client, data.override ?? null);
      await client.invalidateQueries({ queryKey: dashKeys.takeover() });
    },
  });
  const cancelMutation = useAdminMutation<void, void>({
    adminFetch,
    toastOnError: false,
    request: async (_vars, fetcher) => {
      const response = await fetcher('/schedule/override', { method: 'DELETE' });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || `failed (${response.status})`);
    },
    onDone: async (_data, _vars, client) => {
      writeTakeoverOverride(client, null);
      await client.invalidateQueries({ queryKey: dashKeys.takeover() });
    },
  });
  const busy = pinMutation.isPending || cancelMutation.isPending;

  const pin = form.handleSubmit(async (values) => {
    try {
      await pinMutation.mutateAsync(values);
      const chosenId = takeoverShowId(values);
      if (isDefaultTakeover(values)) {
        notify.ok('Default programming takes over — the switch airs on the next track.');
      } else {
        const name = (chosenId && showById(chosenId)?.name) || 'show';
        notify.ok(`“${name}” takes over — the switch airs on the next track.`);
      }
    } catch (e) {
      if (e instanceof TakeoverError) applyServerFieldErrors(form, e.fieldErrors);
      notify.err(errorMessage(e));
    }
  });

  const cancel = async () => {
    try {
      await cancelMutation.mutateAsync();
      // Back to a clean picker rather than re-showing the just-cancelled pick:
      // one form stands behind both branches of the ternary.
      form.reset({ showId: '', minutes: 60, until: 'fixed' });
      notify.ok('Takeover cancelled — back to the weekly schedule.');
    } catch (e) {
      notify.err(errorMessage(e));
    }
  };

  const onAir = !!(live && (pinned || defaultTakeover));

  return (
    <Card
      title="Takeover"
      // No sub while one is live -- a third line of the same news wraps the header.
      sub={onAir ? undefined : 'jump a show to the front'}
      // Box-shadow, not a border: `.admin-root .card` owns the border at a
      // higher specificity than any utility class.
      className={cn(onAir && 'shadow-[0_0_0_2px_color-mix(in_oklab,var(--accent)_28%,transparent)]')}
      right={
        <span className="flex items-center gap-2">
          {onAir && (
            <Pill tone="accent" dot>
              on air
            </Pill>
          )}
          <Link
            href="/admin/shows/schedule"
            className="inline-flex min-h-9 items-center text-[9px] font-bold tracking-[0.2em] text-muted uppercase hover:text-ink sm:min-h-0"
          >
            the week →
          </Link>
        </span>
      }
    >
      {live && (pinned || defaultTakeover) ? (
        <div className="grid gap-2.5">
          <div className="grid gap-1 border border-[color-mix(in_oklab,var(--accent)_35%,transparent)] bg-[var(--accent-soft)] px-2.5 py-2">
            <div className="flex items-baseline gap-2">
              <ColorChip
                color={pinned ? colorOf(pinned.id) : null}
                className="size-[11px] self-center"
              />
              <span className="min-w-0 truncate text-[13px] font-bold text-ink">
                {pinned?.name ?? 'Default programming'}
              </span>
              <span className="mono-num ml-auto flex-none text-[10px] whitespace-nowrap text-muted">
                ends {fmtClock(live.expiresAt, tz, locale)}
              </span>
            </div>
            <div className="text-[10px] text-muted">
              {defaultTakeover ? 'autonomous music · default DJ' : 'on air over the schedule'}
              {' · '}{minutesLeft} min left
            </div>
          </div>
          <Btn sm className="w-full" disabled={busy} onClick={cancel}>
            {busy ? 'cancelling…' : 'Cancel takeover'}
          </Btn>
        </div>
      ) : shows.length === 0 ? (
        <div className="text-muted italic">
          no shows to pin —{' '}
          <Link href="/admin/shows" className="underline hover:text-ink">
            build one first
          </Link>
        </div>
      ) : (
        <div className="grid gap-2.5">
          <Controller
            control={form.control}
            name="showId"
            render={({ field }) => {
              // The selected menu key IS the takeover target this form will
              // submit, so it is read through the same two predicates rather
              // than a third spelling of `=== null` (#1507).
              const chosen = { showId: field.value };
              const chosenId = takeoverShowId(chosen);
              return (
                <SlotMenu
                  ariaLabel="Choose takeover programming"
                  // justify-self, not self-start: the grid otherwise stretches
                  // the slot to full width, where it reads as a text field.
                  className="min-h-9 justify-self-start text-[12px] sm:min-h-0"
                  label={isDefaultTakeover(chosen)
                    ? 'Default programming'
                    : (chosenId && showById(chosenId)?.name) || 'Choose programming…'}
                  chipColor={isDefaultTakeover(chosen)
                    ? null
                    : chosenId ? colorOf(chosenId) : undefined}
                  options={[
                    { key: null, label: 'Default programming', chipColor: null },
                    ...shows.map(s => ({ key: s.id, label: s.name, chipColor: colorOf(s.id) })),
                  ]}
                  onSelect={field.onChange}
                />
              );
            }}
          />
          <div className="flex flex-wrap items-center gap-2.5">
            {/* One control over two form fields: the three presets set a fixed
                window, the fourth switches to the boundary the controller
                resolves. Picking it CLEARS `minutes` rather than leaving the old
                value under the hidden input. */}
            <Controller
              control={form.control}
              name="until"
              render={({ field }) => (
                <Seg
                  value={field.value === 'schedule-change' ? SCHEDULE_SEG : String(minutes ?? '')}
                  options={[
                    ...PRESETS.map(p => ({ id: String(p.minutes), label: p.label })),
                    { id: SCHEDULE_SEG, label: 'til change', title: 'End when the weekly schedule would have moved on' },
                  ]}
                  onChange={id => {
                    if (id === SCHEDULE_SEG) {
                      field.onChange('schedule-change');
                      form.setValue('minutes', undefined, { shouldValidate: true });
                      return;
                    }
                    field.onChange('fixed');
                    form.setValue('minutes', Number(id), { shouldValidate: true });
                  }}
                />
              )}
            />
            {/* Hidden rather than disabled under the schedule option: a minute
                box beside a server-resolved window reads as the thing being
                submitted, and it is not. */}
            {!untilSchedule && (
              <TextField
                control={form.control}
                name="minutes"
                label="Takeover minutes"
                numeric
                className="max-w-32"
                min={OVERRIDE_MIN_MINUTES}
                max={OVERRIDE_MAX_MINUTES}
              />
            )}
          </div>
          {/* The failure states are checked FIRST inside this line: `data`
              survives an error and a disable, so reading it first meant the
              outage copy could never be reached once one fetch had landed. */}
          {untilSchedule && (
            <div className="mono-num text-[10px] text-muted">
              {windowQuery.isError
                ? 'could not read the schedule — the window is resolved again when you start it'
                : resolvedWindow
                  ? `ends ${fmtClock(resolvedWindow.expiresAt, tz, locale)} · ${resolvedWindow.minutes} min · ${WINDOW_REASON[resolvedWindow.source]}`
                  : 'reading the schedule…'}
            </div>
          )}
          <Btn
            tone="accent"
            sm
            className="w-full"
            disabled={busy || !form.formState.isValid}
            onClick={pin}
          >
            {busy ? 'starting…' : 'Take over →'}
          </Btn>
          <div className="text-[10px] text-muted">
            the switch airs on the next track · the schedule picks up again after
          </div>
        </div>
      )}
    </Card>
  );
}

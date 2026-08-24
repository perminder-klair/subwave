'use client';

// Show takeover (#930) — pin one show over the weekly grid for a bounded window.
// Unlike the other dash cards this one fetches for itself: GET /schedule and the two
// /schedule/override mutations are the only calls on this screen no other card wants.

import { useEffect, useState } from 'react';
import { Controller } from 'react-hook-form';
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
// The pin's shape and its minute bounds come from the shared schema
// (controller/src/schemas/schedule.ts) — POST /schedule/override runs the same
// rule at the route, so the form's validation and the server's answer agree by
// construction.
import {
  scheduleOverrideRequestSchema,
  OVERRIDE_MIN_MINUTES,
  OVERRIDE_MAX_MINUTES,
  type ScheduleOverride,
} from '@/lib/schemas.generated';
import { dashKeys, fetchTakeover, writeTakeoverOverride, type TakeoverData } from './queries';

const PRESETS = [
  { minutes: 60, label: '1h' },
  { minutes: 120, label: '2h' },
  { minutes: 180, label: '3h' },
];

export function TakeoverCard({ tz, locale }: { tz?: string; locale?: StationLocale }) {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [now, setNow] = useState(() => Date.now());

  const form = useZodForm(scheduleOverrideRequestSchema, { showId: '', minutes: 60 });
  // The 30s tick refreshes `shows` and `override`, never the form — a poll must
  // not clobber a half-typed window. This is why there is no `values` prop here.

  // GET /schedule carries the roster and the pin in force (expired or dangling
  // ones already report as null). Query success also advances the "min left" clock.
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
  useEffect(() => {
    if (takeoverQuery.dataUpdatedAt) setNow(Date.now());
  }, [takeoverQuery.dataUpdatedAt]);
  // Query polling stops in hidden tabs and a failed poll has no dataUpdatedAt.
  // Advance the local display clock independently so minutes-left and expiry
  // cannot freeze on the last successful schedule response.
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
  const pinned = live ? showById(live.showId) : null;
  const minutesLeft = live ? Math.max(1, Math.ceil((live.expiresAt - now) / 60_000)) : 0;

  interface PinResult {
    override?: ScheduleOverride;
  }
  class TakeoverError extends Error {
    constructor(message: string, readonly fieldErrors?: Record<string, string>) {
      super(message);
    }
  }
  const pinMutation = useAdminMutation<PinResult, { showId: string; minutes: number }>({
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
      const name = showById(values.showId)?.name || 'show';
      notify.ok(`“${name}” takes over — the switch airs on the next track.`);
    } catch (e) {
      if (e instanceof TakeoverError) applyServerFieldErrors(form, e.fieldErrors);
      notify.err(errorMessage(e));
    }
  });

  const cancel = async () => {
    try {
      await cancelMutation.mutateAsync();
      // Back to a clean picker rather than re-showing the just-cancelled pick:
      // one form stands behind both branches of the ternary, so a stale value
      // would otherwise survive the remount.
      form.reset({ showId: '', minutes: 60 });
      notify.ok('Takeover cancelled — back to the weekly schedule.');
    } catch (e) {
      notify.err(errorMessage(e));
    }
  };

  const onAir = !!(live && pinned);

  return (
    <Card
      title="Takeover"
      // No sub while one is live — a third line of the same news wraps the header.
      sub={onAir ? undefined : 'jump a show to the front'}
      // Box-shadow, not a border: `.admin-root .card` owns the border at a higher
      // specificity than any utility class can beat.
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
      {live && pinned ? (
        <div className="grid gap-2.5">
          <div className="grid gap-1 border border-[color-mix(in_oklab,var(--accent)_35%,transparent)] bg-[var(--accent-soft)] px-2.5 py-2">
            <div className="flex items-baseline gap-2">
              <ColorChip color={colorOf(pinned.id)} className="size-[11px] self-center" />
              <span className="min-w-0 truncate text-[13px] font-bold text-ink">{pinned.name}</span>
              <span className="mono-num ml-auto flex-none text-[10px] whitespace-nowrap text-muted">
                ends {fmtClock(live.expiresAt, tz, locale)}
              </span>
            </div>
            <div className="text-[10px] text-muted">
              on air over the schedule · {minutesLeft} min left
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
            render={({ field }) => (
              <SlotMenu
                ariaLabel="Pin a show"
                // justify-self, not self-start: the grid otherwise stretches the slot to
                // full width, where it reads as a text field rather than a value you pick.
                className="min-h-9 justify-self-start text-[12px] sm:min-h-0"
                label={showById(field.value)?.name ?? 'Pin a show…'}
                chipColor={field.value ? colorOf(field.value) : undefined}
                options={shows.map(s => ({ key: s.id, label: s.name, chipColor: colorOf(s.id) }))}
                onSelect={field.onChange}
              />
            )}
          />
          <div className="flex flex-wrap items-center gap-2.5">
            <Controller
              control={form.control}
              name="minutes"
              render={({ field }) => (
                <Seg
                  value={String(field.value)}
                  options={PRESETS.map(p => ({ id: String(p.minutes), label: p.label }))}
                  onChange={id => field.onChange(Number(id))}
                />
              )}
            />
            <TextField
              control={form.control}
              name="minutes"
              label="Takeover minutes"
              numeric
              className="max-w-32"
              min={OVERRIDE_MIN_MINUTES}
              max={OVERRIDE_MAX_MINUTES}
            />
          </div>
          <Btn
            tone="accent"
            sm
            className="w-full"
            disabled={busy || !form.formState.isValid}
            onClick={pin}
          >
            {busy ? 'pinning…' : 'Pin to air →'}
          </Btn>
          <div className="text-[10px] text-muted">
            the switch airs on the next track · the schedule picks up again after
          </div>
        </div>
      )}
    </Card>
  );
}

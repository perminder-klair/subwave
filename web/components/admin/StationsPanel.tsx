'use client';

// Stations rack. Installs are capped at MAX_STATIONS=8 server-side (GET
// /stations `limit`). Activating a station — or creating the SECOND station,
// which converts a single-station install — restarts the controller, so both
// flows funnel into one full-screen "re-tuning" state that hard-reloads once
// /state reports the new station booted (boot-frozen station.id).
// API: controller/src/routes/stations.ts.

import { useMemo, useRef, useState } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';
import { AdminResponseError, adminJson, useAdminMutation } from '../../lib/admin-query';
import { CONVERT_SENTINEL, useStationSwitchPoll } from '../../hooks/useStationSwitch';
import { useDynamicStyle } from '../../hooks/useDynamicStyle';
import { notify, errorMessage } from '../../lib/notify';
import { cn } from '../../lib/cn';
import { useZodForm, applyServerFieldErrors, fieldAria } from '@/lib/form';
import {
  slugifyStationName,
  stationCreateSchema,
  stationRenameSchema,
  type StationCreateMode,
} from '@/lib/schemas.generated';
import { Plus } from 'lucide-react';
import { Btn } from './ui';
import { Input } from '../ui/input';
import { Field, FieldLabel, FieldDescription, FieldError } from '@/components/ui/field';
import { Modal } from '../ui/modal';
import { V3AlertDialog } from '../ui/alert-dialog';
import styles from './StationsPanel.module.css';
import {
  operationKeys,
  useStationsQuery,
  type StationRow,
} from './operations-queries';

interface StationCreateReceipt {
  switching?: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
}

// A stable pseudo-frequency on the 88–108 FM band, hashed from the station id
// so it keeps its spot as the rack changes. Pure presentation.
function assignFrequencies(stations: StationRow[]): Map<string, number> {
  const taken = new Set<number>();
  const out = new Map<string, number>();
  for (const s of stations) {
    const key = s.id ?? '__install';
    let h = 7;
    for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    let f = (881 + (h % 199)) / 10;
    while (taken.has(f)) f = f + 0.7 > 107.9 ? 88.3 : Math.round((f + 0.7) * 10) / 10;
    taken.add(f);
    out.set(key, f);
  }
  return out;
}

const bandPct = (f: number) => `${(((f - 87) / 21) * 100).toFixed(2)}%`;

const DIAL_MARKS = [
  { label: '88', left: 'left-[4.76%]' },
  { label: '92', left: 'left-[23.81%]' },
  { label: '96', left: 'left-[42.86%]' },
  { label: '100', left: 'left-[61.90%]' },
  { label: '104', left: 'left-[80.95%]' },
  { label: '108', left: 'left-[100%]' },
];

function DialPin({ left, name, live }: { left: string; name: string; live: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useDynamicStyle(ref, { left });
  return (
    <div ref={ref} className="absolute inset-y-0 w-0">
      {live ? (
        <>
          <div className="absolute inset-y-0 -left-px w-0.5 bg-vermilion" />
          <div className="absolute top-2 left-0 -translate-x-1/2 bg-vermilion px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-[0.14em] whitespace-nowrap text-[var(--bg)] uppercase">
            {name}
          </div>
        </>
      ) : (
        <>
          <div className="absolute bottom-[22px] -left-0.5 size-1 bg-ink" />
          <div className="absolute top-3 left-0 -translate-x-1/2 font-mono text-[9px] tracking-[0.12em] whitespace-nowrap text-muted uppercase">
            {name}
          </div>
        </>
      )}
    </div>
  );
}

function OnAirChip() {
  return (
    <span className="inline-flex items-center gap-1.5 bg-vermilion px-2 py-1 font-mono text-[10px] font-bold tracking-[0.18em] text-[var(--bg)] uppercase">
      <span className={cn(styles.blink, 'size-1.5 bg-[var(--bg)]')} />
      on air
      <span className="inline-flex h-3 items-end gap-0.5">
        {[0, 1, 2, 3, 4].map(i => (
          <span key={i} className={cn(styles.vuBar, 'h-3 w-0.5 bg-[var(--bg)]')} />
        ))}
      </span>
    </span>
  );
}

export default function StationsPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const stationsQuery = useStationsQuery(adminFetch, hydrated && !needsAuth);
  const data = stationsQuery.data ?? null;
  const err = stationsQuery.error ? errorMessage(stationsQuery.error) : null;
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ type: 'live' | 'del'; s: StationRow } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [renaming, setRenaming] = useState<StationRow | null>(null);
  // Both dialogs validate against the SAME schemas the controller enforces, so
  // an over-long or empty name is refused under the input before a request is
  // sent — and the messages match the ones a 400 would carry.
  const createForm = useZodForm(stationCreateSchema, { name: '', mode: 'fresh' });
  const renameForm = useZodForm(stationRenameSchema, { name: '' });
  const createName = createForm.watch('name');
  // `mode` is optional in z.input because the schema defaults it — the ?? just
  // restates that default, since every reset() below sets it explicitly.
  const createMode = createForm.watch('mode') ?? 'fresh';
  const setCreateMode = (mode: StationCreateMode) =>
    createForm.setValue('mode', mode, { shouldValidate: true, shouldDirty: true });
  const createErrors = createForm.formState.errors;
  const renameErrors = renameForm.formState.errors;
  const createNameAria = fieldAria('station-name', createErrors.name, { hasDescription: true });
  const createModeAria = fieldAria('station-mode', createErrors.mode);
  const renameAria = fieldAria('station-rename', renameErrors.name);
  // Non-null while a switch is in flight: the target station id, or the
  // CONVERT_SENTINEL for a fresh-install → multi-station conversion.
  const [switching, setSwitching] = useState<string | null>(null);
  const [switchingLabel, setSwitchingLabel] = useState('');
  useStationSwitchPoll(switching);

  const createMutation = useAdminMutation<StationCreateReceipt, { name: string; mode: StationCreateMode }>({
    adminFetch,
    request: (values, fetcher) => adminJson<StationCreateReceipt>(fetcher, '/stations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(values),
    }),
    onDone: async (receipt, _values, client) => {
      if (!receipt.switching) {
        await client.invalidateQueries({ queryKey: operationKeys.stations(), exact: true });
      }
    },
    toastOnError: false,
  });
  const deleteMutation = useAdminMutation<void, string>({
    adminFetch,
    request: async (id, fetcher) => {
      await adminJson(fetcher, `/stations/${id}`, { method: 'DELETE' });
    },
    onDone: async (_receipt, _id, client) => {
      await client.invalidateQueries({ queryKey: operationKeys.stations(), exact: true });
    },
    toastOnError: false,
  });
  const renameMutation = useAdminMutation<void, { id: string; name: string }>({
    adminFetch,
    request: async ({ id, name }, fetcher) => {
      await adminJson(fetcher, `/stations/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
    },
    onDone: async (_receipt, _vars, client) => {
      await client.invalidateQueries({ queryKey: operationKeys.stations(), exact: true });
    },
    toastOnError: false,
  });

  const stations = useMemo(() => data?.stations ?? [], [data]);
  const freqs = useMemo(() => assignFrequencies(stations), [stations]);
  const singleMode = !data?.multiStation;
  const live = stations.find(s => s.active) ?? null;
  const limit = data?.limit ?? 8;
  const atCap = stations.length >= limit;

  const create = createForm.handleSubmit(async (values) => {
    setBusy(true);
    try {
      const j = await createMutation.mutateAsync(values);
      if (j.error) {
        // Converted-but-create-failed wedge: the conversion is durable and the
        // controller restarts regardless — enter the re-tuning state anyway.
        if (j.switching) {
          notify.err(
            `Create failed: ${j.error} — the controller is restarting anyway to finish converting to multi-station.`,
          );
          setCreateOpen(false);
          setSwitchingLabel('converting install to multi-station');
          setSwitching(CONVERT_SENTINEL);
          return;
        }
        // "no active station to duplicate from" is a rule only the server can
        // check — it reads the live pointer off disk — so it comes back keyed
        // to `mode` and lands under the Fresh/Duplicate picker, where the fix
        // (choose Fresh) actually is.
        applyServerFieldErrors(createForm, j.fieldErrors);
        throw new Error(j.error);
      }
      setCreateOpen(false);
      createForm.reset({ name: '', mode: 'fresh' });
      if (j.switching) {
        notify.info('Converting to multi-station — the controller is restarting.');
        setSwitchingLabel('converting install to multi-station');
        setSwitching(CONVERT_SENTINEL);
      } else {
        notify.ok('Station racked — offline until you make it live.');
      }
    } catch (e) {
      const body = e instanceof AdminResponseError ? e.body as StationCreateReceipt : null;
      if (body?.switching) {
        notify.err(
          `Create failed: ${body.error || errorMessage(e)} — the controller is restarting anyway to finish converting to multi-station.`,
        );
        setCreateOpen(false);
        setSwitchingLabel('converting install to multi-station');
        setSwitching(CONVERT_SENTINEL);
        return;
      }
      if (body?.fieldErrors) applyServerFieldErrors(createForm, body.fieldErrors);
      notify.err(`Create failed: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  });

  const activate = async (s: StationRow) => {
    if (!s.id) return;
    setBusy(true);
    try {
      await adminJson(adminFetch, `/stations/${s.id}/activate`, { method: 'POST' });
      setSwitchingLabel(`tuning to ${s.name}`);
      setSwitching(s.id);
    } catch (e) {
      notify.err(`Switch failed: ${errorMessage(e)}`);
      setBusy(false);
    }
  };

  const remove = async (s: StationRow) => {
    if (!s.id) return;
    setBusy(true);
    try {
      await deleteMutation.mutateAsync(s.id);
      notify.ok(`“${s.name}” deleted — data directory erased.`);
    } catch (e) {
      notify.err(`Delete failed: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const rename = renameForm.handleSubmit(async (values) => {
    if (!renaming?.id) return;
    setBusy(true);
    try {
      await renameMutation.mutateAsync({ id: renaming.id, name: values.name });
      // The schema trimmed it, so this is the name the card actually carries.
      notify.ok(`Renamed to “${values.name}”.`);
      setRenaming(null);
    } catch (e) {
      if (e instanceof AdminResponseError) {
        applyServerFieldErrors(renameForm, e.body.fieldErrors);
      }
      notify.err(`Rename failed: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  });

  if (!hydrated || needsAuth) return null;

  // The re-tuning screen replaces everything until the new controller answers
  // and the page reloads itself.
  if (switching) {
    return (
      <div className="fixed inset-0 z-[100] grid place-items-center bg-[var(--bg)]">
        <div className="grid max-w-[560px] justify-items-center gap-4 p-8 text-center">
          <div
            className={cn(
              styles.blink,
              'inline-flex items-center gap-2 bg-vermilion px-3 py-1.5 font-mono text-[11px] font-bold tracking-[0.24em] text-[var(--bg)] uppercase',
            )}
          >
            re-tuning
          </div>
          <h2 className="m-0 font-display text-[44px] leading-[1.05] font-semibold text-ink">
            Switching stations…
          </h2>
          <div className="font-mono text-xs font-bold tracking-[0.16em] text-vermilion uppercase">
            {switchingLabel}
          </div>
          <div className={cn(styles.stripes, 'h-2.5 w-[340px] max-w-[80vw] border border-ink')} />
          <p className="m-0 text-[13px] leading-relaxed text-muted">
            The mixer and controller are restarting. Every listener drops for about ten seconds
            and reconnects automatically — this page reloads itself when the new carrier locks.
          </p>
        </div>
      </div>
    );
  }

  const loading = data === null && !err;

  return (
    <div className="grid gap-4">
      <section className="card">
      <header className="p-5">
        <div className="font-mono text-[10px] font-bold tracking-[0.22em] text-vermilion uppercase">
          transmitter rack — admin
        </div>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
          <h1 className="m-0 font-display text-[42px] leading-none font-semibold text-ink">
            Stations<span className="text-vermilion">.</span>
          </h1>
          <div className="flex flex-wrap items-center gap-4">
            <div className="font-mono text-[11px] tracking-[0.14em] text-muted uppercase">
              {data ? `${live ? 1 : 0} of ${stations.length} on air` : '—'}
            </div>
            {atCap ? (
              <div className="font-mono text-[10px] font-bold tracking-[0.16em] text-vermilion uppercase">
                rack full — {limit} max
              </div>
            ) : null}
            <Btn
              tone="solid"
              lg
              disabled={busy || loading || atCap}
              onClick={() => {
                createForm.reset({ name: '', mode: 'fresh' });
                setCreateOpen(true);
              }}
            >
              <Plus />
              New station
            </Btn>
          </div>
        </div>
        <p className="mt-3 mb-0 max-w-[600px] text-sm leading-relaxed text-muted">
          Every station keeps its own settings, schedule and library — switching just moves the
          carrier. For now, exactly one broadcasts at a time; simultaneous streams come later.
        </p>
      </header>

      {data ? (
        <div className="border-t border-ink px-5 pt-4 pb-3">
          <div className="relative h-[88px] border-y border-ink bg-field">
            <div className={cn(styles.dialFine, 'absolute inset-x-0 bottom-0 h-3')} />
            <div className={cn(styles.dialCoarse, 'absolute inset-x-0 bottom-0 h-5')} />
            {DIAL_MARKS.map(m => (
              <div key={m.label} className={cn('absolute bottom-6 -translate-x-1/2', m.left)}>
                <span className="font-mono text-[9px] text-muted">{m.label}</span>
              </div>
            ))}
            {stations.map(s => (
              <DialPin
                key={s.id ?? '__install'}
                left={bandPct(freqs.get(s.id ?? '__install') ?? 96.7)}
                name={s.name}
                live={s.active}
              />
            ))}
          </div>
          <div className="mt-1.5 flex justify-between font-mono text-[9px] tracking-[0.2em] text-muted uppercase">
            <span>fm band — rack overview</span>
            <span>needle marks the live carrier</span>
          </div>
        </div>
      ) : null}
      </section>

      <section className="card">
      {loading ? (
        <div>
          {[0, 1, 2].map(k => (
            <div
              key={k}
              className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-4 border-t border-separator-strong p-5 first:border-t-0 sm:grid-cols-[96px_1fr_auto] sm:gap-6"
            >
              <div className={cn(styles.shimmer, 'h-12 bg-separator-strong')} />
              <div className="grid gap-2">
                <div className={cn(styles.shimmer, 'h-4 w-[38%] bg-separator-strong')} />
                <div className={cn(styles.shimmer, 'h-2.5 w-[22%] bg-separator-soft')} />
              </div>
              <div className={cn(styles.shimmer, 'hidden h-6 w-[120px] bg-separator-soft sm:block')} />
            </div>
          ))}
          <div className="border-t border-separator-strong px-5 py-3 font-mono text-[10px] tracking-[0.22em] text-muted uppercase">
            Scanning the rack…
          </div>
        </div>
      ) : null}

      {err && !data ? (
        <div className="grid justify-items-start gap-2.5 px-9 py-9">
          <div className="font-mono text-[10px] font-bold tracking-[0.22em] text-vermilion uppercase">
            ▚▚ signal lost
          </div>
          <h2 className="m-0 font-display text-[30px] font-semibold text-ink">
            The station list didn&apos;t load.
          </h2>
          <p className="m-0 max-w-[460px] text-[13px] leading-relaxed text-muted">
            The controller didn&apos;t answer ({err}). Your stations and their data are untouched
            — this is only the admin view failing to reach them.
          </p>
          <div className="mt-2.5">
            <Btn tone="solid" onClick={() => void stationsQuery.refetch()}>
              Retry scan
            </Btn>
          </div>
        </div>
      ) : null}

      {data ? (
        <div>
          {stations.map((s, i) => (
            <div
              key={s.id ?? '__install'}
              /* Phone: preset tile + identity, with the action cluster on its
                 own row — a 96px tile, two 24px gaps and three buttons leave
                 the name column barely 100px wide at 390. */
              className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-x-4 border-t border-separator-strong first:border-t-0 sm:grid-cols-[96px_1fr_auto] sm:gap-6"
            >
              <div
                className={cn(
                  'grid content-center justify-items-center gap-0.5 self-stretch px-2 py-3.5',
                  s.active
                    ? 'bg-vermilion text-[var(--bg)]'
                    : 'border-r border-separator-soft bg-field text-ink',
                )}
              >
                <div
                  className={cn(
                    'font-mono text-[8px] tracking-[0.26em] uppercase',
                    !s.active && 'text-muted',
                  )}
                >
                  preset
                </div>
                <div className="font-display text-[30px] leading-none font-semibold">
                  {String(i + 1).padStart(2, '0')}
                </div>
                <div
                  className={cn(
                    'font-mono text-[9px] tracking-[0.08em]',
                    !s.active && 'text-muted',
                  )}
                >
                  {(freqs.get(s.id ?? '__install') ?? 96.7).toFixed(1)} MHz
                </div>
              </div>

              <div className="grid gap-1.5 py-4 pr-4 sm:pr-0">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="font-display text-[26px] leading-[1.1] font-semibold break-words text-ink">
                    {s.name}
                  </div>
                  {s.active ? <OnAirChip /> : null}
                  {!s.active ? (
                    <span className="inline-flex items-center border border-separator-strong px-2 py-1 font-mono text-[10px] font-bold tracking-[0.18em] text-muted uppercase">
                      standby
                    </span>
                  ) : null}
                  {!s.configured ? (
                    <span className="inline-flex items-center border border-vermilion px-2 py-1 font-mono text-[10px] font-bold tracking-[0.18em] text-vermilion uppercase">
                      needs setup
                    </span>
                  ) : null}
                </div>
                <div className="font-mono text-[11px] tracking-[0.06em] text-muted">
                  {s.id ? `/${s.id}` : 'current install'}
                  {s.createdAt
                    ? ` · est. ${new Date(s.createdAt).toLocaleDateString(undefined, {
                        day: '2-digit',
                        month: 'short',
                        year: 'numeric',
                      })}`
                    : ''}
                </div>
                {!s.configured ? (
                  <div className="text-xs text-muted">
                    Never set up — the onboarding wizard runs when this station goes live.
                  </div>
                ) : null}
              </div>

              <div className="col-span-2 flex flex-wrap items-center justify-start gap-2 pr-5 pb-4 pl-5 sm:col-span-1 sm:justify-end sm:pb-0 sm:pl-0">
                {singleMode ? (
                  <div className="font-mono text-[10px] tracking-[0.16em] text-muted uppercase">
                    single-station install
                  </div>
                ) : (
                  <>
                    {!s.active ? (
                      <Btn
                        tone="accent"
                        sm
                        disabled={busy}
                        onClick={() => setConfirm({ type: 'live', s })}
                      >
                        Make live
                      </Btn>
                    ) : null}
                    <Btn
                      sm
                      disabled={busy}
                      onClick={() => {
                        setRenaming(s);
                        renameForm.reset({ name: s.name });
                      }}
                    >
                      Rename
                    </Btn>
                    {!s.active ? (
                      <Btn
                        tone="danger"
                        sm
                        disabled={busy}
                        onClick={() => setConfirm({ type: 'del', s })}
                      >
                        Delete
                      </Btn>
                    ) : null}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {data && singleMode ? (
        <div className="border-t border-separator-strong px-4 py-4 text-[13px] leading-relaxed text-muted">
          This install hasn&apos;t been converted to multi-station yet — it runs exactly this one
          station. Creating a second station converts the install and restarts the controller,
          and this rack fills up.
        </div>
      ) : null}
      </section>

      <Modal
        open={createOpen}
        onOpenChange={o => {
          if (!o) setCreateOpen(false);
        }}
        title="New station"
        sub={`Up to ${limit} stations per install.`}
        width={560}
        footer={
          <div className="flex justify-end gap-2">
            <Btn onClick={() => setCreateOpen(false)}>Cancel</Btn>
            <Btn
              tone="accent"
              disabled={busy || !createForm.formState.isValid || atCap}
              onClick={() => void create()}
            >
              {busy ? 'Creating…' : singleMode ? 'Create & convert' : 'Create station'}
            </Btn>
          </div>
        }
      >
        <div className="grid gap-4">
          {singleMode ? (
            <div className="border border-vermilion px-3.5 py-3">
              <div className="font-mono text-[10px] font-bold tracking-[0.18em] text-vermilion uppercase">
                this converts the install
              </div>
              <p className="mt-1.5 mb-0 text-xs leading-relaxed text-muted">
                Creating a second station converts this install to multi-station and restarts the
                controller — every listener drops for about 10 seconds.
              </p>
            </div>
          ) : null}
          <Field data-invalid={createNameAria.invalid}>
            <FieldLabel {...createNameAria.labelProps}>Station name</FieldLabel>
            <Input
              {...createForm.register('name')}
              {...createNameAria.controlProps}
              autoFocus
              placeholder="e.g. Night Loop"
              onKeyDown={e => {
                if (e.key === 'Enter' && !busy && !atCap) void create();
              }}
            />
            {/* The exact function the server slugifies with, out of the shared
                schema — this used to be a hand-copied reimplementation that had
                already dropped the "nothing usable" fallback, so a name like
                "!!!" previewed blank and then arrived as /station. */}
            <FieldDescription
              {...createNameAria.descriptionProps}
              className="font-mono text-[10px] tracking-[0.1em] text-muted lowercase"
            >
              slug: {createName.trim() ? slugifyStationName(createName) : '—'}
            </FieldDescription>
            <FieldError
              {...createNameAria.errorProps}
              errors={createErrors.name ? [createErrors.name] : undefined}
            />
          </Field>

          {/* No single labelable control, so the Field names the group itself
              rather than pointing htmlFor at a <div>. The buttons are real
              radios, so the group they belong to has to say so — role="radio"
              outside a radiogroup is an orphan to a screen reader. */}
          <Field data-invalid={createModeAria.invalid}>
            <FieldLabel asChild {...createModeAria.labelledByProps}>
              <span>Starting point</span>
            </FieldLabel>
            <div
              role="radiogroup"
              {...createModeAria.groupProps}
              className="grid grid-cols-1 gap-2.5 sm:grid-cols-2"
            >
              {(
                [
                  {
                    id: 'fresh' as const,
                    label: 'Fresh',
                    desc: 'Empty station. Runs the onboarding wizard the first time it goes live.',
                  },
                  {
                    id: 'duplicate' as const,
                    label: 'Duplicate current',
                    desc: `Copies ${live?.name ?? 'the live station'}'s settings, DJ personas, schedule, library analysis, jingles, beds and voices. Play history starts clean.`,
                  },
                ] as const
              ).map(opt => (
                <button
                  key={opt.id}
                  type="button"
                  role="radio"
                  aria-checked={createMode === opt.id}
                  onClick={() => setCreateMode(opt.id)}
                  className={cn(
                    'cursor-pointer p-3.5 text-left',
                    createMode === opt.id
                      ? 'border border-ink bg-ink-soft'
                      : 'border border-separator-strong',
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span className="inline-flex size-3.5 flex-none items-center justify-center border border-ink">
                      <span
                        className={cn('size-1.5', createMode === opt.id && 'bg-vermilion')}
                      />
                    </span>
                    <span className="font-mono text-[11px] font-bold tracking-[0.16em] text-ink uppercase">
                      {opt.label}
                    </span>
                  </span>
                  <span className="mt-2 block text-xs leading-normal text-muted">{opt.desc}</span>
                </button>
              ))}
            </div>
            <FieldError
              {...createModeAria.errorProps}
              errors={createErrors.mode ? [createErrors.mode] : undefined}
            />
            <div className="text-xs leading-normal text-muted">
              {singleMode
                ? 'Fresh runs onboarding when first made live. Either way, creating a second station converts this install — see the warning above.'
                : 'Fresh starts empty and runs the onboarding wizard the first time it goes live. Duplicate copies everything except play history and logs.'}
            </div>
          </Field>
        </div>
      </Modal>

      <Modal
        open={renaming !== null}
        onOpenChange={o => {
          if (!o) setRenaming(null);
        }}
        title="Rename station"
        sub="Display name only — the slug and data folder stay put."
        width={440}
        footer={
          <div className="flex justify-end gap-2">
            <Btn onClick={() => setRenaming(null)}>Cancel</Btn>
            <Btn
              tone="accent"
              disabled={busy || !renameForm.formState.isValid}
              onClick={() => void rename()}
            >
              Save
            </Btn>
          </div>
        }
      >
        <Field data-invalid={renameAria.invalid}>
          <FieldLabel className="sr-only" {...renameAria.labelProps}>Station name</FieldLabel>
          <Input
            {...renameForm.register('name')}
            {...renameAria.controlProps}
            autoFocus
            onKeyDown={e => {
              if (e.key === 'Enter' && !busy) void rename();
            }}
          />
          <FieldError
            {...renameAria.errorProps}
            errors={renameErrors.name ? [renameErrors.name] : undefined}
          />
        </Field>
      </Modal>

      <V3AlertDialog
        open={confirm !== null}
        onOpenChange={o => {
          if (!o) setConfirm(null);
        }}
        title={
          confirm?.type === 'live'
            ? `Put “${confirm.s.name}” on air?`
            : `Delete “${confirm?.s.name ?? ''}”?`
        }
        description={
          confirm?.type === 'live'
            ? `Every listener drops for about 10 seconds while the mixer and controller restart, then reconnects to the new station automatically.${
                live ? ` “${live.name}” goes to standby with all its data intact.` : ''
              }`
            : 'This is irreversible. Its entire data directory — settings, schedule, library analysis, jingles, logs — is erased.'
        }
        confirmLabel={confirm?.type === 'live' ? 'Make live' : 'Delete forever'}
        danger
        onConfirm={() => {
          if (confirm?.type === 'live') void activate(confirm.s);
          else if (confirm) void remove(confirm.s);
          setConfirm(null);
        }}
      />
    </div>
  );
}

'use client';

// Stations — /admin/stations, "transmitter rack" design (Stations.dc.html
// from the Claude Design project, re-expressed in house Tailwind tokens).
// An FM dial band shows every station as a carrier with the live one as the
// needle; below it the rack lists stations as numbered presets. Create and
// rename run in modals; make-live and delete sit behind danger confirms.
// Installs are capped at MAX_STATIONS=8 server-side (GET /stations `limit`).
//
// Activating a station — or creating the SECOND station, which converts a
// single-station install — restarts the controller, so both flows funnel
// into one full-screen "re-tuning" state that hard-reloads once /state
// reports the new station booted (boot-frozen station.id — see
// controller/src/routes/public.ts). API: controller/src/routes/stations.ts.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';
import { CONVERT_SENTINEL, useStationSwitchPoll } from '../../hooks/useStationSwitch';
import { useDynamicStyle } from '../../hooks/useDynamicStyle';
import { notify, errorMessage } from '../../lib/notify';
import { cn } from '../../lib/cn';
import { Btn } from './ui';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Modal } from '../ui/modal';
import { V3AlertDialog } from '../ui/alert-dialog';
import styles from './StationsPanel.module.css';

interface StationRow {
  id: string | null;
  name: string;
  configured: boolean;
  createdAt: string | null;
  active: boolean;
}

interface StationsResponse {
  multiStation: boolean;
  activeId: string | null;
  limit?: number;
  stations: StationRow[];
}

// Mirrors slugifyStationName in controller/src/stations/pure.ts — preview
// only; the server's answer is authoritative (collisions get -2 suffixes).
function slugPreview(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 41)
    .replace(/-+$/g, '');
}

// Each station gets a stable pseudo-frequency on the 88–108 FM band, hashed
// from its id so it keeps its spot as the rack changes. Pure presentation.
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
  const [data, setData] = useState<StationsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ type: 'live' | 'del'; s: StationRow } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createMode, setCreateMode] = useState<'fresh' | 'duplicate'>('fresh');
  const [renaming, setRenaming] = useState<StationRow | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // Non-null while a switch is in flight: the target station id, or the
  // CONVERT_SENTINEL for a fresh-install → multi-station conversion.
  const [switching, setSwitching] = useState<string | null>(null);
  const [switchingLabel, setSwitchingLabel] = useState('');
  useStationSwitchPoll(switching);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await adminFetch('/stations');
      if (!r.ok) throw new Error(`failed (${r.status})`);
      setData((await r.json()) as StationsResponse);
    } catch (e) {
      setErr(errorMessage(e));
    }
  }, [adminFetch]);

  useEffect(() => {
    if (hydrated && !needsAuth) void load();
  }, [hydrated, needsAuth, load]);

  const stations = useMemo(() => data?.stations ?? [], [data]);
  const freqs = useMemo(() => assignFrequencies(stations), [stations]);
  const singleMode = !data?.multiStation;
  const live = stations.find(s => s.active) ?? null;
  const limit = data?.limit ?? 8;
  const atCap = stations.length >= limit;

  const create = async () => {
    setBusy(true);
    try {
      const r = await adminFetch('/stations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: createName, mode: createMode }),
      });
      const j = (await r.json().catch(() => ({}))) as { switching?: boolean; error?: string };
      if (!r.ok) {
        // Converted-but-create-failed wedge: the conversion is durable and the
        // controller restarts regardless — enter the re-tuning state anyway.
        if (j.switching) {
          notify.err(
            `Create failed: ${j.error || `failed (${r.status})`} — the controller is restarting anyway to finish converting to multi-station.`,
          );
          setCreateOpen(false);
          setSwitchingLabel('converting install to multi-station');
          setSwitching(CONVERT_SENTINEL);
          return;
        }
        throw new Error(j.error || `failed (${r.status})`);
      }
      setCreateOpen(false);
      setCreateName('');
      setCreateMode('fresh');
      if (j.switching) {
        notify.info('Converting to multi-station — the controller is restarting.');
        setSwitchingLabel('converting install to multi-station');
        setSwitching(CONVERT_SENTINEL);
      } else {
        notify.ok('Station racked — offline until you make it live.');
        await load();
      }
    } catch (e) {
      notify.err(`Create failed: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const activate = async (s: StationRow) => {
    if (!s.id) return;
    setBusy(true);
    try {
      const r = await adminFetch(`/stations/${s.id}/activate`, { method: 'POST' });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
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
      const r = await adminFetch(`/stations/${s.id}`, { method: 'DELETE' });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      notify.ok(`“${s.name}” deleted — data directory erased.`);
      await load();
    } catch (e) {
      notify.err(`Delete failed: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const rename = async () => {
    if (!renaming?.id) return;
    setBusy(true);
    try {
      const r = await adminFetch(`/stations/${renaming.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: renameValue }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      notify.ok(`Renamed to “${renameValue.trim()}”.`);
      setRenaming(null);
      await load();
    } catch (e) {
      notify.err(`Rename failed: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  if (!hydrated || needsAuth) return null;

  // A switch is in flight — the re-tuning screen replaces everything until
  // the new controller answers and the page reloads itself.
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
      {/* Header + dial card */}
      <section className="card">
      <header className="p-5">
        <div className="font-mono text-[10px] font-bold tracking-[0.22em] text-vermilion uppercase">
          transmitter rack — admin
        </div>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
          <h1 className="m-0 font-display text-[42px] leading-none font-semibold text-ink">
            Stations<span className="text-vermilion">.</span>
          </h1>
          <div className="flex items-center gap-4">
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
              disabled={busy || loading || atCap}
              onClick={() => {
                setCreateName('');
                setCreateMode('fresh');
                setCreateOpen(true);
              }}
            >
              New station
            </Btn>
          </div>
        </div>
        <p className="mt-3 mb-0 max-w-[600px] text-sm leading-relaxed text-muted">
          Every station keeps its own settings, schedule and library — switching just moves the
          carrier. For now, exactly one broadcasts at a time; simultaneous streams come later.
        </p>
      </header>

      {/* FM dial band */}
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

      {/* Rack card: loading / error / rows */}
      <section className="card">
      {/* Loading skeleton */}
      {loading ? (
        <div>
          {[0, 1, 2].map(k => (
            <div
              key={k}
              className="grid grid-cols-[96px_1fr_auto] items-center gap-6 border-t border-separator-strong p-5 first:border-t-0"
            >
              <div className={cn(styles.shimmer, 'h-12 bg-separator-strong')} />
              <div className="grid gap-2">
                <div className={cn(styles.shimmer, 'h-4 w-[38%] bg-separator-strong')} />
                <div className={cn(styles.shimmer, 'h-2.5 w-[22%] bg-separator-soft')} />
              </div>
              <div className={cn(styles.shimmer, 'h-6 w-[120px] bg-separator-soft')} />
            </div>
          ))}
          <div className="border-t border-separator-strong px-5 py-3 font-mono text-[10px] tracking-[0.22em] text-muted uppercase">
            Scanning the rack…
          </div>
        </div>
      ) : null}

      {/* Load error */}
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
            <Btn tone="solid" onClick={() => void load()}>
              Retry scan
            </Btn>
          </div>
        </div>
      ) : null}

      {/* The rack */}
      {data ? (
        <div>
          {stations.map((s, i) => (
            <div
              key={s.id ?? '__install'}
              className="grid grid-cols-[96px_1fr_auto] items-center gap-6 border-t border-separator-strong first:border-t-0"
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

              <div className="grid gap-1.5 py-4">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="font-display text-[26px] leading-[1.1] font-semibold text-ink">
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

              <div className="flex items-center justify-end gap-2 pr-5">
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
                        setRenameValue(s.name);
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

      {/* Single-station note */}
      {data && singleMode ? (
        <div className="border-t border-separator-strong px-4 py-4 text-[13px] leading-relaxed text-muted">
          This install hasn&apos;t been converted to multi-station yet — it runs exactly this one
          station. Creating a second station converts the install and restarts the controller,
          and this rack fills up.
        </div>
      ) : null}
      </section>

      {/* Create modal */}
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
              disabled={busy || !createName.trim() || atCap}
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
          <div className="grid gap-1.5">
            <Label htmlFor="station-name">Station name</Label>
            <Input
              id="station-name"
              value={createName}
              autoFocus
              placeholder="e.g. Night Loop"
              onChange={e => setCreateName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && createName.trim() && !busy && !atCap) void create();
              }}
            />
            <div className="font-mono text-[10px] tracking-[0.1em] text-muted lowercase">
              slug: {slugPreview(createName) || '—'}
            </div>
          </div>
          <div className="grid gap-2">
            <Label>Starting point</Label>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
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
            <div className="text-xs leading-normal text-muted">
              {singleMode
                ? 'Fresh runs onboarding when first made live. Either way, creating a second station converts this install — see the warning above.'
                : 'Fresh starts empty and runs the onboarding wizard the first time it goes live. Duplicate copies everything except play history and logs.'}
            </div>
          </div>
        </div>
      </Modal>

      {/* Rename modal */}
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
            <Btn tone="accent" disabled={busy || !renameValue.trim()} onClick={() => void rename()}>
              Save
            </Btn>
          </div>
        }
      >
        <Input
          value={renameValue}
          autoFocus
          onChange={e => setRenameValue(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && renameValue.trim() && !busy) void rename();
          }}
        />
      </Modal>

      {/* Make-live / delete confirms */}
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

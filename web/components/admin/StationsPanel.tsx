'use client';

// Stations — /admin/stations. Multi-station profile management: list every
// station this install knows about (including the single unconverted root,
// id === null), create new ones (fresh onboarding or a duplicate of the
// current station), rename/delete offline ones, and switch which one is
// live. Activating a station — or creating the SECOND station, which
// converts this single-station install to multi-station — restarts the
// controller, so both flows funnel into one polling "switching" screen that
// hard-reloads once /state reports the new station has booted (station.id
// is boot-frozen — see controller/src/routes/public.ts).
//
// See controller/src/routes/stations.ts for the API this panel drives.

import { useCallback, useEffect, useState } from 'react';
import { RadioTower } from 'lucide-react';
import { useAdminAuth } from '../../lib/adminAuth';
import { CONVERT_SENTINEL, useStationSwitchPoll } from '../../hooks/useStationSwitch';
import { notify, errorMessage } from '../../lib/notify';
import { Card, Btn, Pill, Eyebrow, Seg } from './ui';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { SkeletonCards } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/error-state';
import { EmptyState } from '@/components/ui/empty-state';
import { V3AlertDialog } from '../ui/alert-dialog';

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
  stations: StationRow[];
}

const MODE_OPTIONS = [
  { id: 'fresh', label: 'Fresh (onboarding)' },
  { id: 'duplicate', label: 'Duplicate current' },
];

export default function StationsPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [data, setData] = useState<StationsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState('');
  const [newMode, setNewMode] = useState<'fresh' | 'duplicate'>('fresh');
  const [confirmLive, setConfirmLive] = useState<StationRow | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<StationRow | null>(null);
  const [renaming, setRenaming] = useState<StationRow | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // Non-null while a switch is in flight: the target station id, or the
  // CONVERT_SENTINEL for a fresh-install → multi-station conversion.
  const [switching, setSwitching] = useState<string | null>(null);
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

  const create = async () => {
    setBusy(true);
    try {
      const r = await adminFetch('/stations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: newName, mode: newMode }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        switching?: boolean;
        error?: string;
      };
      if (!r.ok) {
        // converted-but-create-failed wedge: the legacy-root conversion
        // already completed server-side (durable — pointer + stations/main
        // exist) before something after it failed, so the controller is
        // about to restart regardless of this 500. Toast the error but still
        // enter the switching state, or the panel would sit here interactive
        // against a process that's already scheduled to exit.
        if (j.switching) {
          notify.err(`Create failed: ${j.error || `failed (${r.status})`} — the controller is restarting anyway to finish converting to multi-station.`);
          setNewName('');
          setSwitching(CONVERT_SENTINEL);
          return;
        }
        throw new Error(j.error || `failed (${r.status})`);
      }
      setNewName('');
      if (j.switching) {
        notify.info('Converting to multi-station — the controller is restarting.');
        setSwitching(CONVERT_SENTINEL);
      } else {
        notify.ok('Station created.');
        await load();
      }
    } catch (e) {
      notify.err(`Create failed: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const activate = async (id: string) => {
    setBusy(true);
    try {
      const r = await adminFetch(`/stations/${id}/activate`, { method: 'POST' });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      notify.info('Switching the live station — the controller is restarting.');
      setSwitching(id);
    } catch (e) {
      notify.err(`Switch failed: ${errorMessage(e)}`);
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      const r = await adminFetch(`/stations/${id}`, { method: 'DELETE' });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      notify.ok('Station deleted.');
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
      notify.ok('Station renamed.');
      setRenaming(null);
      await load();
    } catch (e) {
      notify.err(`Rename failed: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  if (!hydrated || needsAuth) return null;

  // A switch is in flight — block every other control behind a single
  // polling screen until the new controller answers and we reload.
  if (switching) {
    return (
      <EmptyState
        icon={<RadioTower className="animate-pulse" />}
        title="Switching stations…"
        description="The mixer and controller are restarting against the new station. Listeners reconnect automatically — this page reloads on its own once the switch completes."
      />
    );
  }

  const loading = data === null && !err;

  return (
    <div className="grid gap-4">
      <section className="card">
        <div className="border-b border-ink p-4">
          <Eyebrow className="text-vermilion">stations</Eyebrow>
          <div className="mt-1.5 text-[22px] font-extrabold tracking-[-0.02em]">
            Run more than one station.
          </div>
          <div className="mt-1 text-[11px] leading-[1.6] text-muted">
            Every station gets its own library pool, DJ roster, schedule, and settings under this
            one install. For now only one station can go live at a time — switching restarts the
            mixer and controller, so every listener is dropped for ~10 seconds while it comes back
            up. Broadcasting several stations at once, each on its own stream, is coming later.
          </div>
        </div>
      </section>

      {err && <ErrorState error={err} onRetry={() => void load()} />}

      {loading && <SkeletonCards cards={3} label="Loading stations" />}

      {data && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.stations.map(s => (
              <Card
                key={s.id ?? '__root__'}
                title={s.name}
                right={s.active ? <Pill tone="accent" dot>Live</Pill> : null}
              >
                <div className="text-[11px] leading-[1.6] text-muted">
                  {s.id ?? 'current install'}
                  {!s.configured ? ' · unconfigured' : ''}
                  {s.createdAt ? ` · ${new Date(s.createdAt).toLocaleDateString()}` : ''}
                </div>
                {/* The single-station root row (id === null) can't be renamed,
                    deleted, or "made live" independently — it's whatever
                    station is already running. */}
                {s.id && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {!s.active && (
                      <Btn sm tone="accent" disabled={busy} onClick={() => setConfirmLive(s)}>
                        Make live
                      </Btn>
                    )}
                    <Btn
                      sm
                      disabled={busy}
                      onClick={() => { setRenaming(s); setRenameValue(s.name); }}
                    >
                      Rename
                    </Btn>
                    {!s.active && (
                      <Btn sm tone="danger" disabled={busy} onClick={() => setConfirmDelete(s)}>
                        Delete
                      </Btn>
                    )}
                  </div>
                )}
              </Card>
            ))}
          </div>

          <Card title="New station" sub="fresh onboarding, or a duplicate of what’s live now">
            <div className="grid max-w-md gap-3">
              <div className="field">
                <Label>Name</Label>
                <Input
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  placeholder="Station name"
                  maxLength={80}
                />
              </div>
              <div className="field">
                <Label>Starting point</Label>
                <Seg
                  options={MODE_OPTIONS}
                  value={newMode}
                  onChange={id => setNewMode(id === 'duplicate' ? 'duplicate' : 'fresh')}
                />
                <div className="field-hint">
                  {data.multiStation
                    ? 'Fresh stations start in the onboarding wizard after you make them live. Duplicate copies this station’s settings, personas, and schedule as a starting point.'
                    : 'Creating a second station converts this install to multi-station and restarts the controller (~10 seconds).'}
                </div>
              </div>
              <div>
                <Btn tone="accent" disabled={busy || !newName.trim()} onClick={() => void create()}>
                  {busy ? 'Creating…' : 'Create'}
                </Btn>
              </div>
            </div>
          </Card>

          {renaming && (
            <Card title={`Rename “${renaming.name}”`}>
              <div className="flex max-w-md items-center gap-2">
                <Input
                  value={renameValue}
                  onChange={e => setRenameValue(e.target.value)}
                  maxLength={80}
                  autoFocus
                />
                <Btn tone="accent" disabled={busy || !renameValue.trim()} onClick={() => void rename()}>
                  Save
                </Btn>
                <Btn disabled={busy} onClick={() => setRenaming(null)}>Cancel</Btn>
              </div>
            </Card>
          )}
        </>
      )}

      <V3AlertDialog
        open={confirmLive !== null}
        onOpenChange={o => { if (!o) setConfirmLive(null); }}
        title="Switch the live station"
        description={`Make “${confirmLive?.name ?? ''}” the live station? Every listener is dropped for ~10 seconds while the mixer and controller restart.`}
        confirmLabel="Make live"
        danger
        onConfirm={() => {
          if (confirmLive?.id) void activate(confirmLive.id);
          setConfirmLive(null);
        }}
      />
      <V3AlertDialog
        open={confirmDelete !== null}
        onOpenChange={o => { if (!o) setConfirmDelete(null); }}
        title="Delete station"
        description={`Delete “${confirmDelete?.name ?? ''}” and everything in its state directory? This cannot be undone.`}
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          if (confirmDelete?.id) void remove(confirmDelete.id);
          setConfirmDelete(null);
        }}
      />
    </div>
  );
}

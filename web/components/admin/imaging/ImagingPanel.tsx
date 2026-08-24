'use client';

/* Owns the state and handlers the Jingles / SFX / Beds / Voices sections need.
   Tab pattern mirrors ConnectPanel (Seg control + ?tab= deep-link). */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Music, AudioLines, Waves, Mic } from 'lucide-react';
import { useAdminAuth } from '../../../lib/adminAuth';
import {
  AdminResponseError, adminResponse, useAdminMutation,
} from '../../../lib/admin-query';
import { notify, errorMessage } from '../../../lib/notify';
import { SectionTabs } from '../SectionTabs';
import { V3AlertDialog } from '../../ui/alert-dialog';
import { SkeletonCards } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/error-state';
import type { SettingsData, SaveSettings } from '../settings/shared';
import type {
  SfxData, BedsData, VoiceData, JingleImportFailure, JingleImportResult, ImagingSubmitResult,
} from './types';
import { JinglesSection } from './JinglesSection';
import { SfxSection } from './SfxSection';
import { BedsSection } from './BedsSection';
import { VoicesSection } from './VoicesSection';
import { MonoLabel, TabMetric, pad2 } from './parts';
import {
  imagingKeys,
  useBedsQuery,
  useJinglesQuery,
  useSfxQuery,
  useVoicesQuery,
} from './queries';
import {
  useSettingsMutation,
  useSettingsQuery,
} from '../settings/queries';

type TabId = 'jingles' | 'sfx' | 'beds' | 'voices';
const TAB_IDS: TabId[] = ['jingles', 'sfx', 'beds', 'voices'];

export default function ImagingPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const enabled = hydrated && !needsAuth;
  const settingsQuery = useSettingsQuery<SettingsData>({
    adminFetch,
    enabled,
    refetchInterval: 3_000,
  });
  const jinglesQuery = useJinglesQuery(adminFetch, enabled);
  const sfxQuery = useSfxQuery(adminFetch, enabled);
  const bedsQuery = useBedsQuery(adminFetch, enabled);
  const voicesQuery = useVoicesQuery(adminFetch, enabled);
  const data = useMemo(
    () => settingsQuery.data
      ? { ...settingsQuery.data, jingles: jinglesQuery.data?.jingles }
      : null,
    [settingsQuery.data, jinglesQuery.data],
  );
  const sfxData: SfxData | null = sfxQuery.data ?? null;
  const bedsData: BedsData | null = bedsQuery.data ?? null;
  const voicesData: VoiceData | null = voicesQuery.data ?? null;
  const err = settingsQuery.error ? errorMessage(settingsQuery.error) : null;
  const [busy, setBusy] = useState(false);

  // Active tab lives in the URL (?tab=…), shared by the in-page SectionTabs and the
  // sidebar submenu, so switching tabs while already on the page works.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const rawTab = searchParams.get('tab');
  const tab: TabId = (TAB_IDS as string[]).includes(rawTab ?? '') ? (rawTab as TabId) : 'jingles';

  // jingleRatio null = not yet hydrated from /settings; polling never re-hydrates it,
  // so operator edits to the ratio input survive the 3s refresh.
  const [jingleRatio, setJingleRatio] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const [confirmDeleteSfx, setConfirmDeleteSfx] = useState<string | null>(null);
  const [confirmDeleteBed, setConfirmDeleteBed] = useState<string | null>(null);
  const [confirmDeleteVoice, setConfirmDeleteVoice] = useState<string | null>(null);

  const refresh = async () => { await settingsQuery.refetch(); };

  const saveMutation = useSettingsMutation<SettingsData>({ adminFetch });

  const resourceMutation = useAdminMutation<Record<string, unknown>, {
    path: string;
    init: RequestInit;
    key: readonly unknown[];
  }>({
    adminFetch,
    request: async (vars, fetcher) => {
      const response = await adminResponse(fetcher, vars.path, vars.init);
      return response.json().catch(() => ({})) as Promise<Record<string, unknown>>;
    },
    onDone: (_result, vars, client) =>
      client.invalidateQueries({ queryKey: vars.key }),
    toastOnError: false,
  });

  const mutationFieldErrors = (error: unknown) => error instanceof AdminResponseError
    ? (error.body as { fieldErrors?: Record<string, string> }).fieldErrors
    : undefined;

  useEffect(() => {
    if (data?.values && jingleRatio == null) setJingleRatio(String(data.values.jingleRatio ?? ''));
  }, [data, jingleRatio]);

  // Routed through Next so a soft nav (in-page tab or sidebar submenu) re-derives `tab`.
  const selectTab = useCallback(
    (id: string) => {
      const params = new URLSearchParams(Array.from(searchParams.entries()));
      params.set('tab', id);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const saveSettings: SaveSettings = async (patch) => {
    setBusy(true);
    try {
      const j = await saveMutation.mutateAsync(patch);
      // A jingle-ratio change needs a mixer restart (control in Settings → Danger zone).
      if (j.refreshError) notify.err(`saved, but refresh failed: ${j.refreshError}`);
      else notify.ok(j.requiresRestart ? 'saved, restart the mixer to apply' : 'saved');
      return true;
    } catch (e) {
      const body = e instanceof AdminResponseError
        ? e.body as { fieldErrors?: Record<string, string> }
        : undefined;
      const field = Object.values(body?.fieldErrors || {})[0];
      notify.err(field || errorMessage(e));
      return false;
    } finally { setBusy(false); }
  };

  // The create/import modals each own a react-hook-form instance validated
  // against the matching schema in schemas.generated.ts (#1337's imaging
  // schemas); these submitters do the actual round trip and hand back
  // ImagingSubmitResult so the modal that owns the form can route a
  // server-side refusal onto the right input via applyServerFieldErrors.
  const createJingle = async (values: { text: string }): Promise<ImagingSubmitResult> => {
    setBusy(true);
    try {
      await resourceMutation.mutateAsync({
        path: '/jingles',
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(values),
        },
        key: imagingKeys.jingles(),
      });
      return { ok: true };
    } catch (e) {
      notify.err(`Jingle creation failed: ${errorMessage(e)}`);
      return { ok: false, fieldErrors: mutationFieldErrors(e) };
    } finally { setBusy(false); }
  };

  const deleteJingle = async (filename: string) => {
    setBusy(true);
    try {
      await resourceMutation.mutateAsync({
        path: `/jingles/${encodeURIComponent(filename)}`,
        init: { method: 'DELETE' },
        key: imagingKeys.jingles(),
      });
    } catch (e) { notify.err(`Delete failed: ${errorMessage(e)}`); }
    finally { setBusy(false); }
  };

  // adminFetch leaves Content-Type unset so the browser sets the multipart boundary.
  // One request per file, not one batch: a 40-file import would otherwise sit in
  // server memory at once and one bad file would sink the rest. `label` applies only
  // to a single-file import (jingleImportSchema — already trimmed/capped by the
  // time it gets here). An abort counts the interrupted file as skipped, not failed.
  const uploadJingle = async (
    files: File[],
    label: string | undefined,
    opts: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {},
  ): Promise<JingleImportResult | null> => {
    if (busy || !files.length) return null;
    const { onProgress, signal } = opts;
    setBusy(true);
    const total = files.length;
    let ok = 0;
    let aborted = false;
    const failures: JingleImportFailure[] = [];
    try {
      for (const [i, file] of files.entries()) {
        if (signal?.aborted) { aborted = true; break; }
        try {
          const fd = new FormData();
          fd.append('file', file);
          if (total === 1 && label) fd.append('label', label);
          await adminResponse(adminFetch, '/jingles/upload', { method: 'POST', body: fd }, signal);
          ok++;
        } catch (e) {
          if (signal?.aborted) { aborted = true; break; }
          failures.push({ name: file.name, reason: errorMessage(e) });
        }
        onProgress?.(i + 1, total);
      }
      if (ok) await jinglesQuery.refetch();
      if (aborted) {
        notify.info(`Import stopped — ${ok}/${total} imported`);
      } else if (total === 1) {
        if (ok) notify.ok('jingle imported');
        else notify.err(`Jingle import failed: ${failures[0]?.reason}`);
      } else if (failures.length === 0) {
        notify.ok(`${ok} jingles imported`);
      } else {
        notify.err(`${ok}/${total} jingles imported · ${failures.length} failed`);
      }
      return { ok, total, failures, aborted };
    } finally { setBusy(false); }
  };

  const createSfx = async (values: {
    name: string; description: string; prompt: string; durationSec?: number;
  }): Promise<ImagingSubmitResult> => {
    setBusy(true);
    try {
      await resourceMutation.mutateAsync({
        path: '/sfx',
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(values),
        },
        key: imagingKeys.sfx(),
      });
      return { ok: true };
    } catch (e) {
      notify.err(`Sound effect creation failed: ${errorMessage(e)}`);
      return { ok: false, fieldErrors: mutationFieldErrors(e) };
    } finally { setBusy(false); }
  };

  const deleteSfx = async (name: string) => {
    setBusy(true);
    try {
      await resourceMutation.mutateAsync({
        path: `/sfx/${encodeURIComponent(name)}`,
        init: { method: 'DELETE' },
        key: imagingKeys.sfx(),
      });
    } catch (e) { notify.err(`Delete failed: ${errorMessage(e)}`); }
    finally { setBusy(false); }
  };

  // Upload a ready-made effect — no ElevenLabs key required (unlike createSfx).
  // `values` is imagingImportSchema's output — already trimmed/capped.
  const uploadSfx = async (file: File, values: { name: string; description: string }): Promise<ImagingSubmitResult> => {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('name', values.name);
      if (values.description) fd.append('description', values.description);
      await resourceMutation.mutateAsync({
        path: '/sfx/upload', init: { method: 'POST', body: fd }, key: imagingKeys.sfx(),
      });
      notify.ok('sound effect imported');
      return { ok: true };
    } catch (e) {
      notify.err(`Sound effect import failed: ${errorMessage(e)}`);
      return { ok: false, fieldErrors: mutationFieldErrors(e) };
    } finally { setBusy(false); }
  };

  // Generate a bed via the ElevenLabs Music API — needs a key (unlike uploadBed).
  const createBed = async (values: {
    name: string; description: string; prompt: string; durationSec?: number;
  }): Promise<ImagingSubmitResult> => {
    setBusy(true);
    try {
      await resourceMutation.mutateAsync({
        path: '/beds',
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(values),
        },
        key: imagingKeys.beds(),
      });
      notify.ok('bed generated');
      return { ok: true };
    } catch (e) {
      notify.err(`Bed generation failed: ${errorMessage(e)}`);
      return { ok: false, fieldErrors: mutationFieldErrors(e) };
    } finally { setBusy(false); }
  };

  const uploadBed = async (file: File, values: { name: string; description: string }): Promise<ImagingSubmitResult> => {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('name', values.name);
      if (values.description) fd.append('description', values.description);
      await resourceMutation.mutateAsync({
        path: '/beds/upload', init: { method: 'POST', body: fd }, key: imagingKeys.beds(),
      });
      notify.ok('bed imported');
      return { ok: true };
    } catch (e) {
      notify.err(`Bed import failed: ${errorMessage(e)}`);
      return { ok: false, fieldErrors: mutationFieldErrors(e) };
    } finally { setBusy(false); }
  };

  const deleteBed = async (name: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await resourceMutation.mutateAsync({
        path: `/beds/${encodeURIComponent(name)}`,
        init: { method: 'DELETE' },
        key: imagingKeys.beds(),
      });
      notify.ok('bed deleted');
    } catch (e) { notify.err(`Bed delete failed: ${errorMessage(e)}`); }
    finally { setBusy(false); }
  };

  // Any accepted audio type; the controller transcodes to the canonical mono WAV.
  const uploadVoice = async (file: File, values: { name: string }): Promise<ImagingSubmitResult> => {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('name', values.name);
      await resourceMutation.mutateAsync({
        path: '/voices/upload', init: { method: 'POST', body: fd }, key: imagingKeys.voices(),
      });
      notify.ok('voice imported');
      return { ok: true };
    } catch (e) {
      notify.err(`Voice import failed: ${errorMessage(e)}`);
      return { ok: false, fieldErrors: mutationFieldErrors(e) };
    } finally { setBusy(false); }
  };

  const deleteVoice = async (file: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await resourceMutation.mutateAsync({
        path: `/voices/${encodeURIComponent(file)}`,
        init: { method: 'DELETE' },
        key: imagingKeys.voices(),
      });
      notify.ok('voice deleted');
    } catch (e) { notify.err(`Voice delete failed: ${errorMessage(e)}`); }
    finally { setBusy(false); }
  };

  // Undefined until each source loads; the badge is omitted until then.
  const jingleCount = data?.jingles?.length;
  const sfxCount = sfxData?.sfx?.length;
  const bedCount = bedsData?.beds?.length;
  const totalAssets = (jingleCount ?? 0) + (sfxCount ?? 0) + (bedCount ?? 0);
  const ratioVal = data?.values?.jingleRatio;
  const ratioMetric = ratioVal == null ? '—' : ratioVal === 0 ? 'off' : `1 : ${ratioVal}`;
  const tabs = [
    { id: 'jingles' as TabId, label: 'Jingles', count: jingleCount, icon: Music },
    { id: 'sfx' as TabId, label: 'SFX', count: sfxCount, icon: AudioLines },
    { id: 'beds' as TabId, label: 'Beds', count: bedCount, icon: Waves },
    { id: 'voices' as TabId, label: 'Voices', count: voicesData?.voices?.length, icon: Mic },
  ];

  return (
    <div className="grid gap-4">
      <section className="card">
      <header className="p-4 lg:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <MonoLabel>imaging</MonoLabel>
          <span className="flex items-center gap-[7px] font-mono text-[10px] tracking-[0.14em] text-muted uppercase">
            <span className="size-1.5 animate-pulse bg-[var(--accent)]" aria-hidden />
            live · refreshed every 3s
          </span>
        </div>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
          <div className="min-w-0">
            <div className="text-[22px] leading-tight font-extrabold tracking-[-0.02em]">
              The sounds between the songs.
            </div>
            <p className="mt-1 max-w-[62ch] text-[11px] leading-[1.6] [text-wrap:pretty] text-muted">
              Everything your DJ slips between and over the music:{' '}
              <strong className="font-semibold text-ink">jingles</strong> are the station idents
              between tracks, <strong className="font-semibold text-ink">SFX</strong> are the little
              stingers under the voice,{' '}
              <strong className="font-semibold text-ink">beds</strong> are instrumentals to talk
              over when a link runs long, and{' '}
              <strong className="font-semibold text-ink">voices</strong> are the clips your
              personas are cloned from.
            </p>
          </div>
          <div className="flex flex-none gap-7">
            <TabMetric big n={pad2(totalAssets)} l="assets" />
            <TabMetric big accent n={ratioMetric} l="jingle ratio" />
          </div>
        </div>
      </header>

      <SectionTabs tabs={tabs} value={tab} onChange={selectTab} label="Imaging sections" />
      </section>

      {err && (
        <ErrorState error={err} onRetry={refresh} />
      )}

      <div>
        {tab === 'jingles' && (
          data ? (
            <JinglesSection
              data={data} busy={busy}
              jingleRatio={jingleRatio ?? ''} setJingleRatio={setJingleRatio}
              createJingle={createJingle} uploadJingle={uploadJingle}
              saveSettings={saveSettings}
              onDelete={setConfirmDelete} adminFetch={adminFetch}
            />
          ) : (
            !err && <SkeletonCards cards={6} />
          )
        )}

        {tab === 'sfx' && (
          <SfxSection
            sfxData={sfxData}
            busy={busy} createSfx={createSfx} uploadSfx={uploadSfx}
            onDelete={setConfirmDeleteSfx}
            data={data} saveSettings={saveSettings} adminFetch={adminFetch}
          />
        )}

        {tab === 'beds' && (
          <BedsSection
            bedsData={bedsData}
            busy={busy} createBed={createBed} uploadBed={uploadBed}
            onDelete={setConfirmDeleteBed}
            data={data} saveSettings={saveSettings} adminFetch={adminFetch}
          />
        )}

        {tab === 'voices' && (
          <VoicesSection
            voicesData={voicesData} busy={busy}
            uploadVoice={uploadVoice}
            onDelete={setConfirmDeleteVoice}
            adminFetch={adminFetch}
          />
        )}
      </div>

      <V3AlertDialog
        open={confirmDelete != null}
        onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}
        title="Delete jingle"
        description={confirmDelete ? `Delete the jingle "${confirmDelete}"? This removes the rendered audio file permanently.` : ''}
        confirmLabel="delete"
        danger
        onConfirm={() => { if (confirmDelete) deleteJingle(confirmDelete); setConfirmDelete(null); }}
      />
      <V3AlertDialog
        open={confirmDeleteSfx != null}
        onOpenChange={(o) => { if (!o) setConfirmDeleteSfx(null); }}
        title="Delete sound effect"
        description={confirmDeleteSfx ? `Delete the sound effect "${confirmDeleteSfx}"? This removes the rendered audio file permanently.` : ''}
        confirmLabel="delete"
        danger
        onConfirm={() => { if (confirmDeleteSfx) deleteSfx(confirmDeleteSfx); setConfirmDeleteSfx(null); }}
      />
      <V3AlertDialog
        open={confirmDeleteBed != null}
        onOpenChange={(o) => { if (!o) setConfirmDeleteBed(null); }}
        title="Delete bed"
        description={confirmDeleteBed ? `Delete the bed "${confirmDeleteBed}"? This removes the audio file permanently.` : ''}
        confirmLabel="delete"
        danger
        onConfirm={() => { if (confirmDeleteBed) deleteBed(confirmDeleteBed); setConfirmDeleteBed(null); }}
      />
      <V3AlertDialog
        open={confirmDeleteVoice != null}
        onOpenChange={(o) => { if (!o) setConfirmDeleteVoice(null); }}
        title="Delete voice"
        description={confirmDeleteVoice ? `Delete the reference voice "${confirmDeleteVoice}"? Any persona still set to it falls back to the engine's built-in voice.` : ''}
        confirmLabel="delete"
        danger
        onConfirm={() => { if (confirmDeleteVoice) deleteVoice(confirmDeleteVoice); setConfirmDeleteVoice(null); }}
      />
    </div>
  );
}

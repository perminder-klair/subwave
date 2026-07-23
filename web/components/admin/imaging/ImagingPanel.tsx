'use client';

/* Admin Imaging page — the station's audio furniture, the sounds the DJ drops
   between and over tracks. Three tabs:
   - Jingles: pre-rendered TTS station stingers (+ the jingle-ratio frequency).
   - SFX: effects the segment-director agent mixes under its voice.
   - Beds: instrumentals the DJ talks over between songs (long-link beds).

   These used to be three sections inside /admin/settings, but they're asset
   management (create / upload / delete audio), not configuration — the same
   category as Library / Shows / Personas / Skills. This panel owns the state
   and handlers those sections need; the section components themselves moved
   here from settings/ unchanged apart from imports (JinglesSection also lost
   its FormState dependency — see its prop comment). Tab pattern mirrors
   ConnectPanel (Seg control + ?tab= deep-link). */

import { useCallback, useEffect, useState } from 'react';
import { useAdminAuth } from '../../../lib/adminAuth';
import { notify, errorMessage } from '../../../lib/notify';
import { Eyebrow, Seg } from '../ui';
import { V3AlertDialog } from '../../ui/alert-dialog';
import type { SettingsData, SaveSettings } from '../settings/shared';
import type { SfxData, SfxForm, BedsData, JingleImportFailure, JingleImportResult } from './types';
import { JinglesSection } from './JinglesSection';
import { SfxSection } from './SfxSection';
import { BedsSection } from './BedsSection';

type TabId = 'jingles' | 'sfx' | 'beds';
const TAB_IDS: TabId[] = ['jingles', 'sfx', 'beds'];

export default function ImagingPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [data, setData] = useState<SettingsData | null>(null);
  const [sfxData, setSfxData] = useState<SfxData | null>(null);
  const [bedsData, setBedsData] = useState<BedsData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<TabId>('jingles');

  // Jingles: the create-text box + the lone settings field this page carries
  // (the whole FormState stayed behind in SettingsPanel). null = not yet
  // hydrated from /settings; polling never re-hydrates it, so operator edits
  // to the ratio input survive the 3s refresh.
  const [jingleText, setJingleText] = useState('');
  const [jingleRatio, setJingleRatio] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // SFX
  const [sfxForm, setSfxForm] = useState<SfxForm>({ name: '', description: '', prompt: '', durationSec: '' });
  const [confirmDeleteSfx, setConfirmDeleteSfx] = useState<string | null>(null);

  // Beds
  const [confirmDeleteBed, setConfirmDeleteBed] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const r = await adminFetch('/settings');
      if (!r.ok) return;
      const j = (await r.json()) as SettingsData;
      setData(j); setErr(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  const refreshSfx = async () => {
    try {
      const r = await adminFetch('/sfx');
      if (!r.ok) return;
      setSfxData((await r.json()) as SfxData);
    } catch { /* non-fatal */ }
  };

  const refreshBeds = async () => {
    try {
      const r = await adminFetch('/beds');
      if (!r.ok) return;
      setBedsData((await r.json()) as BedsData);
    } catch { /* non-fatal */ }
  };

  // Deep-link: /admin/imaging?tab=sfx opens that tab directly (mirrors
  // /admin/connect?tab=… and the old /admin/settings?section=…).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const t = new URLSearchParams(window.location.search).get('tab');
    if (t && (TAB_IDS as string[]).includes(t)) setTab(t as TabId);
  }, []);

  useEffect(() => {
    if (!hydrated || needsAuth) return;
    refresh(); refreshSfx(); refreshBeds();
    const id = setInterval(() => { refresh(); refreshSfx(); refreshBeds(); }, 3000);
    return () => clearInterval(id);
  }, [hydrated, needsAuth]); // eslint-disable-line react-hooks/exhaustive-deps

  // Hydrate the jingle-ratio input once, the first time /settings lands.
  useEffect(() => {
    if (data?.values && jingleRatio == null) setJingleRatio(String(data.values.jingleRatio ?? ''));
  }, [data, jingleRatio]);

  const selectTab = useCallback((id: string) => {
    setTab(id as TabId);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('tab', id);
      window.history.replaceState(null, '', url.toString());
    }
  }, []);

  const saveSettings: SaveSettings = async (patch) => {
    setBusy(true);
    try {
      const r = await adminFetch('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; requiresRestart?: boolean };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      // The jingle-ratio change needs a mixer restart; the restart control
      // lives in Settings → Danger zone (JinglesSection's hint points there).
      notify.ok(j.requiresRestart ? 'saved, restart the mixer to apply' : 'saved');
      await refresh();
    } catch (e) {
      notify.err(errorMessage(e));
    } finally { setBusy(false); }
  };

  const createJingle = async (): Promise<boolean> => {
    if (!jingleText.trim() || busy) return false;
    setBusy(true);
    try {
      const r = await adminFetch('/jingles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: jingleText.trim() }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setJingleText('');
      await refresh();
      return true;
    } catch (e) { notify.err(`Jingle creation failed: ${errorMessage(e)}`); return false; }
    finally { setBusy(false); }
  };

  const deleteJingle = async (filename: string) => {
    setBusy(true);
    try {
      const r = await adminFetch(`/jingles/${encodeURIComponent(filename)}`, { method: 'DELETE' });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      await refresh();
    } catch (e) { notify.err(`Delete failed: ${errorMessage(e)}`); }
    finally { setBusy(false); }
  };

  // Multipart upload — adminFetch leaves Content-Type unset so the browser
  // sets the multipart boundary itself. The controller transcodes + levels.
  // Files upload one request at a time (not one multipart batch) so a big
  // import doesn't hold 40+ files in memory at once server-side and a single
  // bad file doesn't sink the rest. `label` only applies when importing a
  // single file — each file in a batch defaults to its own filename. An
  // abort via `signal` cancels the in-flight request too; the file it
  // interrupted counts as skipped, not failed.
  const uploadJingle = async (
    files: File[],
    label: string,
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
          if (total === 1 && label.trim()) fd.append('label', label.trim());
          const r = await adminFetch('/jingles/upload', { method: 'POST', body: fd, signal });
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
          ok++;
        } catch (e) {
          if (signal?.aborted) { aborted = true; break; }
          failures.push({ name: file.name, reason: errorMessage(e) });
        }
        onProgress?.(i + 1, total);
      }
      if (ok) await refresh();
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

  const createSfx = async (): Promise<boolean> => {
    if (!sfxForm.name.trim() || !sfxForm.prompt.trim() || busy) return false;
    setBusy(true);
    try {
      const r = await adminFetch('/sfx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: sfxForm.name.trim(),
          description: sfxForm.description.trim(),
          prompt: sfxForm.prompt.trim(),
          durationSec: sfxForm.durationSec ? parseFloat(sfxForm.durationSec) : undefined,
        }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setSfxForm({ name: '', description: '', prompt: '', durationSec: '' });
      await refreshSfx();
      return true;
    } catch (e) { notify.err(`Sound effect creation failed: ${errorMessage(e)}`); return false; }
    finally { setBusy(false); }
  };

  const deleteSfx = async (name: string) => {
    setBusy(true);
    try {
      const r = await adminFetch(`/sfx/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      await refreshSfx();
    } catch (e) { notify.err(`Delete failed: ${errorMessage(e)}`); }
    finally { setBusy(false); }
  };

  // Upload a ready-made effect — no ElevenLabs key required (unlike createSfx).
  const uploadSfx = async (file: File, name: string, description: string): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('name', name.trim());
      if (description.trim()) fd.append('description', description.trim());
      const r = await adminFetch('/sfx/upload', { method: 'POST', body: fd });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      await refreshSfx();
      notify.ok('sound effect imported');
      return true;
    } catch (e) { notify.err(`Sound effect import failed: ${errorMessage(e)}`); return false; }
    finally { setBusy(false); }
  };

  const uploadBed = async (file: File, name: string, description: string): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('name', name.trim());
      if (description.trim()) fd.append('description', description.trim());
      const r = await adminFetch('/beds/upload', { method: 'POST', body: fd });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      await refreshBeds();
      notify.ok('bed imported');
      return true;
    } catch (e) { notify.err(`Bed import failed: ${errorMessage(e)}`); return false; }
    finally { setBusy(false); }
  };

  const deleteBed = async (name: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await adminFetch(`/beds/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      await refreshBeds();
      notify.ok('bed deleted');
    } catch (e) { notify.err(`Bed delete failed: ${errorMessage(e)}`); }
    finally { setBusy(false); }
  };

  // Live counts ride on the tab labels — the at-a-glance figures the settings
  // rail used to show. Omitted until each source has loaded.
  const jingleCount = data?.jingles?.length;
  const sfxCount = sfxData?.sfx?.length;
  const bedCount = bedsData?.beds?.length;
  const tabs = [
    { id: 'jingles', label: jingleCount == null ? 'Jingles' : `Jingles · ${jingleCount}` },
    { id: 'sfx', label: sfxCount == null ? 'SFX' : `SFX · ${sfxCount}` },
    { id: 'beds', label: bedCount == null ? 'Beds' : `Beds · ${bedCount}` },
  ];

  return (
    <div className="grid gap-4">
      <section className="card">
        <div className="border-b border-ink p-4">
          <Eyebrow className="text-vermilion">imaging</Eyebrow>
          <div className="mt-1.5 text-[22px] font-extrabold tracking-[-0.02em]">
            The sounds between the songs.
          </div>
          <div className="mt-1 text-[11px] leading-[1.6] text-muted">
            Station imaging — the audio furniture the DJ drops between and over tracks. Jingles
            are pre-recorded stingers, sound effects garnish a spoken break, and beds are
            instrumentals the DJ talks over. All of it is created, imported, and managed here.
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 bg-[var(--ink-softer)] p-3.5">
          <Seg value={tab} options={tabs} accent onChange={selectTab} />
        </div>
      </section>

      {err && (
        <div className="card border-[var(--danger)]">
          <div className="card-body text-[12px] text-[var(--danger)]">
            <strong className="tracking-[0.12em] uppercase">controller error</strong>
            <div className="mt-1">{err}</div>
          </div>
        </div>
      )}

      {tab === 'jingles' && (
        data ? (
          <JinglesSection
            data={data} busy={busy}
            jingleRatio={jingleRatio ?? ''} setJingleRatio={setJingleRatio}
            jingleText={jingleText} setJingleText={setJingleText}
            createJingle={createJingle} uploadJingle={uploadJingle}
            saveSettings={saveSettings}
            onDelete={setConfirmDelete} adminFetch={adminFetch}
          />
        ) : (
          !err && <div className="text-[13px] text-muted italic">loading…</div>
        )
      )}

      {tab === 'sfx' && (
        <SfxSection
          sfxData={sfxData} sfxForm={sfxForm} setSfxForm={setSfxForm}
          busy={busy} createSfx={createSfx} uploadSfx={uploadSfx}
          onDelete={setConfirmDeleteSfx}
          data={data} saveSettings={saveSettings} adminFetch={adminFetch}
        />
      )}

      {tab === 'beds' && (
        <BedsSection
          bedsData={bedsData} busy={busy} uploadBed={uploadBed}
          onDelete={setConfirmDeleteBed}
          data={data} saveSettings={saveSettings} adminFetch={adminFetch}
        />
      )}

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
        description={confirmDeleteBed ? `Delete the bed "${confirmDeleteBed}"? This removes the audio file permanently. A bundled bed stays deleted — it won't come back on the next restart.` : ''}
        confirmLabel="delete"
        danger
        onConfirm={() => { if (confirmDeleteBed) deleteBed(confirmDeleteBed); setConfirmDeleteBed(null); }}
      />
    </div>
  );
}

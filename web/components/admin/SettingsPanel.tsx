'use client';

import type { ChangeEvent } from 'react';
import { settingsForm } from './settings/form-state';
import { atPath, samePath, sameForm, countLeafDiffs, dirtyPaths, ownsErrorPath, mergePatchErrors } from './settings/form-diff';
import { archivesSavePayload, dangerSavePayload } from './settings/save-payload';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { notify, errorMessage } from '../../lib/notify';
import { useAdminAuth } from '../../lib/adminAuth';
import {
  AdminResponseError,
  adminResponse,
} from '../../lib/admin-query';
import { V3AlertDialog } from '../ui/alert-dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '../ui/select';
import { Card, Btn, Pill, Seg } from './ui';
import { SkeletonForm } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/error-state';
import { cn } from '../../lib/cn';
import { fieldAria } from '../../lib/form';
import ArchivesPanel from './ArchivesPanel';
import BackupPanel from './BackupPanel';
import {
  SETTINGS_AAC_BITRATES,
  SETTINGS_MP3_BITRATES,
  SETTINGS_OPUS_BITRATES,
} from '@/lib/schemas.generated';
import { AlertTriangle } from 'lucide-react';
import {
  SectionHeader, SaveBar, SettingsFieldError,
  type FormState, type FormUpdater, type SettingsData, type SaveSettings,
  type LoudnessSource, type TransitionEffect,
} from './settings/shared';
import {
  SECTIONS, SECTION_GROUPS, RESTART_PATHS, sectionById, type SectionId,
} from './settings/registry';
import { Advanced, SectionChromeProvider } from './settings/section-chrome';
import { SettingsSearch, type SettingsJump } from './settings/SettingsSearch';
import { TtsSection } from './settings/TtsSection';
import { DjBehaviourSection } from './settings/DjBehaviourSection';
import { LlmSection } from './settings/LlmSection';
import { BrainSection } from './settings/BrainSection';
import { SearchSection } from './settings/SearchSection';
import { LibrarySection } from './settings/LibrarySection';
import { StationSection } from './settings/StationSection';
import { ThemeSection } from './settings/ThemeSection';
import { ScrobbleSection } from './settings/ScrobbleSection';
import { LikesSection } from './settings/LikesSection';
import { NavidromeSection } from './settings/NavidromeSection';
import {
  useSettingsMutation,
  useSettingsQuery,
} from './settings/queries';
import {
  cloudSaveSnapshot, cloudSaveReadReady, rebaselineSavedPatch, reconcileSavedCloud,
  type PendingCloudSave,
} from './settings/form-reconciliation';

// Operator copy for the shared transition vocabulary. The drift test keeps
// these labels in the schema's order and ensures every gesture has a hint.
const TRANSITION_EFFECT_FIELDS = [
  {
    id: 'sweep',
    label: 'Sweep',
    hint: 'The outgoing track sinks under a closing filter while the next one rises clean — the dramatic gear-change across a clashing pair.',
  },
  {
    id: 'washout',
    label: 'Washout',
    hint: 'A track dissolves into a tempo-synced echo tail as it ends. Also what makes an over-length track cut by the length cap sound intentional, so switching it off leaves those cuts as plain crossfades.',
  },
  {
    id: 'blend',
    label: 'Blend',
    hint: 'A spectral handover between two tempo- and key-locked tracks, so the pair reads as one continuous piece.',
  },
  {
    id: 'dissolve',
    label: 'Dissolve',
    hint: 'The outgoing track melts into a beatless reverb wash under the incoming one — the smooth way to hide a jump. The most expensive gesture in the kit: it runs on Liquidsoap\u2019s single streaming thread, so switch it off first if the mixer reports catch-up warnings on a slow host.',
  },
  {
    id: 'chop',
    label: 'Chop',
    hint: 'The outgoing track is cut on its own beat, stabs thinning as the next rises through the gaps — the percussive way to lift the energy.',
  },
  {
    id: 'loop',
    label: 'Exit loop',
    hint: 'A track\u2019s final bar repeats under whatever follows before it cuts away. Needs the track\u2019s measured tempo.',
  },
] as const satisfies readonly { id: TransitionEffect; label: string; hint: string }[];

// The three encoder vocabularies, from the mirror rather than re-typed. radio.liq
// has a literal `%mp3(bitrate=…)` branch per value, so each set is genuinely
// fixed — but "fixed" is why a hand-copied list is dangerous rather than safe:
// it drifts silently the one time a value IS added, offering the operator a
// bitrate the schema then refuses (or hiding one it would have accepted).
const MP3_BITRATES = SETTINGS_MP3_BITRATES;
const OPUS_BITRATES = SETTINGS_OPUS_BITRATES;
const AAC_BITRATES = SETTINGS_AAC_BITRATES;

/**
 * How long a search jump waits for its target card to mount, in animation
 * frames (~1s at 60Hz). Generous on purpose: the cost of waiting is invisible
 * — the scroll simply happens on the frame the card appears — while the cost of
 * giving up early is a jump that silently does nothing.
 */
const JUMP_MAX_FRAMES = 60;

export default function SettingsPanel({ djBrainEnabled = false }: { djBrainEnabled?: boolean }) {
  const sections = useMemo(
    () => SECTIONS.filter(s => s.id !== 'brain' || djBrainEnabled),
    [djBrainEnabled],
  );
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const settingsQuery = useSettingsQuery<SettingsData>({
    adminFetch,
    enabled: hydrated && !needsAuth,
    refetchInterval: 3_000,
  });
  const data = settingsQuery.data ?? null;
  const err = settingsQuery.error ? errorMessage(settingsQuery.error) : null;
  const [commandBusy, setBusy] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);
  const formBaselineRef = useRef<FormState | null>(null);
  const appliedRevisionRef = useRef(0);
  const pendingFormRevisionRef = useRef<{ revision: number; form: FormState } | null>(null);
  const [pendingCloudSave, setPendingCloudSave] = useState<PendingCloudSave | null>(null);
  const [pendingRestart, setPendingRestart] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [activeSection, setActiveSection] = useState<SectionId>('station');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const lengthModeAria = fieldAria('max-track-length-mode',
    fieldErrors.maxTrackLengthMode ? { message: fieldErrors.maxTrackLengthMode } : undefined);
  // Portal target for the one sticky save bar. Null while nothing is unsaved,
  // which is what makes every section's SaveBar render nothing when clean.
  const [saveSlot, setSaveSlot] = useState<HTMLElement | null>(null);
  // Dirtiness reported by a section whose state does not ride FormState.
  const [localDirty, setLocalDirty] = useState<Record<string, boolean>>({});
  // Advanced disclosure, per section — remembered while the panel is open so
  // flipping away to check another section and back does not re-collapse it.
  const [advOpen, setAdvOpen] = useState<Record<string, boolean>>({});
  const router = useRouter();

  const reportDirty = useCallback((id: string, dirty: boolean) => {
    setLocalDirty(prev => (!!prev[id] === dirty ? prev : { ...prev, [id]: dirty }));
  }, []);

  const refresh = async () => { await settingsQuery.refetch(); };

  const saveMutation = useSettingsMutation<SettingsData>({ adminFetch });
  const busy = commandBusy || saveMutation.isPending;

  // Jingles / SFX / Beds now live on /admin/imaging; their old ?section
  // deep-links are forwarded so existing bookmarks survive. Read through
  // useSearchParams, not a one-shot window.location, so client-side navigations
  // land too — NavidromeBanner links here from /admin/settings itself, where
  // only the query changes.
  const searchParams = useSearchParams();
  useEffect(() => {
    const s = searchParams.get('section');
    if (s === 'jingles' || s === 'sfx' || s === 'beds') {
      router.replace(`/admin/imaging?tab=${s}`);
      return;
    }
    if (s === 'brain' && !djBrainEnabled) {
      setActiveSection('station');
      return;
    }
    if (s && sections.some(x => x.id === s)) setActiveSection(s as SectionId);
  }, [router, searchParams, sections, djBrainEnabled]);

  useEffect(() => {
    if (!data?.values) return;
    const nextForm = settingsForm(data.values);
    const revision = settingsQuery.dataUpdatedAt;
    if (revision && appliedRevisionRef.current !== revision) {
      pendingFormRevisionRef.current = { revision, form: nextForm };
    }
    const pending = pendingFormRevisionRef.current;
    if (!pending) return;
    let displayed = form;
    if (displayed && formBaselineRef.current && pendingCloudSave
      && cloudSaveReadReady(pendingCloudSave, revision)) {
      const reconciled = reconcileSavedCloud(
        formBaselineRef.current, displayed, pendingCloudSave.snapshot, nextForm.tts.cloud,
      );
      displayed = reconciled.form;
      formBaselineRef.current = reconciled.baseline;
      setPendingCloudSave(null);
    }
    const baseline = formBaselineRef.current;
    const clean = !displayed || !baseline || sameForm(displayed, baseline);
    if (!clean) {
      if (displayed !== form) setForm(displayed);
      return;
    }
    // Compare against the rendered form: reconciliation may have restored
    // omitted fields only in `displayed`, even when the GET was unchanged.
    if (!form || !sameForm(form, pending.form)) setForm(pending.form);
    formBaselineRef.current = pending.form;
    appliedRevisionRef.current = pending.revision;
    pendingFormRevisionRef.current = null;
  }, [data, form, settingsQuery.dataUpdatedAt, pendingCloudSave]);

  const saveSettings: SaveSettings = async (patch) => {
    const submitted = form;
    const cloudSnapshot = submitted ? cloudSaveSnapshot(submitted, patch) : null;
    try {
      const j = await saveMutation.mutateAsync(patch);
      // The refetch may resolve while this local form is still dirty against
      // its old baseline. Mark only submitted fields clean: an edit in another
      // settings section must continue to hold the queued revision back.
      if (submitted) {
        const baseline = formBaselineRef.current;
        formBaselineRef.current = baseline
          ? rebaselineSavedPatch(baseline, submitted, patch)
          : submitted;
      }
      if (cloudSnapshot) {
        // Wake hydration even if the authoritative GET rendered before this
        // continuation. After a failed GET, wait for a later successful poll.
        setPendingCloudSave({
          snapshot: cloudSnapshot, refreshedAt: j.refreshedAt, refreshAfter: Date.now(),
        });
      }
      setFieldErrors((prev) => mergePatchErrors(prev, patch, undefined));
      if (j.requiresRestart) setPendingRestart(true);
      if (j.refreshError) notify.err(`saved, but refresh failed: ${j.refreshError}`);
      else notify.ok(j.requiresRestart ? 'saved, restart the mixer to apply' : 'saved');
      return true;
    } catch (e) {
      const body = e instanceof AdminResponseError
        ? e.body as { fieldErrors?: Record<string, string> }
        : undefined;
      setFieldErrors((prev) => mergePatchErrors(prev, patch, body?.fieldErrors));
      notify.err(errorMessage(e));
      return false;
    }
  };

  const restartMixer = async () => {
    setBusy(true);
    try {
      const r = await adminResponse(adminFetch, '/restart-mixer', { method: 'POST' });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setPendingRestart(false);
      notify.ok('mixer restarting, give it a few seconds');
    } catch (e) {
      notify.err(errorMessage(e));
    } finally { setBusy(false); }
  };

  const stopStream = async () => {
    setBusy(true);
    try {
      const r = await adminResponse(adminFetch, '/stream-stop', { method: 'POST' });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      notify.ok('stream stopped, station is off air');
      await refresh();
    } catch (e) {
      notify.err(errorMessage(e));
    } finally { setBusy(false); }
  };

  const startStream = async () => {
    setBusy(true);
    try {
      const r = await adminResponse(adminFetch, '/stream-start', { method: 'POST' });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      notify.ok('stream started, station is on air');
      await refresh();
    } catch (e) {
      notify.err(errorMessage(e));
    } finally { setBusy(false); }
  };

  /**
   * Post a whole-block patch — unless a number box in it was left blank, in
   * which case name the box and save nothing. See `save-payload.ts`.
   */
  const saveBlock = ({ patch, fieldErrors }: ReturnType<typeof dangerSavePayload> | ReturnType<typeof archivesSavePayload>) => {
    const blanks = Object.keys(fieldErrors);
    if (blanks.length > 0) {
      setFieldErrors(prev => mergePatchErrors(prev, patch, fieldErrors));
      notify.err(blanks.length === 1
        ? 'a number field is empty — fill it in before saving'
        : `${blanks.length} number fields are empty — fill them in before saving`);
      return;
    }
    saveSettings(patch);
  };

  /**
   * Archives and the danger zone used to carry a Save button per card — one for
   * the bitrate, one for the retention window, one for each stream mount. Each
   * now folds into the section's one save.
   *
   * Posting the whole block is safe rather than noisy: `settings.update()`
   * change-gates every field in these two blocks against the CURRENT value
   * before deciding it changed, so an untouched field posted alongside an
   * edited one neither writes nor flags a restart. What it is NOT safe against
   * is a blank number box, which is why both go through `saveBlock`.
   */
  const saveArchives = () => {
    if (form) saveBlock(archivesSavePayload(form));
  };

  const saveDanger = () => {
    if (form) saveBlock(dangerSavePayload(form));
  };

  const activeSpec = sectionById(activeSection);
  const baseline = formBaselineRef.current;
  const changedPaths = dirtyPaths(form, baseline, activeSpec?.formKeys ?? []);
  const changedCount = changedPaths.reduce(
    (n, path) => n + countLeafDiffs(atPath(form, path), atPath(baseline, path)),
    0,
  );
  // A section can be dirty in either currency: form paths the panel diffs, or a
  // section-local edit it cannot see (Navidrome creds, which live in
  // setup-config.json rather than settings.json).
  const hasLocalDirty = Object.values(localDirty).some(Boolean);
  const sectionDirty = changedCount > 0 || hasLocalDirty;
  // Warn BEFORE the save, from the mirrored path list. The controller stays the
  // authority afterwards — its `requiresRestart` is what raises the persistent
  // banner above.
  const restartWarn = RESTART_PATHS.some(path =>
    (activeSpec?.formKeys ?? []).some(key => path === key || path.startsWith(`${key}.`))
    && !samePath(form, baseline, path));

  const dirtyLabel = changedCount > 0
    ? `${changedCount} unsaved change${changedCount === 1 ? '' : 's'} in ${activeSpec?.label.toLowerCase() ?? 'this section'}`
    : `unsaved changes in ${activeSpec?.label.toLowerCase() ?? 'this section'}`;

  /** Roll this section's fields back to the last saved baseline, nothing else. */
  const discardSection = () => {
    if (!form || !baseline || !activeSpec) return;
    const next = JSON.parse(JSON.stringify(form)) as Record<string, unknown>;
    const from = baseline as unknown as Record<string, unknown>;
    for (const key of activeSpec.formKeys) {
      if (key in from) next[key] = JSON.parse(JSON.stringify(from[key] ?? null));
    }
    setForm(next as unknown as FormState);
    // The errors belonged to values that no longer exist — same ownership rule
    // the save path uses, so an unrelated section's message survives.
    setFieldErrors(prev => {
      const out: Record<string, string> = {};
      for (const [path, message] of Object.entries(prev)) {
        if (!ownsErrorPath(activeSpec.formKeys, path)) out[path] = message;
      }
      return out;
    });
  };

  /** Search result → switch section, open Advanced if needed, scroll and flash. */
  const jumpTo = useCallback(({ section, anchor, advanced }: SettingsJump) => {
    if (!sections.some(s => s.id === section)) return;
    setActiveSection(section);
    if (advanced) setAdvOpen(prev => ({ ...prev, [section]: true }));
    // The section swap and the disclosure both have to commit before the target
    // card exists to scroll to. A fixed delay is a bet against render time that
    // a 1200-control section can lose, and a lost jump looks exactly like a
    // broken search result — no scroll, no flash, no error. So watch for the
    // card across frames instead, and give up only after JUMP_MAX_FRAMES.
    let frames = 0;
    const settle = () => {
      const el = document.querySelector(`[data-card="${anchor}"]`);
      if (!(el instanceof HTMLElement)) {
        if (frames++ < JUMP_MAX_FRAMES) window.requestAnimationFrame(settle);
        return;
      }
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.setAttribute('data-flash', '');
      window.setTimeout(() => el.removeAttribute('data-flash'), 2600);
    };
    window.requestAnimationFrame(settle);
  }, [sections]);

  const chrome = useMemo(() => ({
    saveSlot,
    reportDirty,
    advOpen: !!advOpen[activeSection],
    setAdvOpen: (open: boolean) =>
      setAdvOpen(prev => ({ ...prev, [activeSection]: open })),
  }), [saveSlot, reportDirty, advOpen, activeSection]);

  return (
    <div className="grid min-w-0 grid-cols-1 items-start gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="grid min-w-0 gap-3.5 lg:sticky lg:top-6">
        {SECTION_GROUPS.map(group => (
          <div key={group} className="grid gap-1">
            <span className="caption pb-1">{group}</span>
            {sections.filter(s => s.group === group).map(s => {
              const isActive = activeSection === s.id;
              const Icon = s.icon;
              // A section not on screen can only be dirty in form paths — its
              // own component is unmounted, so a section-local edit (music)
              // shows a dot on the active section alone. That is accurate
              // rather than approximate: leaving those sections discards them.
              const dirty = dirtyPaths(form, baseline, s.formKeys).length > 0
                || (isActive && hasLocalDirty);
              return (
                <button
                  key={s.id}
                  onClick={() => setActiveSection(s.id)}
                  className={cn(
                    'flex cursor-pointer items-center gap-2.5 border border-ink px-3 py-2.5 text-left font-[inherit] transition-colors',
                    isActive ? 'bg-ink text-bg' : 'bg-[var(--ink-soft)] text-ink hover:bg-ink/10',
                  )}
                >
                  <Icon className="size-4 shrink-0 opacity-80" strokeWidth={2} aria-hidden />
                  <span className="grid min-w-0 flex-1 gap-1">
                    <span className="text-[11px] font-bold tracking-[0.2em] uppercase">
                      {s.label}
                    </span>
                    <span className="text-[9px] tracking-[0.18em] uppercase opacity-70">
                      {s.hint}
                    </span>
                  </span>
                  {dirty && (
                    <span
                      className="size-1.5 shrink-0 bg-vermilion"
                      title="unsaved changes"
                      aria-label="unsaved changes"
                    />
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </aside>

      <div className="grid min-w-0 grid-cols-1 gap-4">
        <SettingsSearch onJump={jumpTo} sections={sections} />
        {err && <ErrorState error={err} onRetry={refresh} />}
        {pendingRestart && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-x-3 gap-y-2 border border-vermilion bg-vermilion/10 px-4 py-3 text-[12px] text-ink"
          >
            <AlertTriangle className="size-4 shrink-0 text-vermilion" strokeWidth={2} aria-hidden />
            <span className="min-w-0 flex-1">
              <strong className="tracking-[0.08em] uppercase">Saved — not yet on air.</strong>{' '}
              The live stream is still running the previous mixer settings (bitrate, format,
              crossfade, jingle frequency). Restart the mixer to apply what you saved.
            </span>
            <Btn
              sm
              tone="danger"
              className="ml-auto"
              onClick={() => setConfirmRestart(true)}
              disabled={busy || !data}
            >
              Restart mixer to apply
            </Btn>
          </div>
        )}
        {!data && !err && <SkeletonForm fields={5} />}

        {sectionDirty && (
          <div className="sticky top-[3.25rem] z-30 grid gap-2.5 border border-vermilion bg-bg p-3 shadow-drawer">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="size-2 shrink-0 bg-vermilion" aria-hidden />
              <span className="text-[11px] font-bold tracking-[0.2em] uppercase">
                {dirtyLabel}
              </span>
              {restartWarn && (
                <Pill tone="accent" dot>needs a mixer restart</Pill>
              )}
              {changedCount > 0 && (
                <Btn sm className="ml-auto" onClick={discardSection} disabled={busy}>
                  Discard
                </Btn>
              )}
            </div>
            <div ref={setSaveSlot} className="grid gap-2.5" />
          </div>
        )}

        <SectionChromeProvider value={chrome}>
        {data && form && (() => {
          const updateForm: FormUpdater = (updater) =>
            setForm(prev => (prev ? updater(prev) : prev));
          return (
          <>
            {activeSection === 'tts' && data.tts && (
              <TtsSection
                data={data} form={form} setForm={updateForm} busy={busy}
                saveSettings={saveSettings} fieldErrors={fieldErrors} adminFetch={adminFetch} refresh={refresh}
              />
            )}
            {activeSection === 'behaviour' && (
              <DjBehaviourSection
                data={data} form={form} setForm={updateForm} busy={busy}
                saveSettings={saveSettings} fieldErrors={fieldErrors}
              />
            )}
            {djBrainEnabled && activeSection === 'brain' && (
              <BrainSection
                data={data} form={form} setForm={updateForm} busy={busy}
                saveSettings={saveSettings} fieldErrors={fieldErrors} adminFetch={adminFetch} refresh={refresh}
              />
            )}
            {activeSection === 'llm' && data.llm && (
              <LlmSection
                data={data} form={form} setForm={updateForm} busy={busy}
                saveSettings={saveSettings} fieldErrors={fieldErrors} adminFetch={adminFetch} refresh={refresh}
              />
            )}
            {activeSection === 'search' && (
              <SearchSection
                data={data} form={form} setForm={updateForm} busy={busy}
                saveSettings={saveSettings} fieldErrors={fieldErrors} adminFetch={adminFetch}
              />
            )}
            {activeSection === 'library' && (
              <LibrarySection
                data={data} form={form} setForm={updateForm} busy={busy}
                saveSettings={saveSettings} fieldErrors={fieldErrors} adminFetch={adminFetch} refresh={refresh}
              />
            )}
            {activeSection === 'station' && (
              <StationSection
                data={data} form={form} setForm={updateForm} busy={busy}
                saveSettings={saveSettings} fieldErrors={fieldErrors}
              />
            )}
            {activeSection === 'music' && (
              <NavidromeSection data={data} adminFetch={adminFetch} refresh={refresh} />
            )}
            {activeSection === 'theme' && (
              <ThemeSection
                data={data} busy={busy} saveSettings={saveSettings} fieldErrors={fieldErrors}
                adminFetch={adminFetch}
              />
            )}
            {activeSection === 'scrobble' && (
              <ScrobbleSection
                data={data} form={form} setForm={updateForm} busy={busy}
                saveSettings={saveSettings} fieldErrors={fieldErrors} adminFetch={adminFetch} refresh={refresh}
              />
            )}
            {activeSection === 'likes' && (
              <LikesSection
                data={data} form={form} setForm={updateForm} busy={busy}
                saveSettings={saveSettings} fieldErrors={fieldErrors}
              />
            )}
          </>
          );
        })()}
        {activeSection === 'archives' && (
          <>
            <ArchivesPanel />
            {form && (
              <Card title="Hourly archive" sub="state/archive/%Y-%m-%d/%H-00.mp3">
                <div className="grid gap-3">
                  <div className="field">
                    <div className="flex items-center gap-2">
                      <Label>Record the broadcast to disk</Label>
                      <Pill tone="ink">restart required</Pill>
                    </div>
                    <div className="flex items-center gap-2">
                      <Seg
                        options={[
                          { id: 'on', label: 'On' },
                          { id: 'off', label: 'Off' },
                        ]}
                        value={form.archive.enabled ? 'on' : 'off'}
                        onChange={id =>
                          setForm(f =>
                            f ? { ...f, archive: { ...f.archive, enabled: id === 'on' } } : f,
                          )
                        }
                      />
                    </div>
                    <SettingsFieldError path="archive.enabled" errors={fieldErrors} />
                    <div className="field-hint">
                      The archive runs a second MP3 encoder 24/7 and is the biggest constant
                      CPU cost in the broadcast container. Turn it off if you don't replay
                      the hourly tapes (issue #137).
                    </div>
                  </div>

                  <div className="field">
                    <div className="flex items-center gap-2">
                      <Label>Archive bitrate</Label>
                      <Pill tone="ink">restart required</Pill>
                    </div>
                    <div className="flex items-center gap-2">
                      <Select
                        value={form.archive.bitrate}
                        onValueChange={v =>
                          setForm(f => (f ? { ...f, archive: { ...f.archive, bitrate: v } } : f))
                        }
                      >
                        <SelectTrigger className="w-32" disabled={!form.archive.enabled} aria-label="Archive bitrate">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {MP3_BITRATES.map(br => (
                            <SelectItem key={br} value={String(br)}>
                              {br} kbps
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="field-hint">
                      Lower bitrate = smaller archives, less encoder CPU
                      (current: {data?.values?.archive?.bitrate ?? '—'} kbps). 128 kbps is the
                      original default.
                    </div>
                  </div>

                  <div className="field">
                    <Label>Keep recordings for</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        className="mono-num w-28"
                        aria-label="Keep recordings for (days)"
                        type="number"
                        min={0}
                        max={3650}
                        step={1}
                        value={form.archive.retentionDays}
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          setForm(f =>
                            f
                              ? { ...f, archive: { ...f.archive, retentionDays: e.target.value } }
                              : f,
                          )
                        }
                      />
                      <span className="text-[12px] text-muted">days</span>
                    </div>
                    <div className="field-hint">
                      Defaults to 30 days; 0 = keep forever. With a window set, the hourly
                      cleanup deletes whole days of recordings once they age past it. At
                      128 kbps the archive grows ~1.4 GB per day, so an unbounded archive
                      eventually fills the disk. Stations that were already archiving before
                      the 30-day default keep their keep-forever setting. Applies live, no
                      restart.
                    </div>
                  </div>
                </div>
              </Card>
            )}
            <SaveBar
              note="Turning the archive on or off, and changing its bitrate, need a mixer restart. The retention window applies live."
              busy={busy}
              onSave={saveArchives}
              saveLabel="Save archives"
              errors={fieldErrors}
              ownedKeys={['archive']}
            />
          </>
        )}
        {activeSection === 'backup' && <BackupPanel />}
        {activeSection === 'danger' && (
          <>
            <SectionHeader
              eyebrow="danger zone"
              title="Crossfade, stream control, and mixer restart."
              sub="Crossfade is grouped here because it needs a mixer restart to apply. Stream stop and mixer restart both affect every current listener."
              metrics={[
                {
                  n: data?.streamOnAir == null ? '—' : data.streamOnAir ? 'on air' : 'off air',
                  l: 'broadcast',
                  accent: data?.streamOnAir === true,
                },
                { n: `${data?.values?.crossfadeDuration ?? '—'}s`, l: 'crossfade' },
              ]}
            />

            <Card title="Broadcast" sub={data?.streamOnAir === false ? 'currently off air' : 'currently on air'}>
              <div className="grid gap-2">
                {data?.streamOnAir === false ? (
                  <Btn sm tone="accent" onClick={startStream} disabled={busy || !data}>
                    Start stream
                  </Btn>
                ) : (
                  <Btn sm tone="danger" onClick={() => setConfirmStop(true)} disabled={busy || !data || data?.streamOnAir == null}>
                    Stop stream
                  </Btn>
                )}
                <div className="field-hint">
                  Takes the station off air by disconnecting the Icecast mount. A mixer restart brings it back on air.
                </div>
              </div>
            </Card>

            {form && (
              <Card title="Idle pause" sub="silence the programme when nobody is listening">
                <div className="field">
                  <Label>Pause when the room is empty</Label>
                  <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                    <Seg
                      options={[
                        { id: 'on', label: 'On' },
                        { id: 'off', label: 'Off' },
                      ]}
                      value={form.stream.idleWhenEmpty ? 'on' : 'off'}
                      onChange={id =>
                        setForm(f =>
                          f ? { ...f, stream: { ...f.stream, idleWhenEmpty: id === 'on' } } : f,
                        )
                      }
                    />
                    <span className="text-[12px] text-muted">after</span>
                    <Input
                      className="mono-num w-24"
                      aria-label="Pause after (minutes)"
                      type="number"
                      step={1}
                      min={1}
                      max={1440}
                      value={form.stream.idleAfterMinutes}
                      onChange={(e: ChangeEvent<HTMLInputElement>) =>
                        setForm(f =>
                          f
                            ? { ...f, stream: { ...f.stream, idleAfterMinutes: e.target.value } }
                            : f,
                        )
                      }
                    />
                    <span className="text-[12px] text-muted">min</span>
                  </div>
                  <div className="field-hint">
                    After this long with zero listeners the programme pauses mid-track and the DJ
                    goes quiet: no track pulls from Navidrome, no LLM or TTS work. The stream
                    mounts stay up, so any player (VLC, Sonos, the web player) connects normally;
                    playback resumes where it left off within a few seconds of the first listener
                    tuning in. Applies live, no mixer restart.
                  </div>
                </div>
              </Card>
            )}

            <Advanced note="crossfade, duck depth, transitions, loudness and the extra stream mounts">
            {form && (
              <Card title="Crossfade" sub="track transition overlap">
                <div className="field">
                  <div className="flex items-center gap-2">
                    <Label>Crossfade duration</Label>
                    <Pill tone="ink">restart required</Pill>
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      className="mono-num w-28"
                      aria-label="Crossfade duration (seconds)"
                      type="number"
                      step={0.5}
                      max={30}
                      value={form.crossfadeDuration}
                      onChange={(e: ChangeEvent<HTMLInputElement>) =>
                        setForm(f => (f ? { ...f, crossfadeDuration: e.target.value } : f))
                      }
                    />
                    <span className="text-[12px] text-muted">sec</span>
                  </div>
                  <SettingsFieldError path="crossfadeDuration" errors={fieldErrors} />
                  <div className="field-hint">
                    Seconds of overlap between tracks (current: {data?.values?.crossfadeDuration}s).
                    Saving flags a pending restart. Apply it with the Mixer card below.
                  </div>
                </div>
              </Card>
            )}

            {form && (
              <Card title="Duck depth" sub="how far the music drops under the DJ">
                <div className="grid gap-3">
                  <div className="field">
                    <div className="flex items-center gap-2">
                      <Label>DJ over silence</Label>
                      <Pill tone="ink">restart required</Pill>
                    </div>
                    <div className="flex items-center gap-2">
                      <Input
                        className="mono-num w-28"
                        aria-label="Duck depth for solo DJ speech"
                        type="number"
                        step={0.01}
                        min={0}
                        max={1}
                        value={form.ducking.voice}
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          setForm(f => (f ? { ...f, ducking: { ...f.ducking, voice: e.target.value } } : f))
                        }
                      />
                      <span className="text-[12px] text-muted">× music</span>
                    </div>
                    <SettingsFieldError path="ducking.voice" errors={fieldErrors} />
                    <div className="field-hint">
                      The heavy duck: station IDs, the hourly time, weather and request intros
                      (current: {data?.values?.ducking?.voice}). It is the fraction of the music
                      LEFT UP, so smaller is deeper — 0.22 is about −13 dB, 1 is no duck at all
                      and 0 mutes the music while the DJ talks. Saving flags a pending restart;
                      apply it with the Mixer card below.
                    </div>
                  </div>

                  <div className="field">
                    <div className="flex items-center gap-2">
                      <Label>DJ over a track</Label>
                      <Pill tone="ink">restart required</Pill>
                    </div>
                    <div className="flex items-center gap-2">
                      <Input
                        className="mono-num w-28"
                        aria-label="Duck depth for talk-over links"
                        type="number"
                        step={0.01}
                        min={0}
                        max={1}
                        value={form.ducking.intro}
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          setForm(f => (f ? { ...f, ducking: { ...f.ducking, intro: e.target.value } } : f))
                        }
                      />
                      <span className="text-[12px] text-muted">× music</span>
                    </div>
                    <SettingsFieldError path="ducking.intro" errors={fieldErrors} />
                    <div className="field-hint">
                      The light duck for between-track links, which talk over the song rather
                      than replacing it (current: {data?.values?.ducking?.intro}). Keep it above
                      the heavy duck — 0.30 is about −10 dB. Saving flags a pending restart.
                    </div>
                  </div>
                </div>
              </Card>
            )}

            {form && (
              <Card title="Stem transitions" sub="pair-aware scheduling + rendered blends">
                <div className="grid gap-3">
                  <div className="field">
                    <Label>Pair-aware transitions</Label>
                    <div className="flex items-center gap-2">
                      <Seg
                        options={[
                          { id: 'on', label: 'On' },
                          { id: 'off', label: 'Off' },
                        ]}
                        value={form.transitions.pairDrain ? 'on' : 'off'}
                        onChange={id =>
                          setForm(f =>
                            f ? { ...f, transitions: { ...f.transitions, pairDrain: id === 'on' } } : f,
                          )
                        }
                      />
                    </div>
                    <div className="field-hint">
                      Holds each pick until its successor is known, so DJ-mode crossfades are
                      sized for the actual pair instead of a blind default. Off reverts to the
                      historical eager hand-off. Applies live; no restart.
                    </div>
                  </div>

                  <div className="field">
                    <Label>Stem cache</Label>
                    <div className="flex items-center gap-2">
                      <Seg
                        options={[
                          { id: 'on', label: 'On' },
                          { id: 'off', label: 'Off' },
                        ]}
                        value={form.transitions.stemCache ? 'on' : 'off'}
                        onChange={id =>
                          setForm(f =>
                            f ? { ...f, transitions: { ...f.transitions, stemCache: id === 'on' } } : f,
                          )
                        }
                      />
                    </div>
                    <div className="field-hint">
                      Keeps the drum/bass/vocal/other stems the heavy analyzer already separates
                      during analysis (typically 13&ndash;25&nbsp;MB per track, oldest evicted past
                      the budget). Needs the heavy analyzer image (Demucs). Turning it on now also
                      backfills: the analysis pass targets tracks with no cached stems, so an
                      already-scanned library fills in over successive runs.
                    </div>
                  </div>

                  <div className="field">
                    <Label>Stem cache budget</Label>
                    <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                      <Input
                        className="mono-num w-28"
                        aria-label="Stem cache budget (GB)"
                        type="number"
                        step={1}
                        min={1}
                        max={1000}
                        value={form.transitions.stemCacheGb}
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          setForm(f =>
                            f
                              ? { ...f, transitions: { ...f.transitions, stemCacheGb: e.target.value } }
                              : f,
                          )
                        }
                      />
                      <span className="text-sm opacity-70">
                        GB &middot; holds ~
                        {/* Track counts use the controller's 25 MB ceiling and the measured 13 MB average. */}
                        {Math.floor(
                          ((Number(form.transitions.stemCacheGb) || 15) * 1024) / 25,
                        ).toLocaleString('en-GB')}
                        &ndash;
                        {Math.floor(
                          ((Number(form.transitions.stemCacheGb) || 15) * 1024) / 13,
                        ).toLocaleString('en-GB')}{' '}
                        tracks
                      </span>
                    </div>
                    <div className="field-hint">
                      How much disk the stem cache may use before the oldest entries are evicted
                      (1&ndash;500&nbsp;GB). A blend only fires when BOTH tracks of a pair are
                      cached, so a budget well under your library size means most seams stay
                      plain crossfades. The backfill stops once the budget is full rather than
                      separating tracks it would immediately evict.
                    </div>
                  </div>

                  <div className="field">
                    <Label>Stem-blend seams</Label>
                    <div className="flex items-center gap-2">
                      <Seg
                        options={[
                          { id: 'on', label: 'On' },
                          { id: 'off', label: 'Off' },
                        ]}
                        value={form.transitions.stemBlends ? 'on' : 'off'}
                        onChange={id =>
                          setForm(f =>
                            f ? { ...f, transitions: { ...f.transitions, stemBlends: id === 'on' } } : f,
                          )
                        }
                      />
                    </div>
                    <div className="field-hint">
                      When two tempo-compatible tracks meet and both have cached stems, the seam
                      airs as a rendered blend — the outgoing track&rsquo;s drums carry under the
                      incoming intro until its own beat drops. Falls back to a plain crossfade on
                      any miss. Needs pair-aware transitions + the stem cache; the Doctor flags a
                      config that can&rsquo;t deliver.
                    </div>
                  </div>
                </div>
              </Card>
            )}

            {form && (
              <Card title="DJ transition effects" sub="which gestures the DJ may reach for">
                <div className="field-hint">
                  Only ever heard when the on-air persona is in DJ mode — this switches off
                  individual gestures without giving up the rest of the kit. The station still
                  validates every choice against the audio analysis, so switching one on is
                  permission, not a guarantee. Applies live; no restart.
                </div>
                <div className="grid gap-3">
                  {TRANSITION_EFFECT_FIELDS.map(({ id, label, hint }) => {
                    const aria = fieldAria(`transition-effect-${id}`, undefined, { hasDescription: true });
                    return (
                      <div className="field" key={id}>
                        <Label {...aria.labelledByProps}>{label}</Label>
                        <div className="flex items-center gap-2">
                          <Seg
                            {...aria.groupProps}
                            options={[
                              { id: 'on', label: 'On' },
                              { id: 'off', label: 'Off' },
                            ]}
                            value={form.transitions.effects[id] ? 'on' : 'off'}
                            onChange={v =>
                              setForm(f =>
                                f
                                  ? {
                                    ...f,
                                    transitions: {
                                      ...f.transitions,
                                      effects: { ...f.transitions.effects, [id]: v === 'on' },
                                    },
                                  }
                                  : f,
                              )
                            }
                          />
                        </div>
                        <div {...aria.descriptionProps} className="field-hint">{hint}</div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}

            {form && (
              <Card title="Max track length" sub={form.maxTrackLengthMode === 'exclude' ? 'exclude known over-length automatic tracks' : 'cut over-length tracks on air'}>
                <div className="field">
                  <Label {...lengthModeAria.labelProps}>Maximum length behavior</Label>
                  <Select value={form.maxTrackLengthMode} onValueChange={v => setForm(f => f ? { ...f, maxTrackLengthMode: v as 'cut' | 'exclude' } : f)}>
                    <SelectTrigger {...lengthModeAria.controlProps}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cut">Cut on air (legacy)</SelectItem>
                      <SelectItem value="exclude">Exclude longer automatic tracks</SelectItem>
                    </SelectContent>
                  </Select>
                  <SettingsFieldError path="maxTrackLengthMode" errors={fieldErrors} id={lengthModeAria.errorProps.id} />
                </div>
                <div className="field">
                  <Label>Maximum track length</Label>
                  <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                    <Input
                      className="mono-num w-28"
                      aria-label="Maximum track length (seconds)"
                      type="number"
                      step={1}
                      min={0}
                      max={36000}
                      value={form.maxTrackSeconds}
                      onChange={(e: ChangeEvent<HTMLInputElement>) =>
                        setForm(f => (f ? { ...f, maxTrackSeconds: e.target.value } : f))
                      }
                    />
                    <span className="text-[12px] text-muted">
                      sec · 0 = no limit · min {data?.values?.minTrackSeconds ?? 30}s
                    </span>
                  </div>
                  <SettingsFieldError path="maxTrackSeconds" errors={fieldErrors} />
                  <div className="field-hint">
                    {form.maxTrackLengthMode === 'exclude'
                      ? 'Automatic picks and fallback playlists exclude tracks with known duration above the limit. Tracks exactly at the limit are allowed. Tracks with unknown durations remain eligible and play without this cutoff. A library of only longer tracks can leave no eligible music.'
                      : 'Long tracks remain eligible for automatic picks and fade out at this limit on air.'}
                    {' '}Listener requests and explicit studio choices are exempt. Shows inherit this
                    station behavior and can override the limit (0 means unlimited). Changes apply to
                    future automatic tracks without a restart. Already handed-off playback keeps its
                    previous policy. Silence trimming and show-boundary fades still apply.
                  </div>
                </div>
              </Card>
            )}

            {form && (
              <Card title="Show boundaries" sub="stop a long track spilling into the next show">
                <div className="field">
                  <Label>Fade out at a show change</Label>
                  <div className="flex items-center gap-2">
                    <Seg
                      options={[
                        { id: 'on', label: 'On' },
                        { id: 'off', label: 'Off' },
                      ]}
                      value={form.fadeAtShowEnd ? 'on' : 'off'}
                      onChange={id => setForm(f => (f ? { ...f, fadeAtShowEnd: id === 'on' } : f))}
                    />
                  </div>
                  <SettingsFieldError path="fadeAtShowEnd" errors={fieldErrors} />
                  <div className="field-hint">
                    On a schedule built from long records — ambient, classical, prog — the last
                    track of a show can still be playing well into the next one, so the incoming
                    host talks over the outgoing show&rsquo;s music. With this on, a track that
                    would run past the boundary is faded out there instead. A short overrun is
                    left alone, a track is never cut down to a stub, and listener requests always
                    play in full. Each show can override this. Applies on the next pick; no
                    restart needed.
                  </div>
                  {(() => {
                    // The minimum play time plus overrun tolerance prevents boundary
                    // cuts at this cap. Shows can override the station cap.
                    const floor = data?.values?.boundaryFadeMinTrackSeconds ?? 150;
                    const cap = Number(form.maxTrackSeconds);
                    if (form.maxTrackLengthMode !== 'cut' || !form.fadeAtShowEnd || !Number.isFinite(cap) || cap <= 0 || cap > floor) return null;
                    return (
                      <div className="field-hint italic">
                        With <b>Maximum track length</b> at {cap}s, boundary fading cannot apply
                        to tracks using this cap: it requires more than {floor}s of playable
                        music. The cap limits track length, but a track starting near the end
                        of a show can still run into the next one. Shows that override this
                        cap may still use boundary fading.
                      </div>
                    );
                  })()}
                </div>
              </Card>
            )}

            {form && (
              <Card title="Dead-air trim" sub="cut silent gaps off track edges">
                <div className="grid gap-3">
                  <div className="field">
                    <Label>Trim silent edges</Label>
                    <div className="flex items-center gap-2">
                      <Seg
                        options={[
                          { id: 'on', label: 'On' },
                          { id: 'off', label: 'Off' },
                        ]}
                        value={form.silenceTrim.enabled ? 'on' : 'off'}
                        onChange={id =>
                          setForm(f =>
                            f ? { ...f, silenceTrim: { ...f.silenceTrim, enabled: id === 'on' } } : f,
                          )
                        }
                      />
                    </div>
                    <SettingsFieldError path="silenceTrim.enabled" errors={fieldErrors} />
                    <div className="field-hint">
                      Some rips carry a chunk of silence before the music starts, or a long blank
                      after it ends — on air that plays as dead air. With this on, the station
                      skips past the silence and cuts away at the end instead of waiting it out.
                      Needs the track analysed; unanalysed tracks play whole as before.
                    </div>
                  </div>

                  <div className="field">
                    <Label>Shortest gap worth cutting</Label>
                    <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                      <Input
                        className="mono-num w-28"
                        aria-label="Shortest gap worth cutting (milliseconds)"
                        type="number"
                        step={100}
                        min={250}
                        max={30000}
                        value={form.silenceTrim.minGapMs}
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          setForm(f =>
                            f ? { ...f, silenceTrim: { ...f.silenceTrim, minGapMs: e.target.value } } : f,
                          )
                        }
                      />
                      <span className="text-[12px] text-muted">ms</span>
                    </div>
                    <SettingsFieldError path="silenceTrim.minGapMs" errors={fieldErrors} />
                    <div className="field-hint">
                      Anything shorter than this is left alone. Tracks often open a beat after
                      zero, and albums that segue leave space between songs on purpose — raise
                      this if your library is full of them, lower it to catch smaller gaps.
                      Applies on the next pick; no restart needed.
                    </div>
                  </div>
                </div>
              </Card>
            )}

            {form && (
              <Card title="Loudness levelling" sub="per-track volume normalisation">
                <div className="grid gap-3">
                  <div className="field">
                    <Label>Loudness source</Label>
                    <Select
                      value={form.loudness.source}
                      onValueChange={v =>
                        setForm(f =>
                          f
                            ? {
                                ...f,
                                loudness: { ...f.loudness, source: v as LoudnessSource },
                              }
                            : f,
                        )
                      }
                    >
                      <SelectTrigger className="w-64" aria-label="Loudness source">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="replaygain-then-measured">
                          ReplayGain tags, then measured
                        </SelectItem>
                        <SelectItem value="replaygain">ReplayGain tags only</SelectItem>
                        <SelectItem value="measured">Measured (acoustic analysis)</SelectItem>
                      </SelectContent>
                    </Select>
                    <div className="field-hint">
                      Where each track&rsquo;s loudness figure comes from. ReplayGain tags (read
                      via Navidrome) are a whole-file stereo measurement, the most accurate when
                      your library carries them. Measured values come from this station&rsquo;s
                      acoustic analysis, which scans only the opening of each track. The default
                      prefers the tag and falls back to the measurement for untagged files.
                    </div>
                  </div>
                  <div className="field">
                    <Label>Target loudness</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        className="mono-num w-28"
                        aria-label="Target loudness (LUFS)"
                        type="number"
                        step={1}
                        min={-23}
                        max={-9}
                        value={form.loudness.targetLufs}
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          setForm(f =>
                            f ? { ...f, loudness: { ...f.loudness, targetLufs: e.target.value } } : f,
                          )
                        }
                      />
                      <span className="text-[12px] text-muted">LUFS · −23 to −9</span>
                    </div>
                    <div className="field-hint">
                      Every analysed track is pulled toward this level. −14 is the streaming
                      standard (Spotify, YouTube). A quieter target like −16 narrows the gap in
                      mixed libraries: loud modern masters come down more, and quiet dynamic ones
                      (classical, jazz) need less lift to catch up.
                    </div>
                  </div>
                  <div className="field">
                    <Label>Max boost</Label>
                    <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                      <Input
                        className="mono-num w-28"
                        aria-label="Max boost (dB)"
                        type="number"
                        step={1}
                        min={0}
                        max={12}
                        value={form.loudness.maxBoostDb}
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          setForm(f =>
                            f ? { ...f, loudness: { ...f.loudness, maxBoostDb: e.target.value } } : f,
                          )
                        }
                      />
                      <span className="text-[12px] text-muted">dB · 0 to 12</span>
                    </div>
                    <div className="field-hint">
                      Cap on how far a quiet track is turned up (0 = level down only). Boost is
                      also limited by each track&rsquo;s own measured peak headroom, so raising
                      this won&rsquo;t distort dynamic material; very quiet, dynamic masters
                      simply can&rsquo;t reach the target cleanly. Loud tracks are turned down as
                      far as needed. Applies from the next queued track; no restart, tracks need
                      acoustic analysis (Library → Analyze).
                    </div>
                  </div>
                </div>
              </Card>
            )}

            {form && (
              <Card title="Opus stream" sub="/stream.opus (Ogg-Opus)">
                <div className="grid gap-3">
                  <div className="field">
                    <div className="flex items-center gap-2">
                      <Label>Serve the secondary Opus mount</Label>
                      <Pill tone="ink">restart required</Pill>
                    </div>
                    <div className="flex items-center gap-2">
                      <Seg
                        options={[
                          { id: 'on', label: 'On' },
                          { id: 'off', label: 'Off' },
                        ]}
                        value={form.stream.opusEnabled ? 'on' : 'off'}
                        onChange={id =>
                          setForm(f =>
                            f ? { ...f, stream: { ...f.stream, opusEnabled: id === 'on' } } : f,
                          )
                        }
                      />
                    </div>
                    <SettingsFieldError path="stream.opusEnabled" errors={fieldErrors} />
                    <div className="field-hint">
                      Off by default. Only Chrome/Edge listeners ever pick Opus (Safari, iOS and
                      Firefox stay on the universal MP3 mount); for them it&apos;s equal-or-better
                      quality at ~half the bandwidth, but it adds a continuous second encoder + a
                      44.1→48 kHz resample. Turn it on if you have Chrome/Edge listeners and want
                      the bandwidth saving. The mandatory <code>/stream.mp3</code> mount serves
                      everyone either way.
                    </div>
                  </div>
                  <div className="field">
                    <div className="flex items-center gap-2">
                      <Label>Bitrate</Label>
                      <Pill tone="ink">restart required</Pill>
                    </div>
                    <div className="flex items-center gap-2">
                      <Select
                        value={form.stream.opusBitrate}
                        onValueChange={v =>
                          setForm(f => (f ? { ...f, stream: { ...f.stream, opusBitrate: v } } : f))
                        }
                      >
                        <SelectTrigger className="w-32" aria-label="Opus bitrate">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {OPUS_BITRATES.map(br => (
                            <SelectItem key={br} value={String(br)}>
                              {br} kbps
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <SettingsFieldError path="stream.opusBitrate" errors={fieldErrors} />
                    <div className="field-hint">
                      96 kbps is transparent for most music; 256/320 suits hifi listeners
                      (current: {data?.values?.stream?.opusBitrate ?? '—'} kbps). Raising it
                      increases bandwidth for <em>every</em> Chrome/Edge listener, since the web
                      player auto-selects this mount.
                    </div>
                  </div>
                </div>
              </Card>
            )}

            {form && (
              <Card title="FLAC stream" sub="/stream.flac (Ogg FLAC, lossless)">
                <div className="field">
                  <div className="flex items-center gap-2">
                    <Label>Serve the lossless FLAC mount</Label>
                    <Pill tone="ink">restart required</Pill>
                  </div>
                  <div className="flex items-center gap-2">
                    <Seg
                      options={[
                        { id: 'on', label: 'On' },
                        { id: 'off', label: 'Off' },
                      ]}
                      value={form.stream.flacEnabled ? 'on' : 'off'}
                      onChange={id =>
                        setForm(f =>
                          f ? { ...f, stream: { ...f.stream, flacEnabled: id === 'on' } } : f,
                        )
                      }
                    />
                  </div>
                  <SettingsFieldError path="stream.flacEnabled" errors={fieldErrors} />
                  {form.stream.flacEnabled && (
                    <div className="field-hint">
                      Point a player at{' '}
                      <code>
                        {typeof window !== 'undefined' ? window.location.origin : ''}
                        /stream.flac
                      </code>
                    </div>
                  )}
                  <div className="field-hint">
                    Off by default. A continuous third encoder that losslessly captures the
                    broadcast bus at ~800–900 kbps (≈4× the MP3 mount). It&apos;s a true lossless
                    tier <strong>only when your source files are themselves lossless</strong>{' '}
                    (FLAC/ALAC/WAV); for a lossy-source library (e.g. AAC/MP3) it faithfully
                    carries lossy audio and adds no fidelity over MP3/Opus. Meant for external
                    players (VLC, foobar2000, a network streamer); the web and mobile players
                    stay on MP3/Opus and won&apos;t auto-select it. Changing title, artist, and
                    album metadata is carried automatically as native chained Ogg tags. The
                    mandatory <code>/stream.mp3</code> mount always serves everyone.
                  </div>
                </div>
              </Card>
            )}

            {form && (
              <Card title="Ogg metadata" sub="Opus ICY compatibility; FLAC tags are automatic">
                <div className="field">
                  <div className="flex items-center gap-2">
                    <Label>Push ICY track titles on the Opus mount</Label>
                    <Pill tone="ink">restart required</Pill>
                  </div>
                  <div className="flex items-center gap-2">
                    <Seg
                      options={[
                        { id: 'on', label: 'On' },
                        { id: 'off', label: 'Off' },
                      ]}
                      value={form.stream.oggIcyMetadata ? 'on' : 'off'}
                      onChange={id =>
                        setForm(f =>
                          f ? { ...f, stream: { ...f.stream, oggIcyMetadata: id === 'on' } } : f,
                        )
                      }
                    />
                  </div>
                  <SettingsFieldError path="stream.oggIcyMetadata" errors={fieldErrors} />
                  <div className="field-hint">
                    On by default for legacy Opus compatibility. This controls out-of-band ICY
                    updates on <code>/stream.opus</code> only. <code>/stream.flac</code> always
                    carries changing title, artist, and album metadata as native chained Ogg tags;
                    a missing <code>Icy-MetaInt</code> response header there is expected. Receiver
                    support varies, and this setting does not embed or guarantee artwork. MP3 and
                    AAC behavior is unaffected.
                  </div>
                </div>
              </Card>
            )}

            {form && (
              <Card title="AAC stream" sub="/stream.aac (AAC-LC, ADTS)">
                <div className="grid gap-3">
                  <div className="field">
                    <div className="flex items-center gap-2">
                      <Label>Serve the AAC mount</Label>
                      <Pill tone="ink">restart required</Pill>
                    </div>
                    <div className="flex items-center gap-2">
                      <Seg
                        options={[
                          { id: 'on', label: 'On' },
                          { id: 'off', label: 'Off' },
                        ]}
                        value={form.stream.aacEnabled ? 'on' : 'off'}
                        onChange={id =>
                          setForm(f =>
                            f ? { ...f, stream: { ...f.stream, aacEnabled: id === 'on' } } : f,
                          )
                        }
                      />
                    </div>
                    <SettingsFieldError path="stream.aacEnabled" errors={fieldErrors} />
                    {form.stream.aacEnabled && (
                      <div className="field-hint">
                        Point a player at{' '}
                        <code>
                          {typeof window !== 'undefined' ? window.location.origin : ''}
                          /stream.aac
                        </code>
                      </div>
                    )}
                    <div className="field-hint">
                      Off by default. A continuous AAC-LC encoder for reach: players and
                      hardware that decode AAC but not Opus. Aimed at external players; the
                      web and mobile players stay on MP3/Opus and won&apos;t auto-select it.
                      The mandatory <code>/stream.mp3</code> mount serves everyone either way.
                    </div>
                  </div>
                  <div className="field">
                    <div className="flex items-center gap-2">
                      <Label>Bitrate</Label>
                      <Pill tone="ink">restart required</Pill>
                    </div>
                    <div className="flex items-center gap-2">
                      <Select
                        value={form.stream.aacBitrate}
                        onValueChange={v =>
                          setForm(f => (f ? { ...f, stream: { ...f.stream, aacBitrate: v } } : f))
                        }
                      >
                        <SelectTrigger className="w-32" aria-label="AAC bitrate">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {AAC_BITRATES.map(br => (
                            <SelectItem key={br} value={String(br)}>
                              {br} kbps
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <SettingsFieldError path="stream.aacBitrate" errors={fieldErrors} />
                    <div className="field-hint">
                      AAC-LC is transparent around 256 kbps (current:{' '}
                      {data?.values?.stream?.aacBitrate ?? '—'} kbps).
                    </div>
                  </div>
                </div>
              </Card>
            )}

            {form && (
              <Card title="Stream MP3 bitrate" sub="/stream.mp3">
                <div className="field">
                  <div className="flex items-center gap-2">
                    <Label>Bitrate</Label>
                    <Pill tone="ink">restart required</Pill>
                  </div>
                  <div className="flex items-center gap-2">
                    <Select
                      value={form.stream.bitrate}
                      onValueChange={v =>
                        setForm(f => (f ? { ...f, stream: { ...f.stream, bitrate: v } } : f))
                      }
                    >
                      <SelectTrigger className="w-32" aria-label="MP3 stream bitrate">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {MP3_BITRATES.map(br => (
                          <SelectItem key={br} value={String(br)}>
                            {br} kbps
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <SettingsFieldError path="stream.bitrate" errors={fieldErrors} />
                  <div className="field-hint">
                    Higher bitrate = better quality, more listener bandwidth
                    (current: {data?.values?.stream?.bitrate ?? '—'} kbps). 192 kbps is the
                    original default.
                  </div>
                </div>
              </Card>
            )}

            {form && (
              <Card title="Listener buffer" sub="all stream mounts">
                <div className="field">
                  <div className="flex items-center gap-2">
                    <Label>Listener buffer</Label>
                    <Pill tone="ink">restart required</Pill>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      className="mono-num w-28"
                      aria-label="Listener buffer (seconds)"
                      type="number"
                      min={0}
                      max={60}
                      step={1}
                      value={form.stream.bufferSeconds}
                      onChange={(e: ChangeEvent<HTMLInputElement>) =>
                        setForm(f =>
                          f
                            ? { ...f, stream: { ...f.stream, bufferSeconds: e.target.value } }
                            : f,
                        )
                      }
                    />
                    <span className="text-[12px] text-muted">seconds</span>
                  </div>
                  <SettingsFieldError path="stream.bufferSeconds" errors={fieldErrors} />
                  <div className="field-hint">
                    Icecast primes this much audio when a listener connects. Lower values start
                    closer to live and shorten idle wake-up, but leave less immediate cushion
                    for network stalls; 0 disables the connect burst. Applies on the next
                    broadcast restart. Current: {data?.values?.stream?.bufferSeconds ?? '—'}
                    {' '}seconds.
                  </div>
                </div>
              </Card>
            )}

            {form && (
              <Card title="Max listeners" sub="Icecast concurrent-connection ceiling">
                <div className="field">
                  <div className="flex items-center gap-2">
                    <Label>Max listeners</Label>
                    <Pill tone="ink">restart required</Pill>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      className="mono-num w-28"
                      aria-label="Max concurrent listeners"
                      type="number"
                      min={1}
                      max={10000}
                      step={1}
                      value={form.stream.maxListeners}
                      onChange={(e: ChangeEvent<HTMLInputElement>) =>
                        setForm(f =>
                          f
                            ? { ...f, stream: { ...f.stream, maxListeners: e.target.value } }
                            : f,
                        )
                      }
                    />
                    <span className="text-[12px] text-muted">connections</span>
                  </div>
                  <SettingsFieldError path="stream.maxListeners" errors={fieldErrors} />
                  <div className="field-hint">
                    How many people can be tuned in at once, across all mounts. Icecast
                    refuses connections past this; each one costs bandwidth at the mount&apos;s
                    bitrate, so size it against your upstream. Some countries calculate
                    licensing fees on simultaneous listener capacity, which is the usual
                    reason to set it deliberately rather than leave it at 100. Applies on the
                    next broadcast restart. Current:{' '}
                    {data?.values?.stream?.maxListeners ?? '—'}.
                  </div>
                  <div className="field-hint">
                    <strong>ICECAST_MAX_CLIENTS</strong>{' '}in the environment overrides this —
                    it predates the setting and stays authoritative where it&apos;s set. The
                    broadcast log names the source it used on every boot
                    (<code>max listeners N (from …)</code>), so check there if this field
                    saves but nothing changes.
                  </div>
                </div>
              </Card>
            )}

            {form && (
              <Card title="Listener country" sub="where the Stats rollup gets geography from">
                <div className="field">
                  <Label>Country header</Label>
                  <Input
                    className="w-full"
                    aria-label="Proxy header carrying the listener country"
                    placeholder="x-country-code"
                    value={form.stream.countryHeader}
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      setForm(f =>
                        f
                          ? { ...f, stream: { ...f.stream, countryHeader: e.target.value } }
                          : f,
                      )
                    }
                  />
                  <SettingsFieldError path="stream.countryHeader" errors={fieldErrors} />
                  <div className="field-hint">
                    Stats reads <code>CF-IPCountry</code> first, which only Cloudflare sets.
                    If your own proxy adds a country header, name it here and it is read
                    when Cloudflare&apos;s is absent. Leave blank if you have neither —
                    an unknown country is simply left out of the rollup.
                  </div>
                </div>
                <div className="field">
                  <Label>GeoIP database</Label>
                  <Input
                    className="w-full"
                    aria-label="Path to an offline GeoIP database"
                    placeholder="/var/sub-wave/geoip/GeoLite2-Country.mmdb"
                    value={form.stream.geoipDbPath}
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      setForm(f =>
                        f
                          ? { ...f, stream: { ...f.stream, geoipDbPath: e.target.value } }
                          : f,
                      )
                    }
                  />
                  <SettingsFieldError path="stream.geoipDbPath" errors={fieldErrors} />
                  <div className="field-hint">
                    Last resort when no header carries the answer: the path, inside the
                    controller container, of a MaxMind-format <code>.mmdb</code> country
                    database you supply — GeoLite2, DB-IP Lite and IP2Location LITE all
                    work. Nothing is bundled; each has its own licence and attribution
                    terms. An unreadable file is logged once and then ignored, so a wrong
                    path costs the lookup, never a listener.{' '}
                    <strong>GEOIP_DB_PATH</strong>{' '}in the environment overrides this.
                  </div>
                </div>
              </Card>
            )}


            </Advanced>

            <Card title="Mixer" sub="apply pending Liquidsoap-level settings">
              <div className="grid gap-2">
                <Btn sm tone="danger" onClick={() => setConfirmRestart(true)} disabled={busy || !data}>
                  Restart mixer
                </Btn>
                <div className="field-hint">
                  Drops the broadcast for ~3–5s. Use after crossfade or jingle frequency changes.
                  {pendingRestart && (
                    <strong className="mt-1 block text-vermilion">
                      Pending settings need a restart to apply.
                    </strong>
                  )}
                </div>
              </div>
            </Card>

            <SaveBar
              note="Crossfade, the encoder settings and the listener buffer only reach the stream after a mixer restart. Idle pause, loudness, dead-air trim and the track-length cap apply live."
              busy={busy}
              onSave={saveDanger}
              saveLabel="Save danger zone"
              errors={fieldErrors}
              ownedKeys={['crossfadeDuration', 'ducking', 'maxTrackSeconds', 'maxTrackLengthMode', 'fadeAtShowEnd', 'silenceTrim', 'transitions', 'audio', 'loudness', 'stream']}
            />
          </>
        )}
        </SectionChromeProvider>
      </div>

      <V3AlertDialog
        open={confirmRestart}
        onOpenChange={setConfirmRestart}
        title="Restart mixer"
        description="Restart the mixer to apply pending settings? The broadcast will drop for roughly 3–5 seconds."
        confirmLabel="restart mixer"
        danger
        onConfirm={restartMixer}
      />
      <V3AlertDialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        title="Stop stream"
        description="Take the station off air? The Icecast mount disconnects. Every current listener is dropped and new listeners get nothing until you start the stream again."
        confirmLabel="stop stream"
        danger
        onConfirm={stopStream}
      />
    </div>
  );
}

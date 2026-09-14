'use client';

// Export redacts API keys; restore keeps configured keys (#404). Two restore
// paths: a big tag DB can exceed a proxy's upload cap, so disk restore skips
// the upload (#612). The schedule (#1570) is an ordinary `{ backups }` settings
// key, kept here because it writes into the folder disk-restore reads.

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAdminAuth } from '../../lib/adminAuth';
import { AdminResponseError, adminResponse } from '../../lib/admin-query';
import {
  BACKUP_KEEP_BOUNDS,
  BACKUP_KEEP_DEFAULT,
  SETTINGS_BACKUP_CADENCES,
  backupsPatchSchema,
} from '@/lib/schemas.generated';
import { Card, Btn, Eyebrow, Pill, Seg } from './ui';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { FieldError } from '../ui/field';
import { V3AlertDialog } from '../ui/alert-dialog';
import { operationKeys, useRestorableBackupsQuery } from './operations-queries';
import { useSettingsMutation, useSettingsQuery } from './settings/queries';
import type { SettingsData } from './settings/shared';

interface ImportResult {
  ok?: boolean;
  restored?: string[];
  requiresRestart?: boolean;
  error?: string;
}

// One dialog + one runner serve both restore paths.
type Pending =
  | { kind: 'upload'; file: File }
  | { kind: 'disk'; name: string };

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

type BackupCadence = (typeof SETTINGS_BACKUP_CADENCES)[number];

// `keep` is a STRING because the number input can be emptied mid-edit; it
// becomes a number only in the schema pre-flight.
interface ScheduleForm {
  cadence: BackupCadence;
  keep: string;
}

function asForm(stored: { cadence?: string; keep?: number }): ScheduleForm {
  const cadence = (SETTINGS_BACKUP_CADENCES as readonly string[]).includes(stored.cadence ?? '')
    ? (stored.cadence as BackupCadence)
    : 'off';
  return { cadence, keep: String(stored.keep ?? BACKUP_KEEP_DEFAULT) };
}

/** Value identity for a form, so an effect can key on it and dirty can test it. */
const formKey = (f: ScheduleForm) => `${f.cadence}/${f.keep}`;

const CADENCE_LABELS: Record<BackupCadence, string> = {
  off: 'Off',
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
};

// Elapsed time, not a calendar step, checked hourly. Kept beside the labels so
// the two can't drift.
const CADENCE_HINTS: Record<BackupCadence, string> = {
  off: 'No backups are written and nothing is ever deleted.',
  daily: 'A snapshot roughly every 24 hours.',
  weekly: 'A snapshot roughly every 7 days.',
  monthly: 'A snapshot roughly every 30 days.',
};

export default function BackupPanel() {
  const { adminFetch, hydrated, needsAuth } = useAdminAuth();
  const queryClient = useQueryClient();
  const ready = hydrated && !needsAuth;
  const backupsQuery = useRestorableBackupsQuery(adminFetch, ready);
  const fileRef = useRef<HTMLInputElement>(null);

  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [diskDownloadErr, setDiskDownloadErr] = useState<string | null>(null);

  const [pending, setPending] = useState<Pending | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importErr, setImportErr] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const [restarting, setRestarting] = useState(false);

  // Seeded from the stored value, re-seeded only when that value MOVES: the
  // query keeps polling, so re-seeding per poll would clobber half-typed input.
  const settingsQuery = useSettingsQuery<SettingsData>({ adminFetch, enabled: ready });
  const saveSchedule = useSettingsMutation<SettingsData>({ adminFetch });
  const [schedule, setSchedule] = useState<ScheduleForm | null>(null);
  const [scheduleErr, setScheduleErr] = useState<string | null>(null);
  const [scheduleFieldErrs, setScheduleFieldErrs] = useState<Record<string, string>>({});
  const [scheduleSaved, setScheduleSaved] = useState(false);
  // What the inputs were last seeded FROM; comparing against this distinguishes
  // "operator edited" from "stored value moved underneath us".
  const seededFrom = useRef<ScheduleForm | null>(null);

  const storedBackups = settingsQuery.data?.values?.backups;
  const storedForm = storedBackups ? asForm(storedBackups) : null;
  // Fresh object every poll, so the effect keys on the VALUE.
  const storedKey = storedForm ? formKey(storedForm) : null;

  useEffect(() => {
    if (!storedForm) return;
    const seeded = seededFrom.current;
    seededFrom.current = storedForm;
    // Adopt the stored value on first paint or when there are no unsaved edits.
    if (!seeded || !schedule || formKey(schedule) === formKey(seeded)) {
      setSchedule(storedForm);
    }
  }, [storedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const commitSchedule = async () => {
    if (!schedule) return;
    setScheduleErr(null);
    setScheduleFieldErrs({});
    setScheduleSaved(false);
    // Pre-flight through the mirrored schema for the server's own message.
    // `keep` rides every patch (the dirty check compares both fields), but a
    // blank box under cadence 'off' falls back to what is stored so the save
    // isn't refused.
    const keep = schedule.keep.trim() === '' && schedule.cadence === 'off'
      ? String(storedBackups?.keep ?? BACKUP_KEEP_DEFAULT)
      : schedule.keep;
    const parsed = backupsPatchSchema.safeParse({ cadence: schedule.cadence, keep });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      // Dotted path is what keys fieldErrors, matching the server's shape.
      const path = ['backups', ...(issue?.path ?? [])].join('.');
      const message = issue?.message ?? 'the backup schedule is not valid';
      setScheduleFieldErrs({ [path]: message });
      setScheduleErr(message);
      return;
    }
    try {
      const receipt = await saveSchedule.mutateAsync({ backups: parsed.data });
      // Show what was stored, not what was typed: the fallback and the schema's
      // coercion can both differ from the raw box.
      const saved: ScheduleForm = { cadence: schedule.cadence, keep: String(parsed.data.keep) };
      seededFrom.current = saved;
      setSchedule(saved);
      setScheduleSaved(true);
      // Committed POST whose confirming GET failed: saved, but reading stale.
      if (receipt.refreshError) {
        setScheduleErr(
          `Saved, but the station's settings could not be re-read (${receipt.refreshError}). Refresh to confirm.`,
        );
      }
      // The next run may write or prune a file in the list below.
      await queryClient.invalidateQueries({ queryKey: operationKeys.restorableBackups() });
    } catch (e) {
      if (e instanceof AdminResponseError) {
        setScheduleFieldErrs(e.body?.fieldErrors ?? {});
        setScheduleErr(
          typeof e.body?.error === 'string' ? e.body.error : e.message,
        );
      } else {
        setScheduleErr(e instanceof Error ? e.message : String(e));
      }
    }
  };

  const scheduleDirty = !!schedule && !!storedForm && formKey(schedule) !== formKey(storedForm);
  // useSettingsQuery is toastOnError:false, so surface the load failure here or
  // the card sits on "Loading the schedule…" forever.
  const scheduleLoadErr = settingsQuery.error
    ? (settingsQuery.error instanceof Error ? settingsQuery.error.message : String(settingsQuery.error))
    : null;

  const diskFiles = backupsQuery.data?.files ?? null;
  const stateDir = backupsQuery.data?.stateDir ?? null;
  const loadingDisk = backupsQuery.isFetching;
  const diskErr = backupsQuery.error instanceof Error
    ? backupsQuery.error.message
    : backupsQuery.error ? String(backupsQuery.error) : null;

  const exportBackup = async () => {
    setExporting(true);
    setExportErr(null);
    try {
      // admin-query-imperative: backup-export
      const r = await adminResponse(adminFetch, '/backup/export');
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().slice(0, 10);
      const a = document.createElement('a');
      a.href = url;
      a.download = `subwave-backup-${stamp}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setExportErr(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  // Download a stored zip byte for byte. GET /backup/export would instead build
  // a NEW archive, which is not the snapshot the operator clicked.
  const downloadDiskBackup = async (name: string) => {
    setDownloading(name);
    setDiskDownloadErr(null);
    try {
      // admin-query-imperative: backup-download-file
      const r = await adminResponse(adminFetch, `/backup/file/${encodeURIComponent(name)}`);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setDiskDownloadErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading(null);
    }
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] || null;
    setResult(null);
    setImportErr(null);
    if (f) {
      setPending({ kind: 'upload', file: f });
      setConfirmRestore(true);
    }
  };

  const pickDisk = (name: string) => {
    setResult(null);
    setImportErr(null);
    setPending({ kind: 'disk', name });
    setConfirmRestore(true);
  };

  const runRestore = async (p: Pending) => {
    setImporting(true);
    setImportErr(null);
    setResult(null);
    try {
      const r =
        p.kind === 'upload'
          ? await adminResponse(adminFetch, '/backup/import', {
              method: 'POST',
              headers: { 'Content-Type': 'application/zip' },
              body: p.file,
            })
          : await adminResponse(adminFetch, '/backup/import-file', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ file: p.name }),
            });
      const j = (await r.json().catch(() => ({}))) as ImportResult;
      if (j.ok) {
        // Restore replaces settings, tags, themes, skills and media in one
        // shot — the one write broad enough to invalidate every admin family.
        await queryClient.invalidateQueries({ refetchType: 'active' });
      }
      setResult(j);
    } catch (e) {
      // 413 = a proxy rejected the upload; point at the disk path instead.
      if (p.kind === 'upload' && e instanceof AdminResponseError && e.status === 413) {
        setImportErr(
          'Backup too large to upload — a proxy in front of the station (Cloudflare caps uploads at 100 MB) rejected it. ' +
            "Copy the zip into the station's state/ folder, then restore it from “Restore from the station folder” below.",
        );
      } else {
        setImportErr(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setImporting(false);
      setPending(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const restartMixer = async () => {
    setRestarting(true);
    try {
      await adminResponse(adminFetch, '/restart-mixer', { method: 'POST' });
    } catch {
      /* surfaced elsewhere; best-effort */
    } finally {
      setRestarting(false);
    }
  };

  return (
    <div className="grid gap-4">
      <section className="card">
        <div className="border-b border-ink p-4">
          <Eyebrow className="text-vermilion">backup</Eyebrow>
          <div className="mt-1.5 text-[22px] font-extrabold tracking-[-0.02em]">
            Snapshot the station. Move it anywhere.
          </div>
          <div className="mt-1 text-[11px] leading-[1.6] text-muted">
            One zip with your personas, DJ prompt, LLM/TTS settings, shows &amp; schedule,
            the mood/tag database, and operator media (jingles, SFX, voices, themes, skills).
            API keys are <strong>redacted</strong>, so the file is safe to store and share, and a
            restore never wipes the keys already set on the target station. Navidrome
            credentials and Icecast secrets are host-specific and stay put.
          </div>
        </div>
      </section>

      <Card title="Export" sub="Download a full config + tag-DB snapshot.">
        {exportErr && (
          <div className="mb-2 text-[12px] leading-[1.6] text-[var(--danger)]">export error: {exportErr}</div>
        )}
        <Btn tone="accent" onClick={exportBackup} disabled={exporting}>
          {exporting ? 'Preparing…' : 'Download backup'}
        </Btn>
      </Card>

      <Card
        title="Schedule"
        sub="Write a snapshot into the station folder on a cadence, keeping the last few."
        right={
          // STORED cadence, not the form's: this badge says what the station is
          // doing, not what is typed.
          storedForm && storedForm.cadence !== 'off'
            ? <Pill tone="accent">on</Pill>
            : <Pill tone="ink">off</Pill>
        }
      >
        {!schedule ? (
          scheduleLoadErr ? (
            <div className="text-[12px] leading-[1.6] text-[var(--danger)]">
              The schedule could not be read: {scheduleLoadErr}
            </div>
          ) : (
            <div className="text-[12px] text-muted">Loading the schedule…</div>
          )
        ) : (
          <div className="grid gap-3">
            <div className="field">
              <Label>Cadence</Label>
              <Seg
                value={schedule.cadence}
                accent
                options={SETTINGS_BACKUP_CADENCES.map(id => ({
                  id,
                  label: CADENCE_LABELS[id] ?? id,
                  title: CADENCE_HINTS[id],
                }))}
                onChange={(v) => {
                  setScheduleSaved(false);
                  setSchedule(s => (s ? { ...s, cadence: v as BackupCadence } : s));
                }}
              />
              {scheduleFieldErrs['backups.cadence'] && (
                <FieldError errors={[{ message: scheduleFieldErrs['backups.cadence'] }]} />
              )}
              <div className="field-hint">
                {CADENCE_HINTS[schedule.cadence]} The check runs every hour and measures
                elapsed time, so a station that is only switched on for part of the day
                still gets its backup.
              </div>
            </div>

            <div className="field">
              <Label htmlFor="backups-keep">Keep the last</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="backups-keep"
                  className="mono-num w-24"
                  type="number"
                  step={1}
                  min={BACKUP_KEEP_BOUNDS.min}
                  max={BACKUP_KEEP_BOUNDS.max}
                  disabled={schedule.cadence === 'off'}
                  value={schedule.keep}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                    setScheduleSaved(false);
                    setSchedule(s => (s ? { ...s, keep: e.target.value } : s));
                  }}
                />
                <span className="text-[12px] text-muted">scheduled backups</span>
              </div>
              {scheduleFieldErrs['backups.keep'] && (
                <FieldError errors={[{ message: scheduleFieldErrs['backups.keep'] }]} />
              )}
              <div className="field-hint">
                Older ones are deleted once a new snapshot lands. Retention only ever
                touches files the schedule wrote itself
                (<code className="text-ink">subwave-auto-backup-…</code>) — a backup you
                downloaded or copied into the folder by hand is never removed, however
                low this is set. Each snapshot is a full copy including the tag database,
                so on a large library these are not small.
              </div>
            </div>

            {scheduleErr && (
              <div className="text-[12px] leading-[1.6] text-[var(--danger)]">
                {scheduleErr}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Btn
                tone="accent"
                onClick={() => { void commitSchedule(); }}
                disabled={saveSchedule.isPending || !scheduleDirty}
              >
                {saveSchedule.isPending ? 'Saving…' : 'Save schedule'}
              </Btn>
              {scheduleSaved && !scheduleDirty && (
                <span className="text-[12px] text-muted">Saved.</span>
              )}
            </div>
          </div>
        )}
      </Card>

      <Card
        title="Restore"
        sub="Overwrite this station's config + tags from a backup zip."
        right={<Pill tone="accent">overwrites</Pill>}
      >
        <div className="mb-2 text-[12px] leading-[1.6] text-muted">
          Restoring replaces the current personas, prompt, settings and tag database with the
          contents of the backup. Existing API keys are kept. Changes to mixer settings
          (jingle frequency, crossfade) need a mixer restart to take effect.
        </div>
        {importErr && (
          <div className="mb-2 text-[12px] leading-[1.6] text-[var(--danger)]">restore error: {importErr}</div>
        )}
        {result?.ok && (
          <div className="mb-2 text-[12px] leading-[1.6]">
            <span className="font-bold text-vermilion">Restored:</span>{' '}
            {result.restored?.length ? result.restored.join(', ') : '(nothing)'}
            {result.requiresRestart && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-muted">Mixer settings changed. Restart to apply.</span>
                <Btn sm tone="danger" onClick={restartMixer} disabled={restarting}>
                  {restarting ? 'Restarting…' : 'Restart mixer'}
                </Btn>
              </div>
            )}
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          accept=".zip,application/zip"
          onChange={onPick}
          aria-label="Backup zip file"
          className="hidden"
        />
        <Btn
          tone="solid"
          onClick={() => fileRef.current?.click()}
          disabled={importing}
        >
          {importing && pending?.kind === 'upload' ? 'Restoring…' : 'Choose backup zip…'}
        </Btn>
      </Card>

      <Card
        title="Restore from the station folder"
        sub="For backups too large to upload through your proxy."
        right={
          <Btn sm tone="solid" onClick={() => { void backupsQuery.refetch(); }} disabled={loadingDisk}>
            {loadingDisk ? 'Scanning…' : 'Refresh'}
          </Btn>
        }
      >
        <div className="mb-3 text-[12px] leading-[1.6] text-muted">
          A big tag database (tens of thousands of tracks) can exceed your reverse proxy&apos;s
          upload limit: Cloudflare rejects uploads over 100&nbsp;MB with a <strong>413</strong>.
          Copy the backup zip into the station&apos;s <code className="text-ink">state/</code>{' '}
          folder on the server
          {stateDir ? (
            <>
              {' '}(the directory mounted into the container at{' '}
              <code className="break-words text-ink">{stateDir}</code>)
            </>
          ) : null}
          , then <strong>Refresh</strong> and restore it here; it never travels through the proxy.
        </div>
        {diskErr && <div className="mb-2 text-[12px] leading-[1.6] text-[var(--danger)]">{diskErr}</div>}
        {diskDownloadErr && (
          <div className="mb-2 text-[12px] leading-[1.6] text-[var(--danger)]">
            download failed: {diskDownloadErr}
          </div>
        )}
        {diskFiles && diskFiles.length === 0 && !diskErr && (
          <div className="text-[12px] text-muted">
            No <code className="text-ink">.zip</code> backups found in the station folder yet.
          </div>
        )}
        {diskFiles && diskFiles.length > 0 && (
          <ul className="grid gap-1.5">
            {diskFiles.map((f) => (
              <li
                key={f.name}
                className="flex items-center justify-between gap-3 border border-ink/15 p-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="truncate text-[12px] font-bold">{f.name}</div>
                    {/* Which files retention owns — same grammar as the sweep. */}
                    {f.auto && <Pill tone="ink">scheduled</Pill>}
                  </div>
                  <div className="text-[11px] text-muted">
                    {fmtSize(f.size)} · {new Date(f.mtime).toLocaleString()}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {/* Download the file AS IT IS; Export builds a fresh archive. */}
                  <Btn
                    sm
                    onClick={() => { void downloadDiskBackup(f.name); }}
                    disabled={downloading === f.name}
                  >
                    {downloading === f.name ? 'Preparing…' : 'Download'}
                  </Btn>
                  <Btn
                    sm
                    tone="solid"
                    onClick={() => pickDisk(f.name)}
                    disabled={importing}
                  >
                    {importing && pending?.kind === 'disk' && pending.name === f.name
                      ? 'Restoring…'
                      : 'Restore'}
                  </Btn>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <V3AlertDialog
        open={confirmRestore}
        onOpenChange={(o) => {
          setConfirmRestore(o);
          if (!o) {
            setPending(null);
            if (fileRef.current) fileRef.current.value = '';
          }
        }}
        title="Restore from backup"
        description={
          pending
            ? `Restore from "${pending.kind === 'upload' ? pending.file.name : pending.name}"? This overwrites the current personas, DJ prompt, settings and tag database. Existing API keys are kept. This cannot be undone.`
            : ''
        }
        confirmLabel="restore"
        danger
        onConfirm={() => {
          setConfirmRestore(false);
          if (pending) runRestore(pending);
        }}
      />
    </div>
  );
}

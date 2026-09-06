'use client';

// Export redacts API keys; restore keeps whatever keys are already configured
// here (discussion #404). Restore has two paths because a large-library tag DB
// can exceed Cloudflare's 100 MB upload cap and bounce with a 413 — the disk
// restore skips the upload entirely (#612).
//
// The SCHEDULE (#1570) sits here rather than in a settings section because it
// writes into the same folder the disk-restore list reads: a scheduled zip and
// a hand-copied one are restored by the identical button below, and an operator
// setting a cadence wants to see where the files land. It is an ordinary
// settings key for all that — `{ backups }` through POST /settings, validated
// by the mirrored schema before it leaves the browser.

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

// The schedule card's inputs. `keep` is a STRING because it is bound to a
// number input the operator can empty mid-edit; it becomes a number only in the
// schema pre-flight.
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

// What each cadence means in practice. Elapsed time, not a calendar step, and
// checked hourly — so a station that is only powered on for part of the day
// still gets its backup. Kept next to the labels so the two can't drift.
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

  const [pending, setPending] = useState<Pending | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importErr, setImportErr] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const [restarting, setRestarting] = useState(false);

  // ── the schedule ─────────────────────────────────────────────────────────
  // Seeded from the stored value and re-seeded only when that value actually
  // MOVES: the query keeps polling (SettingsPanel shares this key), so
  // re-seeding on every poll would overwrite whatever the operator is mid-way
  // through typing, while never re-seeding leaves the card showing a
  // pre-restore schedule after the Restore button below rewrites settings.json.
  const settingsQuery = useSettingsQuery<SettingsData>({ adminFetch, enabled: ready });
  const saveSchedule = useSettingsMutation<SettingsData>({ adminFetch });
  const [schedule, setSchedule] = useState<ScheduleForm | null>(null);
  const [scheduleErr, setScheduleErr] = useState<string | null>(null);
  const [scheduleFieldErrs, setScheduleFieldErrs] = useState<Record<string, string>>({});
  const [scheduleSaved, setScheduleSaved] = useState(false);
  // What the inputs were last seeded FROM. Comparing against this rather than
  // against the live query is what lets the effect below tell "the operator
  // edited the box" apart from "the stored value moved underneath us" — a
  // hydrate-once effect cannot distinguish the two, so it never notices the
  // second and shows a pre-restore schedule for as long as the tab is open.
  const seededFrom = useRef<ScheduleForm | null>(null);

  const storedBackups = settingsQuery.data?.values?.backups;
  const storedForm = storedBackups ? asForm(storedBackups) : null;
  // The query hands back a fresh object every poll, so the effect keys on the
  // VALUE. Re-seeding on each poll would overwrite whatever is half-typed.
  const storedKey = storedForm ? formKey(storedForm) : null;

  useEffect(() => {
    if (!storedForm) return;
    const seeded = seededFrom.current;
    seededFrom.current = storedForm;
    // First paint, or the operator has no unsaved edits: adopt the stored
    // value. Unsaved edits are theirs to keep — the dirty marker then shows
    // that the boxes and the station disagree.
    if (!seeded || !schedule || formKey(schedule) === formKey(seeded)) {
      setSchedule(storedForm);
    }
  }, [storedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const commitSchedule = async () => {
    if (!schedule) return;
    setScheduleErr(null);
    setScheduleFieldErrs({});
    setScheduleSaved(false);
    // Pre-flight through the mirrored schema so a bad retention is caught
    // before a round trip, with the same message the server would send.
    // `keep` goes in every patch, including a save that only means "stop
    // backing up". Dropping it there left the stored retention behind whatever
    // the box showed, and since the dirty check compares both fields the Save
    // button then stayed lit with no save that could ever clear it. It is
    // inert while the cadence is off, so sending it costs nothing — but a
    // blank box must still not turn "stop backing up" into a validation
    // refusal, so an empty retention falls back to what is stored.
    const keep = schedule.keep.trim() === '' && schedule.cadence === 'off'
      ? String(storedBackups?.keep ?? BACKUP_KEEP_DEFAULT)
      : schedule.keep;
    const parsed = backupsPatchSchema.safeParse({ cadence: schedule.cadence, keep });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      // The dotted path is what keys fieldErrors, matching what the server
      // would send back for the same value.
      const path = ['backups', ...(issue?.path ?? [])].join('.');
      const message = issue?.message ?? 'the backup schedule is not valid';
      setScheduleFieldErrs({ [path]: message });
      setScheduleErr(message);
      return;
    }
    try {
      const receipt = await saveSchedule.mutateAsync({ backups: parsed.data });
      // Show what was actually stored, not what was typed: the fallback above
      // and the schema's own coercion can both differ from the raw box.
      const saved: ScheduleForm = { cadence: schedule.cadence, keep: String(parsed.data.keep) };
      seededFrom.current = saved;
      setSchedule(saved);
      setScheduleSaved(true);
      // A committed POST whose confirming GET failed. The schedule IS saved —
      // saying nothing would leave the Save button lit with no explanation,
      // and saying "saved" alone would hide that the panel is now reading a
      // stale envelope.
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
  // useSettingsQuery is configured toastOnError:false, so without this the card
  // sits on "Loading the schedule…" forever when /settings is unreachable.
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
        // Restore replaces settings, tags, themes, skills, and operator media
        // in one shot. This is the one write boundary broad enough to
        // invalidate every admin family: active observers refetch now;
        // inactive ones stay stale until their next mount.
        await queryClient.invalidateQueries({ refetchType: 'active' });
      }
      setResult(j);
    } catch (e) {
      // 413 means a proxy (e.g. Cloudflare, 100 MB cap) rejected the upload
      // before it reached the station — point the operator at the disk path.
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
          // The STORED cadence, not the form's: this badge says what the
          // station is doing, and reading unsaved local state made it flip to
          // "on" before anything had been saved.
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
                    {/* Which files retention owns — the same grammar the sweep
                        uses, so an operator can see at a glance that the zip
                        they copied in is not on the schedule's list. */}
                    {f.auto && <Pill tone="ink">scheduled</Pill>}
                  </div>
                  <div className="text-[11px] text-muted">
                    {fmtSize(f.size)} · {new Date(f.mtime).toLocaleString()}
                  </div>
                </div>
                <Btn
                  sm
                  tone="solid"
                  onClick={() => pickDisk(f.name)}
                  disabled={importing}
                  className="shrink-0"
                >
                  {importing && pending?.kind === 'disk' && pending.name === f.name
                    ? 'Restoring…'
                    : 'Restore'}
                </Btn>
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

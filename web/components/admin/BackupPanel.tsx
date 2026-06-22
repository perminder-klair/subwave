'use client';

// Backup — /admin/backup. Export the station's config + tag database to a
// single downloadable zip, or restore one. Export redacts API keys (they never
// leave the box); restore keeps whatever keys are already configured here. See
// discussion #404.

import { useRef, useState } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';
import { Card, Btn, Eyebrow, Pill } from './ui';
import { V3AlertDialog } from '../ui/alert-dialog';

interface ImportResult {
  ok?: boolean;
  restored?: string[];
  requiresRestart?: boolean;
  error?: string;
}

export default function BackupPanel() {
  const { adminFetch } = useAdminAuth();
  const fileRef = useRef<HTMLInputElement>(null);

  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState<string | null>(null);

  const [pending, setPending] = useState<File | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importErr, setImportErr] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const [restarting, setRestarting] = useState(false);

  const exportBackup = async () => {
    setExporting(true);
    setExportErr(null);
    try {
      const r = await adminFetch('/backup/export');
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `export failed (${r.status})`);
      }
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
      setPending(f);
      setConfirmRestore(true);
    }
  };

  const runRestore = async () => {
    if (!pending) return;
    setImporting(true);
    setImportErr(null);
    setResult(null);
    try {
      const r = await adminFetch('/backup/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip' },
        body: pending,
      });
      const j = (await r.json().catch(() => ({}))) as ImportResult;
      if (!r.ok) throw new Error(j.error || `restore failed (${r.status})`);
      setResult(j);
    } catch (e) {
      setImportErr(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
      setPending(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const restartMixer = async () => {
    setRestarting(true);
    try {
      await adminFetch('/restart-mixer', { method: 'POST' });
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
          <div className="mb-2 text-[12px] text-[var(--danger)]">export error: {exportErr}</div>
        )}
        <Btn tone="accent" onClick={exportBackup} disabled={exporting}>
          {exporting ? 'Preparing…' : 'Download backup'}
        </Btn>
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
          <div className="mb-2 text-[12px] text-[var(--danger)]">restore error: {importErr}</div>
        )}
        {result?.ok && (
          <div className="mb-2 text-[12px] leading-[1.6]">
            <span className="font-bold text-vermilion">Restored:</span>{' '}
            {result.restored?.length ? result.restored.join(', ') : '(nothing)'}
            {result.requiresRestart && (
              <div className="mt-2 flex items-center gap-2">
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
          className="hidden"
        />
        <Btn
          tone="solid"
          onClick={() => fileRef.current?.click()}
          disabled={importing}
        >
          {importing ? 'Restoring…' : 'Choose backup zip…'}
        </Btn>
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
            ? `Restore from "${pending.name}"? This overwrites the current personas, DJ prompt, settings and tag database. Existing API keys are kept. This cannot be undone.`
            : ''
        }
        confirmLabel="restore"
        danger
        onConfirm={() => {
          setConfirmRestore(false);
          runRestore();
        }}
      />
    </div>
  );
}

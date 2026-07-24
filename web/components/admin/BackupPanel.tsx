'use client';

// Backup — /admin/backup. Export the station's config + tag database to a
// single downloadable zip, or restore one. Export redacts API keys (they never
// leave the box); restore keeps whatever keys are already configured here. See
// discussion #404.
//
// Restore has two paths: a browser upload (small backups) and a disk restore
// for when the zip is too big to push through an edge proxy. A large-library
// tag DB (e.g. 29k tracks) can exceed Cloudflare's 100 MB upload cap and bounce
// with a 413; dropping the zip into the station's state/ folder and restoring
// it from the list below skips the upload entirely. See #612.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';
import { Card, Btn, Eyebrow, Pill } from './ui';
import { V3AlertDialog } from '../ui/alert-dialog';

interface ImportResult {
  ok?: boolean;
  restored?: string[];
  requiresRestart?: boolean;
  error?: string;
}

interface RestorableFile {
  name: string;
  size: number;
  mtime: string;
}

// A pending restore is either a browser-side File (upload) or the name of a zip
// already sitting in the station's state/ dir (disk restore). One dialog + one
// runner serve both.
type Pending =
  | { kind: 'upload'; file: File }
  | { kind: 'disk'; name: string };

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export default function BackupPanel() {
  const { adminFetch, hydrated, needsAuth } = useAdminAuth();
  const fileRef = useRef<HTMLInputElement>(null);

  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState<string | null>(null);

  const [pending, setPending] = useState<Pending | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importErr, setImportErr] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const [restarting, setRestarting] = useState(false);

  const [diskFiles, setDiskFiles] = useState<RestorableFile[] | null>(null);
  const [stateDir, setStateDir] = useState<string | null>(null);
  const [loadingDisk, setLoadingDisk] = useState(false);
  const [diskErr, setDiskErr] = useState<string | null>(null);

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

  const loadDiskFiles = useCallback(async () => {
    setLoadingDisk(true);
    setDiskErr(null);
    try {
      const r = await adminFetch('/backup/restorable');
      const j = (await r.json().catch(() => ({}))) as {
        files?: RestorableFile[];
        stateDir?: string;
        error?: string;
      };
      if (!r.ok) throw new Error(j.error || `couldn't list backups (${r.status})`);
      setDiskFiles(j.files || []);
      setStateDir(j.stateDir || null);
    } catch (e) {
      setDiskErr(e instanceof Error ? e.message : String(e));
      setDiskFiles(null);
    } finally {
      setLoadingDisk(false);
    }
  }, [adminFetch]);

  // Wait for the cached token to hydrate before the first fetch. Firing it
  // immediately sends an unauthenticated /backup/restorable, and the
  // controller's 401 carries `WWW-Authenticate: Basic`, which makes the
  // browser pop its native login dialog. Mirrors the gate in the other panels.
  useEffect(() => {
    if (!hydrated || needsAuth) return;
    loadDiskFiles();
  }, [hydrated, needsAuth, loadDiskFiles]);

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
          ? await adminFetch('/backup/import', {
              method: 'POST',
              headers: { 'Content-Type': 'application/zip' },
              body: p.file,
            })
          : await adminFetch('/backup/import-file', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ file: p.name }),
            });
      const j = (await r.json().catch(() => ({}))) as ImportResult;
      if (!r.ok) {
        // 413 means a proxy (e.g. Cloudflare, 100 MB cap) rejected the upload
        // before it reached the station — point the operator at the disk path.
        if (p.kind === 'upload' && r.status === 413) {
          throw new Error(
            'Backup too large to upload — a proxy in front of the station (Cloudflare caps uploads at 100 MB) rejected it. ' +
              "Copy the zip into the station's state/ folder, then restore it from “Restore from the station folder” below.",
          );
        }
        throw new Error(j.error || `restore failed (${r.status})`);
      }
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
          <div className="mb-2 text-[12px] leading-[1.6] text-[var(--danger)]">export error: {exportErr}</div>
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
          <div className="mb-2 text-[12px] leading-[1.6] text-[var(--danger)]">restore error: {importErr}</div>
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
          <Btn sm tone="solid" onClick={loadDiskFiles} disabled={loadingDisk}>
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
              <code className="text-ink">{stateDir}</code>)
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
                  <div className="truncate text-[12px] font-bold">{f.name}</div>
                  <div className="text-[11px] text-muted">
                    {fmtSize(f.size)} · {new Date(f.mtime).toLocaleString()}
                  </div>
                </div>
                <Btn sm tone="solid" onClick={() => pickDisk(f.name)} disabled={importing}>
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

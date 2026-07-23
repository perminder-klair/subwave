'use client';

import type { ChangeEvent } from 'react';
import { useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { fmtSize } from '../../../lib/format';
import { Modal } from '../../ui/modal';
import { Input } from '../../ui/input';
import { Textarea } from '../../ui/textarea';
import { Label } from '../../ui/label';
import { Button } from '../../ui/button';
import { Badge } from '../../ui/badge';
import { Btn } from '../ui';
import { PreviewButton, type SettingsData, type SaveSettings } from '../settings/shared';
import type { JingleImportFailure, JingleImportResult } from './types';
import {
  SectionMasthead, PanelBox, PanelHead, EmptyState, DropZone, MetaLine, TabMetric, pad2,
} from './parts';

interface JinglesSectionProps {
  data: SettingsData;
  busy: boolean;
  saveSettings: SaveSettings;
  // Slimmed from the full FormState — jingleRatio is the only settings field
  // this section touches, so the Imaging page holds it as a lone string rather
  // than rebuilding Settings' whole form-hydration machinery.
  jingleRatio: string;
  setJingleRatio: (v: string) => void;
  jingleText: string;
  setJingleText: (s: string) => void;
  createJingle: () => Promise<boolean>;
  uploadJingle: (
    files: File[],
    label: string,
    opts?: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal },
  ) => Promise<JingleImportResult | null>;
  onDelete: (filename: string | null) => void;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
}

export function JinglesSection({
  data, busy, jingleRatio, setJingleRatio, jingleText, setJingleText,
  createJingle, uploadJingle, saveSettings, onDelete, adminFetch,
}: JinglesSectionProps) {
  const ratioRaw = data.values?.jingleRatio;
  const ratioDirty = jingleRatio !== String(ratioRaw);
  const ratioMetric = ratioRaw == null ? '—' : ratioRaw === 0 ? 'off' : `1 : ${ratioRaw}`;
  const jingles = data.jingles || [];
  const [modal, setModal] = useState<null | 'create' | 'import'>(null);
  const [importFiles, setImportFiles] = useState<File[]>([]);
  const [importLabel, setImportLabel] = useState('');
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null);
  const [importFailures, setImportFailures] = useState<JingleImportFailure[]>([]);
  const importRef = useRef<HTMLInputElement>(null);
  const importAbort = useRef<AbortController | null>(null);
  const closeImport = () => { setModal(null); setImportFailures([]); };
  const doImport = async () => {
    if (!importFiles.length) return;
    const ac = new AbortController();
    importAbort.current = ac;
    setImportFailures([]);
    setImportProgress({ done: 0, total: importFiles.length });
    const res = await uploadJingle(importFiles, importLabel, {
      onProgress: (done, total) => setImportProgress({ done, total }),
      signal: ac.signal,
    });
    importAbort.current = null;
    setImportProgress(null);
    if (!res) return;
    // The selection always clears so a retry can't re-upload files that
    // already made it in; failures stay listed so the operator can re-pick
    // just those.
    setImportFiles([]);
    if (importRef.current) importRef.current.value = '';
    if (res.failures.length || res.aborted) {
      setImportFailures(res.failures);
    } else {
      setImportLabel('');
      setModal(null);
    }
  };
  const doCreate = async () => {
    if (await createJingle()) setModal(null);
  };

  return (
    <section className="grid gap-[22px]">
      <SectionMasthead
        title="Jingles"
        sub="Short station idents that play between tracks. One ships with the station and stays put — add as many of your own as you like alongside it."
        metrics={
          <>
            <TabMetric n={pad2(jingles.length)} l="files" />
            <TabMetric n={ratioMetric} l="ratio" />
          </>
        }
        actions={
          <>
            <Btn sm onClick={() => setModal('import')} disabled={busy}>Import</Btn>
            <Btn sm tone="solid" onClick={() => setModal('create')} disabled={busy}>+ Create</Btn>
          </>
        }
      />

      {/* Frequency */}
      <PanelBox>
        <PanelHead label="how often" right={<Badge variant="accent">restart required</Badge>} />
        <div className="flex flex-wrap items-center gap-5 px-[18px] py-[18px]">
          <div className="flex flex-none items-center gap-2.5">
            <span className="font-mono text-[13px]">1 jingle every</span>
            <Input
              className="mono-num w-[84px]"
              type="number"
              min={0}
              max={1000}
              value={jingleRatio}
              aria-label="Jingle ratio"
              onChange={(e: ChangeEvent<HTMLInputElement>) => setJingleRatio(e.target.value)}
            />
            <span className="font-mono text-[13px]">music tracks</span>
          </div>
          <p className="m-0 min-w-[220px] flex-1 text-[12px] leading-[1.55] text-muted">
            Set it to 0 to switch jingles off altogether. Changes take effect once you restart
            the mixer — that button lives in Settings → danger zone.
          </p>
          <Btn
            sm
            tone="accent"
            onClick={() => saveSettings({ jingleRatio: parseInt(jingleRatio, 10) })}
            disabled={busy || !ratioDirty}
          >
            Save · needs restart
          </Btn>
        </div>
      </PanelBox>

      {/* Library */}
      <PanelBox>
        <PanelHead label={`jingle library · ${pad2(jingles.length)}`} />
        {jingles.length === 0 ? (
          <EmptyState caption="write one and we’ll voice it, or import your own" />
        ) : (
          <div className="divide-y divide-separator-soft">
            {jingles.map(j => (
              <div
                key={j.filename}
                className="grid grid-cols-[1fr_auto] items-center gap-[18px] px-[18px] py-[15px]"
              >
                <div className="min-w-0">
                  <div className="font-display text-[18px] leading-[1.35] [text-wrap:pretty] italic">
                    &ldquo;{j.text || j.filename}&rdquo;
                  </div>
                  <MetaLine>
                    <span className="break-all">{j.filename}</span>
                    <span aria-hidden>·</span>
                    <span>{fmtSize(j.size)}</span>
                    {j.createdAt && (
                      <>
                        <span aria-hidden>·</span>
                        <span>{new Date(j.createdAt).toLocaleString('en-GB')}</span>
                      </>
                    )}
                    {j.builtin && <Badge variant="solid">builtin</Badge>}
                    {j.source === 'upload' && <Badge variant="ink">uploaded</Badge>}
                  </MetaLine>
                </div>
                <div className="flex flex-none items-center gap-2">
                  <PreviewButton
                    path={`/jingles/${encodeURIComponent(j.filename)}/audio`}
                    adminFetch={adminFetch}
                  />
                  <span title={j.builtin ? 'The default ident can’t be deleted' : 'Delete this jingle'}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Delete jingle"
                      disabled={busy || j.builtin}
                      onClick={() => onDelete(j.filename)}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </PanelBox>

      {/* Create — Piper TTS */}
      <Modal
        open={modal === 'create'}
        onOpenChange={(o) => { if (!o) setModal(null); }}
        title="create jingle"
        sub="we’ll voice it with Piper TTS"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setModal(null)}>Cancel</Button>
            <Btn sm tone="accent" onClick={doCreate} disabled={busy || !jingleText.trim()}>
              {busy ? 'Generating…' : 'Create'}
            </Btn>
          </>
        }
      >
        <div className="grid gap-1.5">
          <Label>Jingle text</Label>
          <Textarea
            rows={4}
            value={jingleText}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setJingleText(e.target.value.slice(0, 500))}
            placeholder="You’re tuned to SUB/WAVE…"
          />
          <div className="text-right font-mono text-[11px] text-muted">{jingleText.length} / 500</div>
        </div>
      </Modal>

      {/* Import — bring your own audio */}
      <Modal
        open={modal === 'import'}
        onOpenChange={(o) => { if (!o && !importProgress) closeImport(); }}
        title="import jingles"
        sub="bring your own mp3 / wav — select one or many"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={closeImport} disabled={!!importProgress}>Cancel</Button>
            <Btn sm tone="accent" onClick={doImport} disabled={busy || !importFiles.length}>
              {importProgress
                ? 'Importing…'
                : importFiles.length > 1
                  ? `Import ${importFiles.length} files`
                  : 'Import'}
            </Btn>
          </>
        }
      >
        <div className="grid gap-3.5">
          <input
            ref={importRef}
            type="file"
            multiple
            accept="audio/*,.mp3,.wav,.ogg,.flac,.m4a,.aac,.opus"
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              const list = Array.from(e.target.files ?? []);
              setImportFiles(list);
              setImportFailures([]);
              if (list.length > 1) setImportLabel('');
            }}
            className="hidden"
          />
          <DropZone
            label={
              importFiles.length
                ? `${importFiles.length} file${importFiles.length === 1 ? '' : 's'} selected — click to re-select`
                : 'choose files…'
            }
            hint="mp3 · wav · ogg · flac · m4a · aac · opus — up to 25 MB each · we convert and level-match them for you"
            onClick={() => importRef.current?.click()}
            disabled={!!importProgress}
          />

          {importFiles.length > 0 && (
            <div className="max-h-[180px] divide-y divide-separator-soft overflow-auto border border-separator-strong">
              {importFiles.map((f, i) => (
                <div
                  key={`${f.name}-${i}`}
                  className="flex justify-between gap-3 px-3 py-2 font-mono text-[11px]"
                >
                  <span className="truncate">{f.name}</span>
                  <span className="flex-none text-muted">{fmtSize(f.size)}</span>
                </div>
              ))}
            </div>
          )}

          {importFiles.length === 1 && (
            <div className="grid gap-1.5">
              <Label>Label · optional</Label>
              <Input
                value={importLabel}
                maxLength={200}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setImportLabel(e.target.value)}
                placeholder="Defaults to the file’s own name"
              />
            </div>
          )}

          {importProgress && (
            <div className="flex items-center justify-between gap-3 border border-ink px-3.5 py-2.5">
              <span className="font-mono text-[12px] font-bold">
                Importing {importProgress.done}/{importProgress.total}…
              </span>
              <Btn sm tone="danger" onClick={() => importAbort.current?.abort()}>Stop</Btn>
            </div>
          )}

          {importFailures.length > 0 && (
            <div className="border border-[var(--destructive)]">
              <div className="border-b border-separator-soft px-3 py-2 font-mono text-[10px] font-bold tracking-[0.16em] text-[var(--destructive)] uppercase">
                failed — re-select just these to retry
              </div>
              <div className="divide-y divide-separator-soft">
                {importFailures.map((f, i) => (
                  <div
                    key={`${f.name}-${i}`}
                    className="flex justify-between gap-3 px-3 py-2 font-mono text-[11px]"
                  >
                    <span className="truncate">{f.name}</span>
                    <span className="flex-none text-[var(--destructive)]">{f.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </Modal>
    </section>
  );
}

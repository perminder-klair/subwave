'use client';

import type { ChangeEvent } from 'react';
import { useRef, useState } from 'react';
import { fmtSize } from '../../../lib/format';
import { Modal } from '../../ui/modal';
import { Input } from '../../ui/input';
import { Textarea } from '../../ui/textarea';
import { Label } from '../../ui/label';
import { Card, Btn, Pill } from '../ui';
import { SectionHeader, PreviewButton, type SettingsData, type SaveSettings } from '../settings/shared';
import type { JingleImportFailure, JingleImportResult } from './types';

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
  const ratioDirty = jingleRatio !== String(data.values?.jingleRatio);
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
    <>
      <SectionHeader
        eyebrow="jingles"
        title="Pre-recorded TTS station stingers."
        sub="A default station ident is generated on first boot; you can add your own here. The built-in ident can’t be deleted."
        metrics={[
          { n: String(jingles.length), l: 'files' },
          { n: data.values?.jingleRatio === 0 ? 'off' : String(data.values?.jingleRatio), l: 'ratio', accent: true },
        ]}
      />

      <Card title="Frequency" sub="needs mixer restart">
        <div className="field">
          <div className="flex items-center gap-2">
            <Label>Jingle ratio</Label>
            <Pill tone="ink">restart required</Pill>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <Input
              className="mono-num w-24"
              type="number"
              min={0}
              max={1000}
              value={jingleRatio}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setJingleRatio(e.target.value)}
            />
            <span className="text-[12px] text-muted">music tracks per jingle</span>
            <Btn
              tone="solid"
              onClick={() => saveSettings({ jingleRatio: parseInt(jingleRatio, 10) })}
              disabled={busy || !ratioDirty}
            >
              Save · needs restart
            </Btn>
          </div>
          <div className="field-hint">
            1 jingle every N music tracks; 0 turns jingles off entirely
            (current: {data.values?.jingleRatio === 0 ? 'off' : data.values?.jingleRatio}).
            Restart the mixer from the danger zone to apply.
          </div>
        </div>
      </Card>

      <Card
        title="Jingles"
        sub={`${jingles.length} file${jingles.length === 1 ? '' : 's'}`}
        right={
          <>
            <Btn sm tone="accent" onClick={() => setModal('create')} disabled={busy}>
              + Create
            </Btn>
            <Btn sm tone="solid" onClick={() => setModal('import')} disabled={busy}>
              Import
            </Btn>
          </>
        }
      >
        {jingles.length === 0 && (
          <div className="py-2 text-[12px] text-muted italic">
            none yet
          </div>
        )}
        {jingles.map(j => (
          <div
            key={j.filename}
            className="flex items-start gap-3 border-b border-dashed border-separator-strong py-3"
          >
            <div className="min-w-0 flex-1">
              <div className="text-[13px] break-words text-ink">{j.text}</div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className="caption">{j.filename}</span>
                <span className="caption">{fmtSize(j.size)}</span>
                {j.createdAt && (
                  <span className="caption">{new Date(j.createdAt).toLocaleString('en-GB')}</span>
                )}
                {j.builtin && <Pill tone="accent">builtin</Pill>}
                {j.source === 'upload' && <Pill tone="ink">uploaded</Pill>}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <PreviewButton
                path={`/jingles/${encodeURIComponent(j.filename)}/audio`}
                adminFetch={adminFetch}
              />
              <Btn
                sm
                tone="danger"
                onClick={() => onDelete(j.filename)}
                disabled={busy || j.builtin}
                title={j.builtin ? "Can't delete the built-in ident" : 'Delete this jingle'}
              >
                Delete
              </Btn>
            </div>
          </div>
        ))}
      </Card>

      <Modal
        open={modal === 'create'}
        onOpenChange={(o) => { if (!o) setModal(null); }}
        title="Create jingle"
        sub="rendered via Piper TTS"
        footer={
          <>
            <Btn onClick={() => setModal(null)}>Cancel</Btn>
            <Btn tone="accent" onClick={doCreate} disabled={busy || !jingleText.trim()}>
              {busy ? 'Generating…' : 'Create jingle'}
            </Btn>
          </>
        }
      >
        <div className="field">
          <Label>Jingle text</Label>
          <Textarea
            rows={3}
            value={jingleText}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setJingleText(e.target.value)}
            placeholder='e.g. "You are listening to SUB slash WAVE. Requests open all night."'
          />
          <div className="field-hint">{jingleText.length}/500 chars · Piper TTS</div>
        </div>
      </Modal>

      <Modal
        open={modal === 'import'}
        onOpenChange={(o) => { if (!o && !importProgress) closeImport(); }}
        title="Import jingles"
        sub="bring your own mp3 / wav, select one or many"
        footer={
          <>
            {importProgress ? (
              <Btn onClick={() => importAbort.current?.abort()}>Stop</Btn>
            ) : (
              <Btn onClick={closeImport}>Cancel</Btn>
            )}
            <Btn tone="accent" onClick={doImport} disabled={busy || !importFiles.length}>
              {importProgress
                ? `Importing ${importProgress.done}/${importProgress.total}…`
                : importFiles.length > 1
                  ? `Import ${importFiles.length} files`
                  : 'Import jingle'}
            </Btn>
          </>
        }
      >
        <div className="field">
          <Label>Audio files</Label>
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
          <div className="flex flex-wrap items-center gap-2.5">
            <Btn tone="solid" onClick={() => importRef.current?.click()} disabled={busy}>
              {importFiles.length ? 'Change files…' : 'Choose audio files…'}
            </Btn>
            {importFiles.length === 1 && (
              <span className="text-[12px] text-ink">{importFiles[0]?.name}</span>
            )}
            {importFiles.length > 1 && (
              <span className="text-[12px] text-ink">{importFiles.length} files selected</span>
            )}
          </div>
          <div className="field-hint">
            mp3, wav, ogg, flac, m4a, aac or opus · up to 25 MB each · converted and level-matched on import.
            Selecting multiple files uploads them one at a time and keeps going past any single failure.
          </div>
          {importProgress && (
            <div className="field-hint">Uploading {importProgress.done}/{importProgress.total}…</div>
          )}
          {importFailures.length > 0 && (
            <div className="mt-2 text-[12px] text-[var(--danger)]">
              <div>{importFailures.length} file{importFailures.length === 1 ? '' : 's'} failed — re-select to retry:</div>
              <ul className="m-0 list-none p-0">
                {importFailures.map((f, i) => (
                  <li key={`${f.name}-${i}`} className="truncate">{f.name} — {f.reason}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="field mt-3.5">
          <Label>Label (optional)</Label>
          <Input
            value={importLabel}
            maxLength={200}
            disabled={importFiles.length > 1}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setImportLabel(e.target.value)}
            placeholder={importFiles.length > 1 ? 'defaults to each file name' : 'shown in the list, defaults to the file name'}
          />
        </div>
      </Modal>
    </>
  );
}

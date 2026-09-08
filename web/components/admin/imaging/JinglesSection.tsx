'use client';

import type { ChangeEvent } from 'react';
import { useRef, useState } from 'react';
import { Controller, useWatch, type Control } from 'react-hook-form';
import { Trash2 } from 'lucide-react';
import { fmtSize } from '../../../lib/format';
import { Modal } from '../../ui/modal';
import { Input } from '../../ui/input';
import { Button } from '../../ui/button';
import { Badge } from '../../ui/badge';
import { Btn, Seg } from '../ui';
import { PreviewButton, type SettingsData, type SaveSettings } from '../settings/shared';
import type { JingleImportFailure, JingleImportResult, ImagingSubmitResult } from './types';
import { notify } from '../../../lib/notify';
import {
  IMAGING_DESCRIPTION_MAX,
  JINGLE_RATIO_BOUNDS,
  JINGLE_ROTATE_OWNERS,
  JINGLE_TEXT_MAX,
  jingleCreateSchema,
  jingleImportSchema,
  jingleRatioSchema,
} from '@/lib/schemas.generated';
import { useZodForm, applyServerFieldErrors } from '@/lib/form';
import { TextField, TextareaField } from '@/lib/form-fields';
import {
  SectionMasthead, PanelBox, PanelHead, EmptyState, DropZone, MetaLine, TabMetric, pad2,
} from './parts';

interface JinglesSectionProps {
  data: SettingsData;
  busy: boolean;
  saveSettings: SaveSettings;
  jingleRatio: string;
  setJingleRatio: (v: string) => void;
  createJingle: (values: { text: string }) => Promise<ImagingSubmitResult>;
  uploadJingle: (
    files: File[],
    label: string | undefined,
    opts?: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal },
  ) => Promise<JingleImportResult | null>;
  onDelete: (filename: string | null) => void;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
}

function JingleCreateModal({
  busy, createJingle, onClose,
}: {
  busy: boolean;
  createJingle: JinglesSectionProps['createJingle'];
  onClose: () => void;
}) {
  const form = useZodForm(jingleCreateSchema, { text: '' });
  // text is a plain z.string(), so its z.input is a real string and
  // form.control needs no cast -- unlike every other field in this file.
  const textValue = useWatch({ control: form.control, name: 'text' }) || '';

  const onSubmit = form.handleSubmit(async (values) => {
    const res = await createJingle(values);
    if (res.ok) onClose();
    else applyServerFieldErrors(form, res.fieldErrors);
  });

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title="create jingle"
      sub="we’ll voice it in your station’s configured TTS voice"
      footer={
        <>
          <Button variant="ghost" size="sm" className="min-h-9 sm:min-h-0" onClick={onClose}>Cancel</Button>
          <Btn
            sm
            tone="accent"
            className="min-h-9 sm:min-h-0"
            onClick={() => void onSubmit()}
            disabled={busy || !form.formState.isValid}
          >
            {busy ? 'Generating…' : 'Create'}
          </Btn>
        </>
      }
    >
      <div className="grid gap-1.5">
        <TextareaField
          control={form.control}
          name="text"
          label="Jingle text"
          rows={4}
          placeholder="You’re tuned to SUB/WAVE…"
        />
        <div className="text-right font-mono text-[11px] text-muted">{textValue.length} / {JINGLE_TEXT_MAX}</div>
      </div>
    </Modal>
  );
}

// `label` is jingleImportSchema's one field (z.preprocess-wrapped, so unknown
// z.input, cast once). `files` (a multi-file picker) is not part of that schema
// at all, so it's a plain Controller field read via useWatch.
interface JingleImportFormValues {
  label?: string;
  files: File[];
}

function JingleImportModal({
  busy, uploadJingle, importProgress, setImportProgress, importFailures, setImportFailures, onClose,
}: {
  busy: boolean;
  uploadJingle: JinglesSectionProps['uploadJingle'];
  importProgress: { done: number; total: number } | null;
  setImportProgress: (p: { done: number; total: number } | null) => void;
  importFailures: JingleImportFailure[];
  setImportFailures: (f: JingleImportFailure[]) => void;
  onClose: () => void;
}) {
  const form = useZodForm(jingleImportSchema, { label: '' });
  const control = form.control as unknown as Control<JingleImportFormValues>;
  // `files` has no place in jingleImportSchema's own type, so clearing it after
  // a batch needs the same widened cast `control` uses.
  const setFormValue = form.setValue as unknown as <K extends keyof JingleImportFormValues>(
    name: K, value: JingleImportFormValues[K],
  ) => void;
  const files = (useWatch({ control, name: 'files' }) as File[] | undefined) || [];
  const importRef = useRef<HTMLInputElement>(null);
  const importAbort = useRef<AbortController | null>(null);

  const requestClose = () => {
    if (importProgress) return; // Cancel is disabled while a batch is in flight
    setImportFailures([]);
    onClose();
  };

  const onSubmit = form.handleSubmit(async (values) => {
    if (!files.length) return;
    const ac = new AbortController();
    importAbort.current = ac;
    setImportFailures([]);
    setImportProgress({ done: 0, total: files.length });
    const res = await uploadJingle(files, values.label, {
      onProgress: (done, total) => setImportProgress({ done, total }),
      signal: ac.signal,
    });
    importAbort.current = null;
    setImportProgress(null);
    if (!res) return;
    // Always clear the selection so a retry can't re-upload files that already
    // made it in; failures stay listed so the operator can re-pick just those.
    setFormValue('files', []);
    if (importRef.current) importRef.current.value = '';
    if (res.failures.length || res.aborted) {
      setImportFailures(res.failures);
    } else {
      setFormValue('label', '');
      onClose();
    }
  });

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) requestClose(); }}
      title="import jingles"
      sub="bring your own mp3 / wav — select one or many"
      footer={
        <>
          <Button variant="ghost" size="sm" className="min-h-9 sm:min-h-0" onClick={requestClose} disabled={!!importProgress}>Cancel</Button>
          <Btn sm tone="accent" className="min-h-9 sm:min-h-0" onClick={() => void onSubmit()} disabled={busy || !files.length}>
            {importProgress
              ? 'Importing…'
              : files.length > 1
                ? `Import ${files.length} files`
                : 'Import'}
          </Btn>
        </>
      }
    >
      <div className="grid gap-3.5">
        <Controller
          control={control}
          name="files"
          defaultValue={[]}
          render={({ field }) => (
            <>
              <input
                ref={importRef}
                type="file"
                multiple
                accept="audio/*,.mp3,.wav,.ogg,.flac,.m4a,.aac,.opus"
                aria-label="Import jingle audio files"
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const list = Array.from(e.target.files ?? []);
                  field.onChange(list);
                  setImportFailures([]);
                  if (list.length > 1) form.setValue('label', '');
                }}
                className="hidden"
              />
              <DropZone
                label={
                  field.value.length
                    ? `${field.value.length} file${field.value.length === 1 ? '' : 's'} selected — click to re-select`
                    : 'choose files…'
                }
                hint="mp3 · wav · ogg · flac · m4a · aac · opus — up to 25 MB each · we convert and level-match them for you"
                onClick={() => importRef.current?.click()}
                disabled={!!importProgress}
              />
            </>
          )}
        />

        {files.length > 0 && (
          <div className="max-h-[180px] divide-y divide-separator-soft overflow-auto border border-separator-strong">
            {files.map((f, i) => (
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

        {files.length === 1 && (
          <TextField
            control={control}
            name="label"
            label="Label · optional"
            placeholder="Defaults to the file’s own name"
            maxLength={IMAGING_DESCRIPTION_MAX}
          />
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
  );
}

export function JinglesSection({
  data, busy, jingleRatio, setJingleRatio,
  createJingle, uploadJingle, saveSettings, onDelete, adminFetch,
}: JinglesSectionProps) {
  const ratioRaw = data.values?.jingleRatio;
  const ratioDirty = jingleRatio !== String(ratioRaw);
  const ratioMetric = ratioRaw == null ? '—' : ratioRaw === 0 ? 'off' : `1 : ${ratioRaw}`;
  // Who counts the tracks (#1619). Unlike the ratio this is not held in a
  // dirty-string: a segmented control has no half-typed state, so it posts on
  // click like every other toggle. Un-hydrated reads as the default, which is
  // also what an older controller (no key in /settings) answers.
  const rotateOwner = data.values?.jingleRotate === 'controller' ? 'controller' : 'mixer';
  const jingles = data.jingles || [];
  const [modal, setModal] = useState<null | 'create' | 'import'>(null);
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null);
  const [importFailures, setImportFailures] = useState<JingleImportFailure[]>([]);
  const closeModal = () => setModal(null);

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
            <Btn sm className="min-h-9 sm:min-h-0" onClick={() => setModal('import')} disabled={busy}>Import</Btn>
            <Btn sm tone="solid" className="min-h-9 sm:min-h-0" onClick={() => setModal('create')} disabled={busy}>+ Create</Btn>
          </>
        }
      />

      <PanelBox>
        <PanelHead label="how often" right={<Badge variant="accent">restart required</Badge>} />
        <div className="flex flex-wrap items-center gap-5 px-[18px] py-[18px]">
          <div className="flex flex-wrap items-center gap-2.5 sm:flex-none">
            <span className="font-mono text-[13px]">1 jingle every</span>
            <Input
              className="mono-num w-[84px]"
              type="number"
              min={JINGLE_RATIO_BOUNDS.min}
              max={JINGLE_RATIO_BOUNDS.max}
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
            className="min-h-9 sm:min-h-0"
            onClick={() => {
              // Pre-flight against the controller's own schema, so an
              // out-of-range ratio reads the same message here and on the wire.
              // Deliberately NOT react-hook-form: it posts its own one-key
              // /settings patch and needs restart handling.
              const parsed = jingleRatioSchema.safeParse(jingleRatio);
              if (!parsed.success) {
                notify.err(parsed.error.issues[0]?.message || 'invalid value');
                return;
              }
              void saveSettings({ jingleRatio: parsed.data });
            }}
            disabled={busy || !ratioDirty}
          >
            Save · needs restart
          </Btn>
        </div>
        <div className="flex flex-wrap items-center gap-5 border-t border-separator-soft px-[18px] py-[18px]">
          <div className="flex flex-wrap items-center gap-2.5 sm:flex-none">
            <span className="font-mono text-[13px]">counted by</span>
            <Seg
              value={rotateOwner}
              aria-label="Who counts the tracks between jingles"
              options={JINGLE_ROTATE_OWNERS.map(id => ({
                id,
                label: id === 'mixer' ? 'Mixer' : 'Controller',
              }))}
              onChange={(id) => {
                if (busy || id === rotateOwner) return;
                void saveSettings({ jingleRotate: id });
              }}
            />
          </div>
          <p className="m-0 min-w-[220px] flex-1 text-[12px] leading-[1.55] text-muted">
            The mixer has always counted for itself, and the DJ only found out afterwards.
            Hand the count to the controller and a jingle becomes part of the same running
            order as the station ID — nothing else speaks on the minute it takes, and it
            waits its turn behind anything already queued for the next track.
            {' '}<strong>Restart the mixer after switching</strong>, or both will count for a
            while and you&rsquo;ll hear twice the jingles.
          </p>
        </div>
      </PanelBox>

      <PanelBox>
        <PanelHead label={`jingle library · ${pad2(jingles.length)}`} />
        {jingles.length === 0 ? (
          <EmptyState caption="write one and we’ll voice it, or import your own" />
        ) : (
          <div className="divide-y divide-separator-soft">
            {jingles.map(j => (
              <div
                key={j.filename}
                /* Mobile drops the play/delete cluster below the text: the two
                   icon buttons eat 90px of the ~310px at 390px. */
                className="grid grid-cols-1 items-center gap-3 px-[18px] py-[15px] sm:grid-cols-[1fr_auto] sm:gap-[18px]"
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
                      className="size-9 sm:size-8"
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

      {modal === 'create' && (
        <JingleCreateModal busy={busy} createJingle={createJingle} onClose={closeModal} />
      )}
      {modal === 'import' && (
        <JingleImportModal
          busy={busy} uploadJingle={uploadJingle}
          importProgress={importProgress} setImportProgress={setImportProgress}
          importFailures={importFailures} setImportFailures={setImportFailures}
          onClose={closeModal}
        />
      )}
    </section>
  );
}

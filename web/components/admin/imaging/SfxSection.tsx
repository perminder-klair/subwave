'use client';

import type { ChangeEvent } from 'react';
import { useRef, useState } from 'react';
import { Controller, useWatch, type Control } from 'react-hook-form';
import { Trash2 } from 'lucide-react';
import { fmtSize } from '../../../lib/format';
import { Modal } from '../../ui/modal';
import { Button } from '../../ui/button';
import { Badge } from '../../ui/badge';
import { V3Alert } from '../../ui/alert';
import { SkeletonCards } from '@/components/ui/skeleton';
import { Btn, Seg } from '../ui';
import { PreviewButton, type SettingsData, type SaveSettings } from '../settings/shared';
import type { SfxData, ImagingSubmitResult } from './types';
import {
  IMAGING_DESCRIPTION_MAX,
  IMAGING_NAME_MAX,
  IMAGING_PROMPT_MAX,
  SFX_MIN_SEC,
  SFX_MAX_SEC,
  sfxCreateSchema,
  imagingImportSchema,
} from '@/lib/schemas.generated';
import { useZodForm, applyServerFieldErrors } from '@/lib/form';
import { TextField, TextareaField } from '@/lib/form-fields';
import {
  SectionMasthead, PanelBox, PanelHead, EmptyState, DropZone, MetaLine, TabMetric, pad2,
} from './parts';

interface SfxSectionProps {
  sfxData: SfxData | null;
  busy: boolean;
  createSfx: (values: { name: string; description: string; prompt: string; durationSec?: number }) => Promise<ImagingSubmitResult>;
  uploadSfx: (file: File, values: { name: string; description: string }) => Promise<ImagingSubmitResult>;
  onDelete: (name: string | null) => void;
  data: SettingsData | null;
  saveSettings: SaveSettings;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
}

// The RHF-bound shape of the create form. name/description/durationSec are all
// z.preprocess-wrapped in the shared schema, so their z.input is `unknown` --
// cast once here rather than at every TextField call site.
interface SfxCreateFormValues {
  name: string;
  description: string;
  prompt: string;
  durationSec: string | number;
}

function SfxCreateModal({
  busy, ready, createSfx, onClose,
}: {
  busy: boolean;
  ready: boolean;
  createSfx: SfxSectionProps['createSfx'];
  onClose: () => void;
}) {
  const form = useZodForm(sfxCreateSchema, { name: '', description: '', prompt: '', durationSec: '' });
  const control = form.control as unknown as Control<SfxCreateFormValues>;
  const promptValue = (useWatch({ control, name: 'prompt' }) as string | undefined) || '';

  const onSubmit = form.handleSubmit(async (values) => {
    const res = await createSfx(values);
    if (res.ok) onClose();
    else applyServerFieldErrors(form, res.fieldErrors);
  });

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title="create effect"
      sub="we’ll generate it with ElevenLabs"
      footer={
        <>
          <Button variant="ghost" size="sm" className="min-h-9 sm:min-h-0" onClick={onClose}>Cancel</Button>
          <Btn
            sm
            tone="accent"
            className="min-h-9 sm:min-h-0"
            onClick={() => void onSubmit()}
            disabled={busy || !ready || !form.formState.isValid}
          >
            {busy ? 'Generating…' : 'Create'}
          </Btn>
        </>
      }
    >
      <div className="grid gap-3.5">
        {!ready && (
          <V3Alert title="key required">
            You’ll need an ElevenLabs key to generate. Add{' '}
            <code className="font-mono text-[12px]">ELEVENLABS_API_KEY</code> and restart the
            controller.
          </V3Alert>
        )}
        <div className="grid grid-cols-[1fr_120px] gap-3">
          <TextField control={control} name="name" label="Name" placeholder="tape-stop" maxLength={IMAGING_NAME_MAX} />
          <TextField control={control} name="durationSec" label="Duration · s" numeric placeholder="auto" step={0.1} min={SFX_MIN_SEC} max={SFX_MAX_SEC} />
        </div>
        <TextField
          control={control}
          name="description"
          label="Description · optional"
          placeholder="Your DJ reads this to decide when the effect fits a line"
          maxLength={IMAGING_DESCRIPTION_MAX}
        />
        <div className="grid gap-1.5">
          <TextareaField
            control={control}
            name="prompt"
            label="Generation prompt"
            rows={3}
            placeholder="Describe the sound for ElevenLabs…"
          />
          <div className="text-right font-mono text-[11px] text-muted">{promptValue.length} / {IMAGING_PROMPT_MAX}</div>
        </div>
      </div>
    </Modal>
  );
}

// The RHF-bound shape of the import form: name/description mirror
// imagingImportSchema (also preprocess-wrapped). `file` rides alongside so the
// DropZone reads through the same `control`, but it is NOT part of the zod
// schema (a File object isn't describable there), so it never appears in
// handleSubmit's validated `values` -- read separately via useWatch.
interface SfxImportFormValues {
  name: string;
  description: string;
  file: File | null;
}

function SfxImportModal({
  busy, uploadSfx, onClose,
}: {
  busy: boolean;
  uploadSfx: SfxSectionProps['uploadSfx'];
  onClose: () => void;
}) {
  const form = useZodForm(imagingImportSchema, { name: '', description: '' });
  const control = form.control as unknown as Control<SfxImportFormValues>;
  const file = useWatch({ control, name: 'file' }) as File | null;
  const importRef = useRef<HTMLInputElement>(null);

  const onSubmit = form.handleSubmit(async (values) => {
    if (!file) return; // Save is disabled without one — see below
    const res = await uploadSfx(file, values);
    if (res.ok) onClose();
    else applyServerFieldErrors(form, res.fieldErrors);
  });

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title="import effect"
      sub="bring your own mp3 / wav — no ElevenLabs key needed"
      footer={
        <>
          <Button variant="ghost" size="sm" className="min-h-9 sm:min-h-0" onClick={onClose}>Cancel</Button>
          <Btn
            sm
            tone="accent"
            className="min-h-9 sm:min-h-0"
            onClick={() => void onSubmit()}
            disabled={busy || !file || !form.formState.isValid}
          >
            {busy ? 'Importing…' : 'Import'}
          </Btn>
        </>
      }
    >
      <div className="grid gap-3.5">
        <TextField control={control} name="name" label="Name" placeholder="rain-hiss" maxLength={IMAGING_NAME_MAX} />
        <TextField
          control={control}
          name="description"
          label="Description · optional"
          placeholder="Your DJ reads this to decide when the effect fits a line"
          maxLength={IMAGING_DESCRIPTION_MAX}
        />
        <Controller
          control={control}
          name="file"
          defaultValue={null}
          render={({ field }) => (
            <>
              <input
                ref={importRef}
                type="file"
                accept="audio/*,.mp3,.wav,.ogg,.flac,.m4a,.aac,.opus"
                aria-label="Import SFX audio file"
                onChange={(e: ChangeEvent<HTMLInputElement>) => field.onChange(e.target.files?.[0] ?? null)}
                className="hidden"
              />
              <DropZone
                label={field.value ? `${field.value.name} · ${fmtSize(field.value.size)}` : 'choose a file…'}
                hint="mp3 · wav · ogg · flac · m4a · aac · opus — up to 25 MB · converted to MP3 on import"
                onClick={() => importRef.current?.click()}
              />
            </>
          )}
        />
      </div>
    </Modal>
  );
}

export function SfxSection({ sfxData, busy, createSfx, uploadSfx, onDelete, data, saveSettings, adminFetch }: SfxSectionProps) {
  // Hooks must run before the early "loading…" return — keep them at the top.
  const [modal, setModal] = useState<null | 'create' | 'import'>(null);
  const closeModal = () => setModal(null);

  if (!sfxData) {
    return <SkeletonCards cards={4} />;
  }
  const list = sfxData.sfx || [];
  const ready = !!sfxData.generatorReady;
  const enabled = data?.values?.sfx?.enabled !== false;

  return (
    <section className="grid gap-[22px]">
      <SectionMasthead
        title="Sound effects"
        sub="Little stingers your DJ can drop under its voice during a break — a record scratch, an airhorn, a whoosh. A handful ship with the station."
        metrics={<TabMetric accent n={pad2(list.length)} l="effects" />}
        actions={
          <>
            <Btn sm className="min-h-9 sm:min-h-0" onClick={() => setModal('import')} disabled={busy}>Import</Btn>
            <Btn sm tone="solid" className="min-h-9 sm:min-h-0" onClick={() => setModal('create')} disabled={busy}>+ Create</Btn>
          </>
        }
      />

      <PanelBox>
        <div className="flex flex-wrap items-center justify-between gap-5 px-[18px] py-[16px]">
          <div className="min-w-[240px] flex-1">
            <div className="font-mono text-[10px] font-bold tracking-[0.2em] uppercase">stingers</div>
            <p className="mt-1.5 text-[12px] leading-[1.55] text-muted">
              {enabled
                ? 'When on, your DJ can reach for these and mix them under its voice during a break.'
                : 'Off — your DJ never reaches for a stinger. Your library stays put.'}
            </p>
          </div>
          <Seg
            accent
            value={enabled ? 'on' : 'off'}
            options={[{ id: 'on', label: 'On' }, { id: 'off', label: 'Off' }]}
            onChange={v => { if (!busy) saveSettings({ sfx: { enabled: v === 'on' } }); }}
          />
        </div>
      </PanelBox>

      <PanelBox>
        <PanelHead label={`effect library · ${pad2(list.length)}`} />
        {list.length === 0 ? (
          <EmptyState caption="generate one with ElevenLabs, or import your own" />
        ) : (
          <div className="divide-y divide-separator-soft">
            {list.map(s => (
              <div
                key={s.name}
                /* Mobile drops the play/delete cluster below the text (as JinglesSection). */
                className="grid grid-cols-1 items-center gap-3 px-[18px] py-[15px] sm:grid-cols-[1fr_auto] sm:gap-[18px]"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-3">
                    <span className="font-mono text-[14px] font-bold">{s.name}</span>
                    {s.description && <span className="text-[13px] text-muted">{s.description}</span>}
                  </div>
                  <MetaLine>
                    <span>{fmtSize(s.size)}</span>
                    {s.durationSec != null && (
                      <>
                        <span aria-hidden>·</span>
                        <span>{s.durationSec}s</span>
                      </>
                    )}
                    {s.builtin && <Badge variant="solid">builtin</Badge>}
                    {s.source === 'upload' && <Badge variant="ink">uploaded</Badge>}
                  </MetaLine>
                </div>
                <div className="flex flex-none items-center gap-2">
                  <PreviewButton
                    path={`/sfx/${encodeURIComponent(s.name)}/audio`}
                    adminFetch={adminFetch}
                  />
                  <span title={s.builtin ? 'Built-in effects can’t be deleted' : 'Delete this effect'}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Delete effect"
                      className="size-9 sm:size-8"
                      disabled={busy || s.builtin}
                      onClick={() => onDelete(s.name)}
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
        <SfxCreateModal busy={busy} ready={ready} createSfx={createSfx} onClose={closeModal} />
      )}
      {modal === 'import' && (
        <SfxImportModal busy={busy} uploadSfx={uploadSfx} onClose={closeModal} />
      )}
    </section>
  );
}

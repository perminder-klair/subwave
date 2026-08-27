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
import { V3Alert } from '../../ui/alert';
import { SkeletonCards } from '@/components/ui/skeleton';
import { Btn, Seg } from '../ui';
import { PreviewButton, type SettingsData, type SaveSettings } from '../settings/shared';
import type { BedsData, ImagingSubmitResult } from './types';
import { notify } from '../../../lib/notify';
import {
  BEDS_CROSS_SEC_BOUNDS,
  BEDS_TAIL_SEC_BOUNDS,
  BEDS_THRESHOLD_SEC_BOUNDS,
  IMAGING_DESCRIPTION_MAX,
  IMAGING_NAME_MAX,
  IMAGING_PROMPT_MAX,
  bedCreateSchema,
  bedsPatchSchema,
  imagingImportSchema,
} from '@/lib/schemas.generated';
import { useZodForm, applyServerFieldErrors } from '@/lib/form';
import { TextField, TextareaField } from '@/lib/form-fields';
import {
  SectionMasthead, PanelBox, PanelHead, EmptyState, DropZone, MetaLine, TabMetric, pad2,
} from './parts';

interface BedsSectionProps {
  bedsData: BedsData | null;
  busy: boolean;
  createBed: (values: { name: string; description: string; prompt: string; durationSec?: number }) => Promise<ImagingSubmitResult>;
  uploadBed: (file: File, values: { name: string; description: string }) => Promise<ImagingSubmitResult>;
  onDelete: (name: string | null) => void;
  data: SettingsData | null;
  saveSettings: SaveSettings;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
}

// name/description/durationSec are z.preprocess-wrapped in the shared schema
// (unknown z.input) — cast once here, same as SfxSection.
interface BedsCreateFormValues {
  name: string;
  description: string;
  prompt: string;
  durationSec: string | number;
}

function BedsCreateModal({
  busy, ready, minSec, maxGenSec, createBed, onClose,
}: {
  busy: boolean;
  ready: boolean;
  minSec: number;
  maxGenSec: number;
  createBed: BedsSectionProps['createBed'];
  onClose: () => void;
}) {
  const form = useZodForm(bedCreateSchema, { name: '', description: '', prompt: '', durationSec: '' });
  const control = form.control as unknown as Control<BedsCreateFormValues>;
  const promptValue = (useWatch({ control, name: 'prompt' }) as string | undefined) || '';

  const onSubmit = form.handleSubmit(async (values) => {
    const res = await createBed(values);
    if (res.ok) onClose();
    else applyServerFieldErrors(form, res.fieldErrors);
  });

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title="create bed"
      sub="an instrumental we’ll generate with ElevenLabs"
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
          <TextField control={control} name="name" label="Name" placeholder="midnight-drift" maxLength={IMAGING_NAME_MAX} />
          <TextField control={control} name="durationSec" label="Length · s" numeric placeholder="45" step={1} min={minSec} max={maxGenSec} />
        </div>
        <TextField
          control={control}
          name="description"
          label="Description · optional"
          placeholder="For your own reference — the DJ never reads this"
          maxLength={IMAGING_DESCRIPTION_MAX}
        />
        <div className="grid gap-1.5">
          <TextareaField
            control={control}
            name="prompt"
            label="Generation prompt"
            rows={3}
            placeholder="Describe the instrumental for ElevenLabs — e.g. warm lo-fi ambient pad, no drums, soft and neutral…"
          />
          <div className="text-right font-mono text-[11px] text-muted">{promptValue.length} / {IMAGING_PROMPT_MAX}</div>
        </div>
        <p className="m-0 text-[12px] leading-[1.55] [text-wrap:pretty] text-muted">
          Vocal-free instrumental, {minSec}–{maxGenSec}s. Each bed is trimmed to fit the link, so
          it just needs to outlast your DJ’s longest bit of chat — atmospheric and neutral works
          best.
        </p>
      </div>
    </Modal>
  );
}

// `file` rides on the same control as name/description but is not part of the
// zod schema — see SfxSection's ImportFormValues comment for why.
interface BedsImportFormValues {
  name: string;
  description: string;
  file: File | null;
}

function BedsImportModal({
  busy, minSec, uploadBed, onClose,
}: {
  busy: boolean;
  minSec: number;
  uploadBed: BedsSectionProps['uploadBed'];
  onClose: () => void;
}) {
  const form = useZodForm(imagingImportSchema, { name: '', description: '' });
  const control = form.control as unknown as Control<BedsImportFormValues>;
  const file = useWatch({ control, name: 'file' }) as File | null;
  const importRef = useRef<HTMLInputElement>(null);

  const onSubmit = form.handleSubmit(async (values) => {
    if (!file) return; // Save is disabled without one — see below
    const res = await uploadBed(file, values);
    if (res.ok) onClose();
    else applyServerFieldErrors(form, res.fieldErrors);
  });

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title="import bed"
      sub="an instrumental the DJ can talk over"
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
        <TextField control={control} name="name" label="Name" placeholder="midnight-drift" maxLength={IMAGING_NAME_MAX} />
        <TextField
          control={control}
          name="description"
          label="Description · optional"
          placeholder="For your own reference — the DJ never reads this"
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
                aria-label="Import bed audio file"
                onChange={(e: ChangeEvent<HTMLInputElement>) => field.onChange(e.target.files?.[0] ?? null)}
                className="hidden"
              />
              <DropZone
                label={field.value ? `${field.value.name} · ${fmtSize(field.value.size)}` : 'choose a file…'}
                hint={`mp3 · wav · ogg · flac · m4a · aac · opus — at least ${minSec}s · up to 25 MB · converted to MP3`}
                onClick={() => importRef.current?.click()}
              />
            </>
          )}
        />
        <p className="m-0 text-[12px] leading-[1.55] [text-wrap:pretty] text-muted">
          Each bed is trimmed to fit the link and never loops — it only needs to outlast your
          DJ’s longest bit of chat. Atmospheric, with no strong key, works best.
        </p>
      </div>
    </Modal>
  );
}

export function BedsSection({ bedsData, busy, createBed, uploadBed, onDelete, data, saveSettings, adminFetch }: BedsSectionProps) {
  // Hooks must run before the early "loading…" return — keep them at the top.
  const [modal, setModal] = useState<null | 'create' | 'import'>(null);
  const closeModal = () => setModal(null);
  // null = show the saved value, so the inputs stay controlled and an out-of-range
  // entry snaps back on blur instead of lingering as a never-persisted number.
  const [thresholdEdit, setThresholdEdit] = useState<string | null>(null);
  const [crossEdit, setCrossEdit] = useState<string | null>(null);
  const [tailEdit, setTailEdit] = useState<string | null>(null);

  if (!bedsData) {
    return <SkeletonCards cards={4} />;
  }
  const list = bedsData.beds || [];
  const minSec = bedsData.minDurationSec ?? 30;
  const maxGenSec = bedsData.maxGenDurationSec ?? 120;
  const ready = !!bedsData.generatorReady;
  const beds = data?.values?.beds;
  const enabled = beds?.enabled === true;
  // Mirrors the controller's default (settings/defaults.ts): on WITHIN beds,
  // which are themselves off by default. `?? true` rather than `=== true` is
  // the whole difference — a station saved before this field existed has no
  // stored value and must read as on, the same way the controller decides it.
  const requestIntros = beds?.requestIntros ?? true;
  const thresholdSec = beds?.thresholdSec ?? 12;
  const crossSec = beds?.crossSec ?? 6;
  const tailSec = beds?.tailSec ?? 3;

  // Pre-flight against the SAME schema the controller enforces, so the bounds
  // can't drift and an out-of-range value gets the server's own message rather
  // than silently reverting to the stored number.
  //
  // This inline pair (threshold/cross) is deliberately NOT converted to
  // react-hook-form — see ImagingPanel.tsx's saveSettings comment: each one
  // posts its own one-key /settings patch, and `Object.values(j.fieldErrors ||
  // {})[0]` is already the more specific of the two messages.
  const saveNumber = async (
    raw: string, current: number,
    patch: (v: number) => Record<string, unknown>,
    reset: (v: string | null) => void,
  ) => {
    const parsed = bedsPatchSchema.safeParse(patch(parseFloat(raw)).beds);
    if (!parsed.success) {
      notify.err(parsed.error.issues[0]?.message || 'invalid value');
      reset(null);
      return;
    }
    const [[field, value]] = Object.entries(parsed.data) as [[string, number]];
    if (value !== current) {
      await saveSettings({ beds: { [field]: value } }); // refreshes `data`, so clearing shows the new value
    }
    reset(null);
  };

  return (
    <section className="grid gap-[22px]">
      <SectionMasthead
        title="Beds"
        sub="Instrumentals your DJ talks over between songs — the track ends, the bed carries the chat, and the next song fades in under the closing words."
        metrics={<TabMetric accent n={pad2(list.length)} l="beds" />}
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
            <div className="font-mono text-[10px] font-bold tracking-[0.2em] uppercase">talk beds</div>
            <p className="mt-1.5 text-[12px] leading-[1.55] text-muted">
              {enabled
                ? 'When on, longer links get their own instrumental to sit on. You’ll need at least one bed long enough to carry the chat.'
                : 'Off — links play over the incoming song, like before. Your library stays put.'}
            </p>
          </div>
          <Seg
            accent
            value={enabled ? 'on' : 'off'}
            options={[{ id: 'on', label: 'On' }, { id: 'off', label: 'Off' }]}
            onChange={v => { if (!busy) saveSettings({ beds: { enabled: v === 'on' } }); }}
          />
        </div>
        {enabled && (
          <div className="flex flex-wrap items-center justify-between gap-5 border-t border-separator-soft px-[18px] py-[16px]">
            <div className="min-w-[240px] flex-1">
              <div className="font-mono text-[10px] font-bold tracking-[0.2em] uppercase">listener requests</div>
              <p className="mt-1.5 text-[12px] leading-[1.55] text-muted">
                {requestIntros
                  ? 'A requested song always gets a bed in front, however short the intro — somebody asked for it, so its opening plays clean.'
                  : 'Off — request intros play over the song’s opening instead.'}
              </p>
            </div>
            <Seg
              accent
              value={requestIntros ? 'on' : 'off'}
              options={[{ id: 'on', label: 'On' }, { id: 'off', label: 'Off' }]}
              onChange={v => { if (!busy) saveSettings({ beds: { requestIntros: v === 'on' } }); }}
            />
          </div>
        )}
      </PanelBox>

      {enabled && list.length === 0 && (
        <V3Alert title="no beds in the library">
          Beds are on, but there’s nothing here yet — links keep playing over the incoming song
          until you add a bed at least {minSec} seconds long.
        </V3Alert>
      )}

      <PanelBox>
        <PanelHead label="when to use a bed" />
        {/* One column on mobile: two 155px cells can't hold a sentence, a number
            field and a unit. */}
        <div className="grid grid-cols-1 sm:grid-cols-2">
          <div className="border-b border-separator-soft p-[18px] sm:border-r">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="text-[13px] font-semibold">Bed links longer than</span>
              <Input
                className="mono-num w-[72px]"
                type="number"
                step={1}
                min={BEDS_THRESHOLD_SEC_BOUNDS.min}
                max={BEDS_THRESHOLD_SEC_BOUNDS.max}
                value={thresholdEdit ?? String(thresholdSec)}
                disabled={busy}
                aria-label="Bed threshold seconds"
                onChange={(e: ChangeEvent<HTMLInputElement>) => setThresholdEdit(e.target.value)}
                onBlur={() => {
                  if (thresholdEdit == null) return;
                  void saveNumber(thresholdEdit, thresholdSec,
                    v => ({ beds: { thresholdSec: v } }), setThresholdEdit);
                }}
              />
              <span className="font-mono text-[12px] text-muted">seconds</span>
            </div>
            <p className="mt-2.5 text-[12px] leading-[1.55] [text-wrap:pretty] text-muted">
              Anything longer than this gets its own bed. Where we’ve measured a track’s vocals,
              that wins — a bed lands exactly when your DJ would otherwise talk over singing, and
              instrumentals never get one. Saves when you click away.
            </p>
          </div>
          <div className="border-b border-separator-soft p-[18px]">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="text-[13px] font-semibold">Bed alone before the next song</span>
              <Input
                className="mono-num w-[72px]"
                type="number"
                step={1}
                min={BEDS_TAIL_SEC_BOUNDS.min}
                max={BEDS_TAIL_SEC_BOUNDS.max}
                value={tailEdit ?? String(tailSec)}
                disabled={busy}
                aria-label="Bed tail seconds"
                onChange={(e: ChangeEvent<HTMLInputElement>) => setTailEdit(e.target.value)}
                onBlur={() => {
                  if (tailEdit == null) return;
                  void saveNumber(tailEdit, tailSec,
                    v => ({ beds: { tailSec: v } }), setTailEdit);
                }}
              />
              <span className="font-mono text-[12px] text-muted">seconds</span>
            </div>
            <p className="mt-2.5 text-[12px] leading-[1.55] [text-wrap:pretty] text-muted">
              Bed playing on its own after your DJ stops talking, before the next song starts
              coming in. This is a beat of breathing room, not a gap — 0 starts the next song on
              the last syllable. Saves when you click away.
            </p>
          </div>
          <div className="p-[18px] sm:col-span-2">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="text-[13px] font-semibold">Ramp into the next song</span>
              <Input
                className="mono-num w-[72px]"
                type="number"
                step={1}
                min={BEDS_CROSS_SEC_BOUNDS.min}
                max={BEDS_CROSS_SEC_BOUNDS.max}
                value={crossEdit ?? String(crossSec)}
                disabled={busy}
                aria-label="Ramp seconds"
                onChange={(e: ChangeEvent<HTMLInputElement>) => setCrossEdit(e.target.value)}
                onBlur={() => {
                  if (crossEdit == null) return;
                  void saveNumber(crossEdit, crossSec,
                    v => ({ beds: { crossSec: v } }), setCrossEdit);
                }}
              />
              <span className="font-mono text-[12px] text-muted">seconds</span>
            </div>
            <p className="mt-2.5 text-[12px] leading-[1.55] [text-wrap:pretty] text-muted">
              How long the next song takes to fade in once the bed tail above has run. 0 is a
              hard cut. Your DJ is never talking over this — that is what the bed is for. Saves
              when you click away.
            </p>
          </div>
        </div>
      </PanelBox>

      <PanelBox>
        <PanelHead label={`bed library · ${pad2(list.length)}`} />
        {list.length === 0 ? (
          <EmptyState caption="generate one with ElevenLabs, or import an instrumental" />
        ) : (
          <div className="divide-y divide-separator-soft">
            {list.map(b => (
              <div
                key={b.name}
                /* Mobile drops the play/delete cluster below the text (as JinglesSection). */
                className="grid grid-cols-1 items-center gap-3 px-[18px] py-[15px] sm:grid-cols-[1fr_auto] sm:gap-[18px]"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-3">
                    <span className="font-mono text-[14px] font-bold">{b.name}</span>
                    {b.description && <span className="text-[13px] text-muted">{b.description}</span>}
                  </div>
                  <MetaLine>
                    <span>{fmtSize(b.size)}</span>
                    {b.durationSec != null && (
                      <>
                        <span aria-hidden>·</span>
                        <span>{Math.round(b.durationSec)}s</span>
                      </>
                    )}
                    {b.builtin && <Badge variant="solid">builtin</Badge>}
                    {b.source === 'generated' && <Badge variant="ink">generated</Badge>}
                    {b.source === 'upload' && <Badge variant="ink">uploaded</Badge>}
                  </MetaLine>
                </div>
                <div className="flex flex-none items-center gap-2">
                  <PreviewButton
                    path={`/beds/${encodeURIComponent(b.name)}/audio`}
                    adminFetch={adminFetch}
                  />
                  <span title={b.builtin ? 'The built-in bed can’t be deleted' : 'Delete this bed'}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Delete bed"
                      className="size-9 sm:size-8"
                      disabled={busy || b.builtin}
                      onClick={() => onDelete(b.name)}
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
        <BedsCreateModal
          busy={busy} ready={ready} minSec={minSec} maxGenSec={maxGenSec}
          createBed={createBed} onClose={closeModal}
        />
      )}
      {modal === 'import' && (
        <BedsImportModal busy={busy} minSec={minSec} uploadBed={uploadBed} onClose={closeModal} />
      )}
    </section>
  );
}

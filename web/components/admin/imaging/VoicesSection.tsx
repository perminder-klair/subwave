'use client';

/* The WAVs Chatterbox and PocketTTS clone from. Import-only — there is no
   prompt-to-voice generator. Files dropped into state/voices/ by hand show up here. */

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
import { Btn } from '../ui';
import { PreviewButton } from '../settings/shared';
import { IMAGING_NAME_MAX, voiceImportSchema } from '@/lib/schemas.generated';
import { useZodForm, applyServerFieldErrors } from '@/lib/form';
import { TextField } from '@/lib/form-fields';
import type { VoiceData, ImagingSubmitResult } from './types';
import {
  SectionMasthead, PanelBox, PanelHead, EmptyState, DropZone, MetaLine, TabMetric, pad2,
} from './parts';

interface VoicesSectionProps {
  voicesData: VoiceData | null;
  busy: boolean;
  uploadVoice: (file: File, values: { name: string }) => Promise<ImagingSubmitResult>;
  onDelete: (file: string | null) => void;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
}

// Mirrors ACCEPTED_AUDIO_EXTS in controller/src/audio/audio-import.ts.
const ACCEPT = '.wav,.mp3,.ogg,.oga,.flac,.m4a,.aac,.opus,audio/*';

// `name` is imagingName underneath (z.preprocess-wrapped, unknown z.input), so
// cast once as SfxSection/BedsSection do. `file` isn't in voiceImportSchema (a
// zod-only shared module can't describe a File), so read it via useWatch
// rather than handleSubmit's validated values.
interface VoiceImportFormValues {
  name: string;
  file: File | null;
}

function VoiceImportModal({
  busy, noFfmpeg, dir, uploadVoice, onClose,
}: {
  busy: boolean;
  noFfmpeg: boolean;
  dir: string;
  uploadVoice: VoicesSectionProps['uploadVoice'];
  onClose: () => void;
}) {
  const form = useZodForm(voiceImportSchema, { name: '' });
  const control = form.control as unknown as Control<VoiceImportFormValues>;
  const file = useWatch({ control, name: 'file' }) as File | null;
  const nameValue = (useWatch({ control, name: 'name' }) as string | undefined) || '';
  const importRef = useRef<HTMLInputElement>(null);

  const onSubmit = form.handleSubmit(async (values) => {
    if (!file) return; // Save is disabled without one — see below
    const res = await uploadVoice(file, values);
    if (res.ok) onClose();
    else applyServerFieldErrors(form, res.fieldErrors);
  });

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title="import voice"
      sub="a short recording of the voice you want to clone"
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
        {noFfmpeg && (
          <V3Alert title="wav only on this host">
            ffmpeg isn’t installed here, so other formats can’t be converted. Upload a{' '}
            <code className="font-mono text-[12px]">.wav</code>, or run the Docker image —
            it ships ffmpeg.
          </V3Alert>
        )}
        <div>
          <Controller
            control={control}
            name="file"
            defaultValue={null}
            render={({ field }) => (
              <>
                <DropZone
                  label={field.value ? field.value.name : 'choose an audio file'}
                  hint={noFfmpeg ? 'wav' : 'wav · mp3 · m4a · ogg · flac · opus'}
                  onClick={() => importRef.current?.click()}
                  disabled={busy}
                />
                <input
                  ref={importRef}
                  type="file"
                  accept={ACCEPT}
                  className="hidden"
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const f = e.target.files?.[0] || null;
                    field.onChange(f);
                    // Default the name field from the picked filename, same as before —
                    // only when the operator hasn't already typed one.
                    if (f && !nameValue.trim()) {
                      form.setValue('name', f.name.replace(/\.[^.]+$/, ''), { shouldValidate: true });
                    }
                  }}
                />
              </>
            )}
          />
        </div>
        <div>
          <TextField
            control={control}
            name="name"
            label="Name"
            placeholder="late-night-dj"
            maxLength={IMAGING_NAME_MAX}
            description={`Becomes the filename personas pick from. Stored as a mono .wav in ${dir}, so you can also drop files there by hand.`}
          />
        </div>
      </div>
    </Modal>
  );
}

export function VoicesSection({ voicesData, busy, uploadVoice, onDelete, adminFetch }: VoicesSectionProps) {
  // Hooks must run before the early "loading…" return — keep them at the top.
  const [modal, setModal] = useState(false);

  if (!voicesData) {
    return <SkeletonCards cards={4} />;
  }
  const list = voicesData.voices || [];
  const dir = voicesData.dir || 'state/voices/';
  const noFfmpeg = voicesData.ffmpeg === false;
  const minSec = voicesData.advisory?.minSec ?? 4;
  const maxSec = voicesData.advisory?.maxSec ?? 20;

  return (
    <section className="grid gap-[22px]">
      <SectionMasthead
        title="Voices"
        sub="Reference clips your DJ personas can be cloned from. About five seconds of clean speech is enough — one voice, no music, no background noise."
        metrics={<TabMetric accent n={pad2(list.length)} l="voices" />}
        actions={
          <Btn sm tone="solid" className="min-h-9 sm:min-h-0" onClick={() => setModal(true)} disabled={busy}>
            Import
          </Btn>
        }
      />

      <PanelBox>
        <PanelHead label={`voice library · ${pad2(list.length)}`} />
        {list.length === 0 ? (
          <EmptyState caption="import a ~5 second recording to clone a voice" />
        ) : (
          <div className="divide-y divide-separator-soft">
            {list.map(v => (
              /* Mobile drops the play/delete cluster below the text (as SfxSection). */
              <div
                key={v.file}
                className="grid grid-cols-1 items-center gap-3 px-[18px] py-[15px] sm:grid-cols-[1fr_auto] sm:gap-[18px]"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-3">
                    <span className="font-mono text-[14px] font-bold">{v.file}</span>
                    {v.legacy && <Badge variant="ink">legacy folder</Badge>}
                  </div>
                  <MetaLine>
                    {v.size != null && <span>{fmtSize(v.size)}</span>}
                    {v.durationSec != null && (
                      <>
                        <span aria-hidden>·</span>
                        <span>{v.durationSec}s</span>
                      </>
                    )}
                  </MetaLine>
                  {/* Advisory, never blocking: the file is stored exactly as uploaded. */}
                  {v.warning === 'short' && (
                    <p className="mt-1.5 text-[11px] leading-[1.55] text-muted">
                      Under {minSec}s — there may not be enough speech here to clone reliably.
                    </p>
                  )}
                  {v.warning === 'long' && (
                    <p className="mt-1.5 text-[11px] leading-[1.55] text-muted">
                      Over {maxSec}s — longer clips slow every line this persona speaks without
                      sounding better.
                    </p>
                  )}
                </div>
                <div className="flex flex-none items-center gap-2">
                  <PreviewButton
                    path={`/voices/${encodeURIComponent(v.file)}/audio`}
                    adminFetch={adminFetch}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Delete voice"
                    className="size-9 sm:size-8"
                    disabled={busy}
                    onClick={() => onDelete(v.file)}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </PanelBox>

      {modal && (
        <VoiceImportModal
          busy={busy} noFfmpeg={noFfmpeg} dir={dir}
          uploadVoice={uploadVoice} onClose={() => setModal(false)}
        />
      )}
    </section>
  );
}

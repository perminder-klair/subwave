'use client';

import type { ChangeEvent } from 'react';
import { useRef, useState } from 'react';
import { fmtSize } from '../../../lib/format';
import { Modal } from '../../ui/modal';
import { Input } from '../../ui/input';
import { Textarea } from '../../ui/textarea';
import { Label } from '../../ui/label';
import { Card, Btn, Pill, Seg } from '../ui';
import {
  SectionHeader, PreviewButton,
  type SettingsData, type SaveSettings, type SfxData, type SfxForm,
} from './shared';

interface SfxSectionProps {
  sfxData: SfxData | null;
  sfxForm: SfxForm;
  setSfxForm: (updater: (f: SfxForm) => SfxForm) => void;
  busy: boolean;
  createSfx: () => Promise<boolean>;
  uploadSfx: (file: File, name: string, description: string) => Promise<boolean>;
  onDelete: (name: string | null) => void;
  data: SettingsData | null;
  saveSettings: SaveSettings;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
}

export function SfxSection({ sfxData, sfxForm, setSfxForm, busy, createSfx, uploadSfx, onDelete, data, saveSettings, adminFetch }: SfxSectionProps) {
  // Hooks must run before the early "loading…" return — keep them at the top.
  const [modal, setModal] = useState<null | 'create' | 'import'>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importName, setImportName] = useState('');
  const [importDesc, setImportDesc] = useState('');
  const importRef = useRef<HTMLInputElement>(null);
  const doImport = async () => {
    if (!importFile || !importName.trim()) return;
    const ok = await uploadSfx(importFile, importName, importDesc);
    if (ok) {
      setImportFile(null);
      setImportName('');
      setImportDesc('');
      if (importRef.current) importRef.current.value = '';
      setModal(null);
    }
  };
  const doCreate = async () => {
    if (await createSfx()) setModal(null);
  };

  if (!sfxData) {
    return <div className="text-[13px] text-muted italic">loading…</div>;
  }
  const list = sfxData.sfx || [];
  const ready = !!sfxData.generatorReady;
  const enabled = data?.values?.sfx?.enabled !== false;

  return (
    <>
      <SectionHeader
        eyebrow="sound effects"
        title="Stingers the DJ agent plays under its voice."
        sub="The segment-director agent can garnish a spoken break with one of these effects, mixed beneath the voice. Built-in effects ship with the station; add your own by generating one from a text prompt (ElevenLabs) or importing an audio file."
        metrics={[{ n: String(list.length), l: 'effects', accent: true }]}
      />

      <Card title="Sound effects" sub="whether the DJ agent uses stingers at all">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[13px] font-bold">Enable sound effects</div>
            <div className="mt-0.5 max-w-[480px] text-[11px] leading-[1.5] text-muted">
              When off, the segment-director agent is never shown the effect catalogue and stops
              playing stingers under its voice. The library below is kept either way.
            </div>
          </div>
          <Seg
            accent
            value={enabled ? 'on' : 'off'}
            options={[
              { id: 'off', label: 'Off' },
              { id: 'on', label: 'On' },
            ]}
            onChange={v => { if (!busy) saveSettings({ sfx: { enabled: v === 'on' } }); }}
          />
        </div>
      </Card>

      {!ready && (
        <div className="card">
          <div className="card-body text-[12px] leading-[1.5] text-muted">
            <strong className="tracking-[0.12em] text-ink uppercase">
              ElevenLabs key not set
            </strong>
            <div className="mt-1">
              The built-in effects work without a key. An ElevenLabs API key is only needed to
              generate <em>new</em> effects below. Set <code>ELEVENLABS_API_KEY</code> in{' '}
              <code>.env</code> (or set the cloud TTS provider to ElevenLabs with a key
              entered), then restart the controller.
            </div>
          </div>
        </div>
      )}

      <Card
        title="Effect library"
        sub={`${list.length} effect${list.length === 1 ? '' : 's'}`}
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
        {list.length === 0 && (
          <div className="py-2 text-[12px] text-muted italic">
            none yet
          </div>
        )}
        {list.map(s => (
          <div
            key={s.name}
            className="flex items-start gap-3 border-b border-dashed border-separator-strong py-3"
          >
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-bold text-ink">{s.name}</div>
              {s.description && (
                <div className="mt-0.5 text-[12px] break-words text-muted">
                  {s.description}
                </div>
              )}
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className="caption">{fmtSize(s.size)}</span>
                {s.durationSec && <span className="caption">{s.durationSec}s</span>}
                {s.builtin && <Pill tone="accent">builtin</Pill>}
                {s.source === 'upload' && <Pill tone="ink">uploaded</Pill>}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <PreviewButton
                path={`/sfx/${encodeURIComponent(s.name)}/audio`}
                adminFetch={adminFetch}
              />
              <Btn
                sm
                tone="danger"
                onClick={() => onDelete(s.name)}
                disabled={busy || s.builtin}
                title={s.builtin ? "Can't delete a built-in effect" : 'Delete this effect'}
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
        title="Create sound effect"
        sub="rendered via ElevenLabs"
        footer={
          <>
            <Btn onClick={() => setModal(null)}>Cancel</Btn>
            <Btn
              tone="accent"
              onClick={doCreate}
              disabled={busy || !ready || !sfxForm.name.trim() || !sfxForm.prompt.trim()}
            >
              {busy ? 'Generating…' : 'Create sound effect'}
            </Btn>
          </>
        }
      >
        {!ready && (
          <div className="field-hint mb-3.5">
            An ElevenLabs API key is required to generate effects. Set <code>ELEVENLABS_API_KEY</code>{' '}
            and restart the controller, or use Import instead.
          </div>
        )}
        <div className="field">
          <Label>Name</Label>
          <Input
            value={sfxForm.name}
            maxLength={60}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setSfxForm(f => ({ ...f, name: e.target.value }))}
            placeholder="e.g. record-scratch"
            className="max-w-[280px]"
          />
          <div className="field-hint">A short slug the agent references: letters, numbers and dashes.</div>
        </div>
        <div className="field mt-3.5">
          <Label>Description</Label>
          <Input
            value={sfxForm.description}
            maxLength={200}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setSfxForm(f => ({ ...f, description: e.target.value }))}
            placeholder="when the agent should reach for this effect"
          />
          <div className="field-hint">The agent reads this to decide when the effect fits a line.</div>
        </div>
        <div className="field mt-3.5">
          <Label>Generation prompt</Label>
          <Textarea
            rows={2}
            value={sfxForm.prompt}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setSfxForm(f => ({ ...f, prompt: e.target.value }))}
            placeholder='e.g. "abrupt vinyl record scratch, short and sharp"'
          />
          <div className="field-hint">{sfxForm.prompt.length}/500 chars. Describe the sound for ElevenLabs.</div>
        </div>
        <div className="field mt-3.5">
          <Label>Duration (optional)</Label>
          <div className="flex items-center gap-2">
            <Input
              className="mono-num w-28"
              type="number"
              step={0.5}
              min={0.5}
              max={22}
              value={sfxForm.durationSec}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setSfxForm(f => ({ ...f, durationSec: e.target.value }))}
              placeholder="auto"
            />
            <span className="text-[12px] text-muted">sec · 0.5–22, blank lets the model decide</span>
          </div>
        </div>
      </Modal>

      <Modal
        open={modal === 'import'}
        onOpenChange={(o) => { if (!o) setModal(null); }}
        title="Import sound effect"
        sub="bring your own mp3 / wav, no ElevenLabs key needed"
        footer={
          <>
            <Btn onClick={() => setModal(null)}>Cancel</Btn>
            <Btn
              tone="accent"
              onClick={doImport}
              disabled={busy || !importFile || !importName.trim()}
            >
              {busy ? 'Importing…' : 'Import sound effect'}
            </Btn>
          </>
        }
      >
        <div className="field">
          <Label>Name</Label>
          <Input
            value={importName}
            maxLength={60}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setImportName(e.target.value)}
            placeholder="e.g. my-stinger"
            className="max-w-[280px]"
          />
          <div className="field-hint">A short slug the agent references: letters, numbers and dashes.</div>
        </div>
        <div className="field mt-3.5">
          <Label>Description</Label>
          <Input
            value={importDesc}
            maxLength={200}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setImportDesc(e.target.value)}
            placeholder="when the agent should reach for this effect"
          />
          <div className="field-hint">The agent reads this to decide when the effect fits a line.</div>
        </div>
        <div className="field mt-3.5">
          <Label>Audio file</Label>
          <input
            ref={importRef}
            type="file"
            accept="audio/*,.mp3,.wav,.ogg,.flac,.m4a,.aac,.opus"
            onChange={(e: ChangeEvent<HTMLInputElement>) => setImportFile(e.target.files?.[0] ?? null)}
            className="hidden"
          />
          <div className="flex flex-wrap items-center gap-2.5">
            <Btn tone="solid" onClick={() => importRef.current?.click()} disabled={busy}>
              {importFile ? 'Change file…' : 'Choose audio file…'}
            </Btn>
            {importFile && <span className="text-[12px] text-ink">{importFile.name}</span>}
          </div>
          <div className="field-hint">mp3, wav, ogg, flac, m4a, aac or opus · up to 25 MB · converted to MP3 on import</div>
        </div>
      </Modal>
    </>
  );
}

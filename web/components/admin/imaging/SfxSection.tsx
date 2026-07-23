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
import { V3Alert } from '../../ui/alert';
import { Btn, Seg } from '../ui';
import { PreviewButton, type SettingsData, type SaveSettings } from '../settings/shared';
import type { SfxData, SfxForm } from './types';
import {
  SectionMasthead, PanelBox, PanelHead, EmptyState, DropZone, MetaLine, TabMetric, pad2,
} from './parts';

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
    <section className="grid gap-[22px]">
      <SectionMasthead
        title="Sound effects"
        sub="Stingers the segment-director agent mixes under its voice during a spoken break. Built-ins ship with the station."
        metrics={<TabMetric accent n={pad2(list.length)} l="effects" />}
      />

      {/* On/off */}
      <PanelBox>
        <div className="flex flex-wrap items-center justify-between gap-5 px-[18px] py-[16px]">
          <div className="min-w-[240px] flex-1">
            <div className="font-mono text-[10px] font-bold tracking-[0.2em] uppercase">stingers</div>
            <p className="mt-1.5 text-[12px] leading-[1.55] text-muted">
              {enabled
                ? 'The agent sees the effect catalogue and mixes stingers under its voice during spoken breaks.'
                : 'Off — the agent never sees the catalogue and plays no stingers. The library is kept.'}
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

      {!ready && (
        <V3Alert title="no ElevenLabs key">
          Built-in effects work without a key — one is only needed to generate new ones. Set{' '}
          <code className="font-mono text-[12px]">ELEVENLABS_API_KEY</code> and restart the
          controller to enable Create.
        </V3Alert>
      )}

      {/* Library */}
      <PanelBox>
        <PanelHead
          label={`effect library · ${pad2(list.length)}`}
          right={
            <>
              <Btn sm onClick={() => setModal('import')} disabled={busy}>Import</Btn>
              <Btn sm tone="solid" onClick={() => setModal('create')} disabled={busy}>+ Create</Btn>
            </>
          }
        />
        {list.length === 0 ? (
          <EmptyState caption="generate via ElevenLabs or import your own" />
        ) : (
          <div className="divide-y divide-separator-soft">
            {list.map(s => (
              <div
                key={s.name}
                className="grid grid-cols-[1fr_auto] items-center gap-[18px] px-[18px] py-[15px]"
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

      {/* Create — ElevenLabs */}
      <Modal
        open={modal === 'create'}
        onOpenChange={(o) => { if (!o) setModal(null); }}
        title="create effect"
        sub="rendered via ElevenLabs"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setModal(null)}>Cancel</Button>
            <Btn
              sm
              tone="accent"
              onClick={doCreate}
              disabled={busy || !ready || !sfxForm.name.trim() || !sfxForm.prompt.trim()}
            >
              {busy ? 'Generating…' : 'Create'}
            </Btn>
          </>
        }
      >
        <div className="grid gap-3.5">
          {!ready && (
            <V3Alert title="key required">
              Generation needs an ElevenLabs key. Set{' '}
              <code className="font-mono text-[12px]">ELEVENLABS_API_KEY</code> and restart the
              controller.
            </V3Alert>
          )}
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <div className="grid gap-1.5">
              <Label>Name</Label>
              <Input
                value={sfxForm.name}
                maxLength={60}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setSfxForm(f => ({ ...f, name: e.target.value }))}
                placeholder="tape-stop"
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Duration · s</Label>
              <Input
                className="mono-num"
                type="number"
                step={0.1}
                min={0.5}
                max={22}
                value={sfxForm.durationSec}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setSfxForm(f => ({ ...f, durationSec: e.target.value }))}
                placeholder="auto"
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>Description</Label>
            <Input
              value={sfxForm.description}
              maxLength={200}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setSfxForm(f => ({ ...f, description: e.target.value }))}
              placeholder="The agent reads this to decide when the effect fits a line"
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Generation prompt</Label>
            <Textarea
              rows={3}
              value={sfxForm.prompt}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setSfxForm(f => ({ ...f, prompt: e.target.value.slice(0, 500) }))}
              placeholder="Describe the sound for ElevenLabs…"
            />
            <div className="text-right font-mono text-[11px] text-muted">{sfxForm.prompt.length} / 500</div>
          </div>
        </div>
      </Modal>

      {/* Import — bring your own audio */}
      <Modal
        open={modal === 'import'}
        onOpenChange={(o) => { if (!o) setModal(null); }}
        title="import effect"
        sub="bring your own mp3 / wav — no ElevenLabs key needed"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setModal(null)}>Cancel</Button>
            <Btn sm tone="accent" onClick={doImport} disabled={busy || !importFile || !importName.trim()}>
              {busy ? 'Importing…' : 'Import'}
            </Btn>
          </>
        }
      >
        <div className="grid gap-3.5">
          <div className="grid gap-1.5">
            <Label>Name</Label>
            <Input
              value={importName}
              maxLength={60}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setImportName(e.target.value)}
              placeholder="rain-hiss"
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Description · optional</Label>
            <Input
              value={importDesc}
              maxLength={200}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setImportDesc(e.target.value)}
              placeholder="When should the agent reach for this?"
            />
          </div>
          <input
            ref={importRef}
            type="file"
            accept="audio/*,.mp3,.wav,.ogg,.flac,.m4a,.aac,.opus"
            onChange={(e: ChangeEvent<HTMLInputElement>) => setImportFile(e.target.files?.[0] ?? null)}
            className="hidden"
          />
          <DropZone
            label={importFile ? `${importFile.name} · ${fmtSize(importFile.size)}` : 'choose a file…'}
            hint="mp3 · wav · ogg · flac · m4a · aac · opus — up to 25 MB · converted to MP3 on import"
            onClick={() => importRef.current?.click()}
          />
        </div>
      </Modal>
    </section>
  );
}

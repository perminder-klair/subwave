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
import { SkeletonCards } from '@/components/ui/skeleton';
import { Btn, Seg } from '../ui';
import { PreviewButton, type SettingsData, type SaveSettings } from '../settings/shared';
import type { BedsData, BedsForm } from './types';
import {
  SectionMasthead, PanelBox, PanelHead, EmptyState, DropZone, MetaLine, TabMetric, pad2,
} from './parts';

interface BedsSectionProps {
  bedsData: BedsData | null;
  bedsForm: BedsForm;
  setBedsForm: (updater: (f: BedsForm) => BedsForm) => void;
  busy: boolean;
  createBed: () => Promise<boolean>;
  uploadBed: (file: File, name: string, description: string) => Promise<boolean>;
  onDelete: (name: string | null) => void;
  data: SettingsData | null;
  saveSettings: SaveSettings;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
}

export function BedsSection({ bedsData, bedsForm, setBedsForm, busy, createBed, uploadBed, onDelete, data, saveSettings, adminFetch }: BedsSectionProps) {
  // Hooks must run before the early "loading…" return — keep them at the top.
  const [modal, setModal] = useState<null | 'create' | 'import'>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importName, setImportName] = useState('');
  const [importDesc, setImportDesc] = useState('');
  // In-progress edits of the numeric fields. null = show the saved value, so
  // the inputs stay controlled (an out-of-range entry snaps back on blur
  // instead of lingering in the DOM as a number that was never persisted).
  const [thresholdEdit, setThresholdEdit] = useState<string | null>(null);
  const [crossEdit, setCrossEdit] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const doImport = async () => {
    if (!importFile || !importName.trim()) return;
    const ok = await uploadBed(importFile, importName, importDesc);
    if (ok) {
      setImportFile(null);
      setImportName('');
      setImportDesc('');
      if (importRef.current) importRef.current.value = '';
      setModal(null);
    }
  };
  const doCreate = async () => {
    if (await createBed()) setModal(null);
  };

  if (!bedsData) {
    return <SkeletonCards cards={4} />;
  }
  const list = bedsData.beds || [];
  const minSec = bedsData.minDurationSec ?? 30;
  const maxGenSec = bedsData.maxGenDurationSec ?? 120;
  const ready = !!bedsData.generatorReady;
  const beds = data?.values?.beds;
  const enabled = beds?.enabled === true;
  const thresholdSec = beds?.thresholdSec ?? 12;
  const crossSec = beds?.crossSec ?? 6;

  const saveNumber = async (
    raw: string, current: number, max: number,
    patch: (v: number) => Record<string, unknown>,
    reset: (v: string | null) => void,
  ) => {
    const v = parseFloat(raw);
    if (Number.isFinite(v) && v >= 0 && v <= max && v !== current) {
      await saveSettings(patch(v)); // refreshes `data`, so clearing shows the new value
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
            <Btn sm onClick={() => setModal('import')} disabled={busy}>Import</Btn>
            <Btn sm tone="solid" onClick={() => setModal('create')} disabled={busy}>+ Create</Btn>
          </>
        }
      />

      {/* On/off */}
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
      </PanelBox>

      {enabled && list.length === 0 && (
        <V3Alert title="no beds in the library">
          Beds are on, but there’s nothing here yet — links keep playing over the incoming song
          until you add a bed at least {minSec} seconds long.
        </V3Alert>
      )}

      {/* Thresholds */}
      <PanelBox>
        <PanelHead label="when to use a bed" />
        <div className="grid grid-cols-2">
          <div className="border-r border-separator-soft p-[18px]">
            <div className="flex items-center gap-2.5">
              <span className="text-[13px] font-semibold">Bed links longer than</span>
              <Input
                className="mono-num w-[72px]"
                type="number"
                step={1}
                min={0}
                max={60}
                value={thresholdEdit ?? String(thresholdSec)}
                disabled={busy}
                aria-label="Bed threshold seconds"
                onChange={(e: ChangeEvent<HTMLInputElement>) => setThresholdEdit(e.target.value)}
                onBlur={() => {
                  if (thresholdEdit == null) return;
                  void saveNumber(thresholdEdit, thresholdSec, 60,
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
          <div className="p-[18px]">
            <div className="flex items-center gap-2.5">
              <span className="text-[13px] font-semibold">Ramp into the next song</span>
              <Input
                className="mono-num w-[72px]"
                type="number"
                step={1}
                min={0}
                max={15}
                value={crossEdit ?? String(crossSec)}
                disabled={busy}
                aria-label="Ramp seconds"
                onChange={(e: ChangeEvent<HTMLInputElement>) => setCrossEdit(e.target.value)}
                onBlur={() => {
                  if (crossEdit == null) return;
                  void saveNumber(crossEdit, crossSec, 15,
                    v => ({ beds: { crossSec: v } }), setCrossEdit);
                }}
              />
              <span className="font-mono text-[12px] text-muted">seconds</span>
            </div>
            <p className="mt-2.5 text-[12px] leading-[1.55] [text-wrap:pretty] text-muted">
              How long the next song takes to fade in under your DJ’s closing words. 0 is a hard
              cut. Saves when you click away.
            </p>
          </div>
        </div>
      </PanelBox>

      {/* Library */}
      <PanelBox>
        <PanelHead label={`bed library · ${pad2(list.length)}`} />
        {list.length === 0 ? (
          <EmptyState caption="generate one with ElevenLabs, or import an instrumental" />
        ) : (
          <div className="divide-y divide-separator-soft">
            {list.map(b => (
              <div
                key={b.name}
                className="grid grid-cols-[1fr_auto] items-center gap-[18px] px-[18px] py-[15px]"
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

      {/* Create — ElevenLabs Music API */}
      <Modal
        open={modal === 'create'}
        onOpenChange={(o) => { if (!o) setModal(null); }}
        title="create bed"
        sub="an instrumental we’ll generate with ElevenLabs"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setModal(null)}>Cancel</Button>
            <Btn
              sm
              tone="accent"
              onClick={doCreate}
              disabled={busy || !ready || !bedsForm.name.trim() || !bedsForm.prompt.trim()}
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
            <div className="grid gap-1.5">
              <Label>Name</Label>
              <Input
                value={bedsForm.name}
                maxLength={60}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setBedsForm(f => ({ ...f, name: e.target.value }))}
                placeholder="midnight-drift"
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Length · s</Label>
              <Input
                className="mono-num"
                type="number"
                step={1}
                min={minSec}
                max={maxGenSec}
                value={bedsForm.durationSec}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setBedsForm(f => ({ ...f, durationSec: e.target.value }))}
                placeholder="45"
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>Description · optional</Label>
            <Input
              value={bedsForm.description}
              maxLength={200}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setBedsForm(f => ({ ...f, description: e.target.value }))}
              placeholder="For your own reference — the DJ never reads this"
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Generation prompt</Label>
            <Textarea
              rows={3}
              value={bedsForm.prompt}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setBedsForm(f => ({ ...f, prompt: e.target.value.slice(0, 500) }))}
              placeholder="Describe the instrumental for ElevenLabs — e.g. warm lo-fi ambient pad, no drums, soft and neutral…"
            />
            <div className="text-right font-mono text-[11px] text-muted">{bedsForm.prompt.length} / 500</div>
          </div>
          <p className="m-0 text-[12px] leading-[1.55] [text-wrap:pretty] text-muted">
            Vocal-free instrumental, {minSec}–{maxGenSec}s. Each bed is trimmed to fit the link, so
            it just needs to outlast your DJ’s longest bit of chat — atmospheric and neutral works
            best.
          </p>
        </div>
      </Modal>

      {/* Import — bring your own instrumental */}
      <Modal
        open={modal === 'import'}
        onOpenChange={(o) => { if (!o) setModal(null); }}
        title="import bed"
        sub="an instrumental the DJ can talk over"
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
              placeholder="midnight-drift"
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Description · optional</Label>
            <Input
              value={importDesc}
              maxLength={200}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setImportDesc(e.target.value)}
              placeholder="For your own reference — the DJ never reads this"
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
            hint={`same formats · at least ${minSec}s · up to 25 MB · converted to MP3`}
            onClick={() => importRef.current?.click()}
          />
          <p className="m-0 text-[12px] leading-[1.55] [text-wrap:pretty] text-muted">
            Each bed is trimmed to fit the link and never loops — it only needs to outlast your
            DJ’s longest bit of chat. Atmospheric, with no strong key, works best.
          </p>
        </div>
      </Modal>
    </section>
  );
}

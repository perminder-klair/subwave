'use client';

import type { ChangeEvent } from 'react';
import { useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { fmtSize } from '../../../lib/format';
import { Modal } from '../../ui/modal';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Button } from '../../ui/button';
import { Badge } from '../../ui/badge';
import { V3Alert } from '../../ui/alert';
import { Btn, Seg } from '../ui';
import { PreviewButton, type SettingsData, type SaveSettings } from '../settings/shared';
import type { BedsData } from './types';
import {
  SectionMasthead, PanelBox, PanelHead, EmptyState, DropZone, MetaLine, TabMetric, pad2,
} from './parts';

interface BedsSectionProps {
  bedsData: BedsData | null;
  busy: boolean;
  uploadBed: (file: File, name: string, description: string) => Promise<boolean>;
  onDelete: (name: string | null) => void;
  data: SettingsData | null;
  saveSettings: SaveSettings;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
}

export function BedsSection({ bedsData, busy, uploadBed, onDelete, data, saveSettings, adminFetch }: BedsSectionProps) {
  // Hooks must run before the early "loading…" return — keep them at the top.
  const [modal, setModal] = useState(false);
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
      setModal(false);
    }
  };

  if (!bedsData) {
    return <div className="text-[13px] text-muted italic">loading…</div>;
  }
  const list = bedsData.beds || [];
  const minSec = bedsData.minDurationSec ?? 30;
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
        sub="Instrumentals the DJ talks over between songs: the song ends, the bed carries the talk, and the next song ramps in under the DJ’s closing words."
        metrics={<TabMetric accent n={pad2(list.length)} l="beds" />}
        actions={<Btn sm onClick={() => setModal(true)} disabled={busy}>Import</Btn>}
      />

      {/* On/off */}
      <PanelBox>
        <div className="flex flex-wrap items-center justify-between gap-5 px-[18px] py-[16px]">
          <div className="min-w-[240px] flex-1">
            <div className="font-mono text-[10px] font-bold tracking-[0.2em] uppercase">talk beds</div>
            <p className="mt-1.5 text-[12px] leading-[1.55] text-muted">
              {enabled
                ? 'Long links get their own instrumental. Needs at least one bed long enough to carry a script.'
                : 'Off — every link is talked over the incoming song, as before. The library is kept.'}
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
          Beds are on, but the library is empty — links fall back to talking over the incoming
          song until you import a bed at least {minSec} seconds long.
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
              Links above this length get their own bed. Where the analyzer has measured a track’s
              vocals, that measurement wins — a bed exactly when the DJ would otherwise talk over
              singing; instrumentals never get one. Saves on blur.
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
              Crossfade for the next song to fade in under the DJ’s closing words. 0 is a hard cut.
              Saves on blur.
            </p>
          </div>
        </div>
      </PanelBox>

      {/* Library */}
      <PanelBox>
        <PanelHead label={`bed library · ${pad2(list.length)}`} />
        {list.length === 0 ? (
          <EmptyState caption="beds can’t be generated — import an instrumental" />
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
                    {b.source === 'bundled' && <Badge variant="solid">bundled</Badge>}
                    {b.source === 'upload' && <Badge variant="ink">uploaded</Badge>}
                  </MetaLine>
                </div>
                <div className="flex flex-none items-center gap-2">
                  <PreviewButton
                    path={`/beds/${encodeURIComponent(b.name)}/audio`}
                    adminFetch={adminFetch}
                  />
                  <span title="Delete this bed">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Delete bed"
                      disabled={busy}
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

      {/* Import — bring your own instrumental */}
      <Modal
        open={modal}
        onOpenChange={(o) => { if (!o) setModal(false); }}
        title="import bed"
        sub="an instrumental the DJ can talk over"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setModal(false)}>Cancel</Button>
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
            A bed is trimmed per link and never looped — it only needs to outlast the DJ’s longest
            script. Atmospheric, no strong key travels best.
          </p>
        </div>
      </Modal>
    </section>
  );
}

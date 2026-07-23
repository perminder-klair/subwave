'use client';

import type { ChangeEvent } from 'react';
import { useRef, useState } from 'react';
import { fmtSize } from '../../../lib/format';
import { Modal } from '../../ui/modal';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Card, Btn, Pill, Seg } from '../ui';
import { SectionHeader, PreviewButton, type SettingsData, type SaveSettings } from '../settings/shared';
import type { BedsData } from './types';

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
    <>
      <SectionHeader
        eyebrow="beds"
        title="An instrumental bed for the DJ to talk over between songs."
        sub="Normally a link is talked over the song it's introducing, so every second of DJ costs a second of music. With beds on, a long link gets its own instrumental bed instead: the song ends, the bed carries the talk, and the next song ramps in under the DJ's closing words."
        metrics={[{ n: String(list.length), l: 'beds', accent: true }]}
      />

      <Card title="Beds" sub="whether long links get a bed of their own">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[13px] font-bold">Enable beds</div>
            <div className="mt-0.5 max-w-[480px] text-[11px] leading-[1.5] text-muted">
              When off, every link is talked over the incoming song, exactly as before. The
              library below is kept either way. Needs at least one bed long enough to carry a
              script.
            </div>
          </div>
          <Seg
            accent
            value={enabled ? 'on' : 'off'}
            options={[
              { id: 'off', label: 'Off' },
              { id: 'on', label: 'On' },
            ]}
            onChange={v => { if (!busy) saveSettings({ beds: { enabled: v === 'on' } }); }}
          />
        </div>
      </Card>

      {enabled && list.length === 0 && (
        <div className="card">
          <div className="card-body text-[12px] leading-[1.5] text-muted">
            <strong className="tracking-[0.12em] text-ink uppercase">No beds in the library</strong>
            <div className="mt-1">
              Beds are on, but there's nothing to play. Every link will be talked over its song
              as usual until you add a bed of at least {minSec}s.
            </div>
          </div>
        </div>
      )}

      <Card title="When to use a bed" sub="how long a link has to run before it gets its own bed">
        <div className="flex items-start justify-between gap-4">
          <div className="max-w-[480px]">
            <div className="text-[13px] font-bold">Bed links longer than</div>
            <div className="mt-0.5 text-[11px] leading-[1.5] text-muted">
              Where the analyzer has measured a track's vocals, that's used instead: the DJ gets
              a bed exactly when it would otherwise talk over the singing, and instrumentals
              never get one. This threshold covers everything else. Lower it and more links get
              a bed; a bed on <em>every</em> link is a distinctive sound, and not everyone's.
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Input
              className="mono-num w-20"
              type="number"
              step={1}
              min={0}
              max={60}
              value={thresholdEdit ?? String(thresholdSec)}
              disabled={busy}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setThresholdEdit(e.target.value)}
              onBlur={() => {
                if (thresholdEdit == null) return;
                void saveNumber(thresholdEdit, thresholdSec, 60,
                  v => ({ beds: { thresholdSec: v } }), setThresholdEdit);
              }}
            />
            <span className="text-[12px] text-muted">sec</span>
          </div>
        </div>
        <div className="mt-4 flex items-start justify-between gap-4 border-t border-dashed border-separator-strong pt-4">
          <div className="max-w-[480px]">
            <div className="text-[13px] font-bold">Ramp into the next song</div>
            <div className="mt-0.5 text-[11px] leading-[1.5] text-muted">
              How long the next song takes to fade in under the DJ's closing words at the end
              of the bed. Longer is smoother; shorter is punchier. 0 is a hard cut.
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Input
              className="mono-num w-20"
              type="number"
              step={1}
              min={0}
              max={15}
              value={crossEdit ?? String(crossSec)}
              disabled={busy}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setCrossEdit(e.target.value)}
              onBlur={() => {
                if (crossEdit == null) return;
                void saveNumber(crossEdit, crossSec, 15,
                  v => ({ beds: { crossSec: v } }), setCrossEdit);
              }}
            />
            <span className="text-[12px] text-muted">sec</span>
          </div>
        </div>
      </Card>

      <Card
        title="Bed library"
        sub={`${list.length} bed${list.length === 1 ? '' : 's'}`}
        right={
          <Btn sm tone="accent" onClick={() => setModal(true)} disabled={busy}>
            Import
          </Btn>
        }
      >
        {list.length === 0 && (
          <div className="py-2 text-[12px] text-muted italic">none yet</div>
        )}
        {list.map(b => (
          <div
            key={b.name}
            className="flex items-start gap-3 border-b border-dashed border-separator-strong py-3"
          >
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-bold text-ink">{b.name}</div>
              {b.description && (
                <div className="mt-0.5 text-[12px] break-words text-muted">{b.description}</div>
              )}
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className="caption">{fmtSize(b.size)}</span>
                {b.durationSec != null && <span className="caption">{Math.round(b.durationSec)}s</span>}
                {b.source === 'bundled' && <Pill tone="accent">bundled</Pill>}
                {b.source === 'upload' && <Pill tone="ink">uploaded</Pill>}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <PreviewButton
                path={`/beds/${encodeURIComponent(b.name)}/audio`}
                adminFetch={adminFetch}
              />
              <Btn
                sm
                tone="danger"
                onClick={() => onDelete(b.name)}
                disabled={busy}
                title="Delete this bed"
              >
                Delete
              </Btn>
            </div>
          </div>
        ))}
      </Card>

      <Modal
        open={modal}
        onOpenChange={(o) => { if (!o) setModal(false); }}
        title="Import bed"
        sub="an instrumental the DJ can talk over"
        footer={
          <>
            <Btn onClick={() => setModal(false)}>Cancel</Btn>
            <Btn
              tone="accent"
              onClick={doImport}
              disabled={busy || !importFile || !importName.trim()}
            >
              {busy ? 'Importing…' : 'Import bed'}
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
            placeholder="e.g. warm-pad"
            className="max-w-[280px]"
          />
          <div className="field-hint">A short slug: letters, numbers and dashes.</div>
        </div>
        <div className="field mt-3.5">
          <Label>Description</Label>
          <Input
            value={importDesc}
            maxLength={200}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setImportDesc(e.target.value)}
            placeholder="what this bed sounds like"
          />
          <div className="field-hint">For your own reference — the DJ never reads this.</div>
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
          <div className="field-hint">
            mp3, wav, ogg, flac, m4a, aac or opus · at least {minSec}s · up to 25 MB · converted to
            MP3 on import
          </div>
        </div>
        <div className="field-hint mt-3.5">
          A bed is trimmed to each link, never looped, so it only has to be <em>longer</em> than
          the DJ's longest script. Something atmospheric with no strong key travels best — it has
          to sit under whatever song comes next.
        </div>
      </Modal>
    </>
  );
}

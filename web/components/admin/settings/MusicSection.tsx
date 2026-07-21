'use client';

import { useState } from 'react';
import { Label } from '../../ui/label';
import { Card, Btn, Pill } from '../ui';
import { cn } from '../../../lib/cn';
import { RefreshCw } from 'lucide-react';
import { SourceSelector } from '../music/SourceSelector';
import { SOURCE_META } from '../music/sourceMeta';
import {
  SectionHeader, SaveBar,
  type SectionProps,
} from './shared';

interface MusicSectionProps extends SectionProps {
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  refresh: () => void;
}
export function MusicSection({ data, form, setForm, busy, saveSettings, adminFetch, refresh }: MusicSectionProps) {
  const [rescanning, setRescanning] = useState(false);
  const sources = data.music?.sources || ['subsonic'];
  const active = data.music?.active || 'subsonic';
  const savedSource = data.values?.music?.source ?? 'subsonic';
  const dirty = form.music.source !== savedSource;
  const local = data.music?.local;
  const scanning = local?.state === 'scanning';

  const save = () => saveSettings({ music: { source: form.music.source } });

  const rescan = async () => {
    setRescanning(true);
    try {
      const r = await adminFetch('/library/local/rescan', { method: 'POST' });
      if (r.ok) refresh();
    } finally {
      setRescanning(false);
    }
  };

  return (
    <>
      <SectionHeader
        eyebrow="music source"
        title="Where SUB/WAVE gets its music."
        sub="One active source at a time. Navidrome/Subsonic is a streaming server on your network; the local folder plays audio files sitting on this box, no server needed. Switching reroutes track selection on save."
        metrics={[{ n: String(sources.length), l: 'sources' }]}
      />

      <Card title="Source" sub="active backend">
        <div className="grid gap-[18px]">
          <div className="flex items-start gap-2.5 border border-[var(--accent)] bg-[var(--ink-softer)] p-3">
            <span className="mt-1 size-1.5 flex-none rounded-full bg-vermilion" />
            <div className="grid min-w-0 gap-0.5">
              <span className="text-[11px] font-bold tracking-[0.12em] text-vermilion uppercase">
                Playing from · {SOURCE_META[active]?.label || active}
              </span>
              <span className="text-[11px] leading-[1.5] text-muted">
                {dirty
                  ? 'Source changed. Save below to reroute selection and rebuild the fallback playlist.'
                  : 'This is the saved, running source.'}
              </span>
            </div>
          </div>

          <div className="field">
            <div className="flex items-center gap-2">
              <Label>Source</Label>
              {dirty && <Pill tone="accent" dot>unsaved</Pill>}
            </div>
            <SourceSelector
              value={form.music.source}
              sourceIds={sources}
              onChange={(id) => setForm(f => ({ ...f, music: { ...f.music, source: id } }))}
            />
            <div className="field-hint">
              Navidrome creds are set during onboarding / in the root <code>.env</code>. The local
              folder defaults to <code>state/music</code> — drop files there and Rescan.
            </div>
          </div>
        </div>
      </Card>

      {form.music.source === 'local' && (
        <Card title="Local folder" sub="scan status">
          <div className="grid gap-[14px]">
            <div className="grid gap-1 text-[12px] leading-[1.6]">
              <div><span className="text-muted">Folder</span> <code>{local?.root || 'state/music'}</code></div>
              <div>
                <span className="text-muted">Indexed</span>{' '}
                <strong>{local?.trackCount ?? 0}</strong> track{(local?.trackCount ?? 0) === 1 ? '' : 's'}
                {typeof local?.failed === 'number' && local.failed > 0 && (
                  <span className="text-muted"> · {local.failed} unreadable</span>
                )}
              </div>
              <div>
                <span className="text-muted">Last scan</span>{' '}
                {scanning
                  ? <span className="text-vermilion">scanning…</span>
                  : local?.lastScanAt
                    ? new Date(local.lastScanAt).toLocaleString()
                    : 'never'}
              </div>
              {local?.lastError && (
                <div className="text-vermilion">Error: {local.lastError}</div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Btn onClick={rescan} disabled={rescanning || scanning}>
                <RefreshCw className={cn('mr-1.5 size-3.5', (rescanning || scanning) && 'animate-spin')} />
                {rescanning || scanning ? 'Scanning…' : 'Rescan'}
              </Btn>
              <span className="text-[11px] text-muted">
                Re-reads the folder. Unchanged files are skipped, so this is quick.
              </span>
            </div>
          </div>
        </Card>
      )}

      <SaveBar
        note={`Active source: ${SOURCE_META[active]?.label || active}. Applies to the next pick, no restart needed.`}
        busy={busy}
        onSave={save}
        saveLabel="Save music source"
      />
    </>
  );
}

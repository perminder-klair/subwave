'use client';

// The listener Lyrics panel's switch, as a part of the Listeners tab
// (ListenersSection): a card, a header metric and the save payload.

import { Label } from '../../ui/label';
import { Card, Pill, Seg } from '../ui';
import type { LyricsForm, SectionProps, SettingsData } from './shared';

type LyricsPartProps = Pick<SectionProps, 'data' | 'form' | 'setForm'>;

export function lyricsMetrics(data: SettingsData) {
  const on = data.values?.lyrics?.enabled === true;
  return [{ n: on ? 'on' : 'off', l: 'lyrics panel', accent: on }];
}

export function lyricsSavePayload(ly: LyricsForm) {
  return { lyrics: { enabled: ly.enabled, lrclib: ly.lrclib } };
}

export function LyricsCard({ data, form, setForm }: LyricsPartProps) {
  const ly = form.lyrics;
  const saved = data.values?.lyrics?.enabled === true;
  const savedLrclib = data.values?.lyrics?.lrclib === true;
  return (
    <Card title="Lyrics panel" sub="time-synced lyrics beside the song, on the Classic skin">
      <div className="grid gap-[18px]">
        <div className="field">
          <div className="flex items-center gap-2">
            <Label>Enabled</Label>
            {ly.enabled !== saved && <Pill tone="accent" dot>unsaved</Pill>}
          </div>
          <Seg
            aria-label="Lyrics panel"
            value={ly.enabled ? 'on' : 'off'}
            onChange={v => setForm(f => ({ ...f, lyrics: { ...f.lyrics, enabled: v === 'on' } }))}
            options={[{ id: 'off', label: 'Off' }, { id: 'on', label: 'On' }]}
          />
          <div className="field-hint">
            Shows the playing song&apos;s lyrics from your music server, highlighting each line
            as it is sung. Off hides the panel and refuses <code>GET /lyrics/current</code>. On
            republishes the lyric text to anyone who can open the player, and each track a
            listener opens costs one lyrics lookup on your music server (cached briefly). If a
            track&apos;s lyrics run early or late, open the panel in a browser signed in here and
            fix that track for every listener from its timing controls.
          </div>
        </div>
        <div className="field">
          <div className="flex items-center gap-2">
            <Label>LRCLIB fallback</Label>
            {ly.lrclib !== savedLrclib && <Pill tone="accent" dot>unsaved</Pill>}
          </div>
          <Seg
            aria-label="LRCLIB fallback"
            value={ly.lrclib ? 'on' : 'off'}
            onChange={v => setForm(f => ({ ...f, lyrics: { ...f.lyrics, lrclib: v === 'on' } }))}
            options={[{ id: 'off', label: 'Off' }, { id: 'on', label: 'On' }]}
          />
          <div className="field-hint">
            When your music server has no timed lyrics for a track, look it up on{' '}
            <a href="https://lrclib.net" target="_blank" rel="noreferrer" className="underline">LRCLIB</a>, a community
            database of synced lyrics, as the track goes on air. On sends that track&apos;s artist,
            title, album and length to lrclib.net (or to <code>LRCLIB_URL</code>, for a self-hosted
            instance). Only a file within 2 seconds of the track&apos;s length is used, each answer
            is remembered, and your music server&apos;s own timed lyrics always win. Works only
            while the panel is on, and never feeds the DJ&apos;s vocal timing.
          </div>
        </div>
      </div>
    </Card>
  );
}

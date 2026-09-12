'use client';

import { Btn, Card } from '../ui';
import { SectionHeader, type SaveSettings, type SettingsData } from './shared';
import { NavidromeSection } from './NavidromeSection';
import { SpotifySection } from './SpotifySection';

// The "Music source" section: pick the active MusicSource (settings.music.source),
// then that source's own connection panel. Mirrors upstream #843's MusicSection
// so a later merge lands as near-duplicate hunks.
interface MusicSectionProps {
  data: SettingsData;
  busy: boolean;
  saveSettings: SaveSettings;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  refresh: () => void;
}

const SOURCES: Array<{ id: string; label: string; blurb: string }> = [
  { id: 'subsonic', label: 'Navidrome / Subsonic', blurb: 'Your own server, full analysis, the default.' },
  { id: 'spotify', label: 'Spotify', blurb: 'Web API catalog + a Spotify Connect receiver in the broadcast container. Premium required.' },
];

export function MusicSection({ data, busy, saveSettings, adminFetch, refresh }: MusicSectionProps) {
  const active = data.values?.music?.source ?? 'subsonic';
  return (
    <>
      <SectionHeader
        eyebrow="music source"
        title="Where the music comes from."
        sub={<>
          One active source at a time. Every track pick, cover and library lookup
          goes through it; the DJ&apos;s discovery tools adapt to what the source can
          serve. Switching sources changes how the mixer receives audio, so it
          needs a mixer restart — and each source keeps its own library database,
          so a switch is best done on a fresh station profile.
        </>}
      />
      <Card title="Active source">
        <div className="grid gap-3 md:grid-cols-2">
          {SOURCES.map((s) => (
            <button
              key={s.id}
              type="button"
              disabled={busy}
              onClick={() => { if (s.id !== active) saveSettings({ music: { source: s.id } }); }}
              className={`rounded-md border p-3 text-left transition ${s.id === active ? 'border-vermilion bg-vermilion/10' : 'border-ink hover:bg-ink/5'}`}
              aria-pressed={s.id === active}
            >
              <div className="font-medium">{s.label}</div>
              <div className="text-sm opacity-80">{s.blurb}</div>
            </button>
          ))}
        </div>
        {active !== 'subsonic' ? (
          <div className="field-hint mt-3">
            Spotify is <b>experimental</b>. Features that need the audio file (acoustic analysis, silence trim,
            stem blends, measured loudness) are unavailable; text tagging, requests, jingles and DJ talk work as usual.
            <Btn sm className="ml-2" onClick={() => saveSettings({ music: { source: 'subsonic' } })} disabled={busy}>Back to Navidrome</Btn>
          </div>
        ) : null}
      </Card>
      {active === 'spotify'
        ? <SpotifySection data={data} busy={busy} saveSettings={saveSettings} adminFetch={adminFetch} refresh={refresh} />
        : <NavidromeSection data={data} adminFetch={adminFetch} refresh={refresh} />}
    </>
  );
}

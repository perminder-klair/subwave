'use client';

import { Advanced } from './section-chrome';
import { SectionHeader, SaveBar, type SectionProps } from './shared';
import { LikesHeartCard, LikesInfluenceCard, likesMetrics, likesSavePayload } from './LikesSection';
import { LyricsCard, lyricsMetrics, lyricsSavePayload } from './LyricsSection';
import { ScrobbleCards, scrobbleReadiness } from './ScrobbleSection';

interface ListenersSectionProps extends SectionProps {
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  refresh: () => void;
}

/**
 * What listeners leave behind: hearts (and whether they steer the DJ) and the
 * station-wide scrobbles. Used to be two tabs, Likes and Scrobbling.
 */
export function ListenersSection(props: ListenersSectionProps) {
  const { data, form, busy, saveSettings, fieldErrors } = props;
  const { lfReady, lbReady, ndReady } = scrobbleReadiness(form, data);

  return (
    <>
      <SectionHeader
        eyebrow="listeners"
        title="Hearts and scrobbles: what listeners leave behind."
        sub={<>
          One tap on the player hearts the track on air: it lands in Library → Tracks → Liked,
          optionally as a Navidrome star, and optionally as a taste signal for the DJ. No listener
          accounts, and the raw IP is never stored. Scrobbling reports what the station airs to
          Last.fm, ListenBrainz and your own Navidrome; each backend is independent. The Lyrics
          panel is the one thing here that flows the other way: the song&apos;s words, shown to them.
        </>}
        metrics={[
          ...likesMetrics(data),
          ...lyricsMetrics(data),
          { n: lfReady ? 'on' : 'off', l: 'last.fm', accent: lfReady },
          { n: lbReady ? 'on' : 'off', l: 'listenbrainz', accent: lbReady },
          { n: ndReady ? 'on' : 'off', l: 'navidrome', accent: ndReady },
        ]}
      />

      <LikesHeartCard {...props} />
      <LyricsCard {...props} />
      <ScrobbleCards {...props} />

      <Advanced note="how listener taste feeds back into track selection">
        <LikesInfluenceCard {...props} />
      </Advanced>

      <SaveBar
        note="Likes apply from the next pick and the Lyrics panel from the next poll, no restart needed."
        busy={busy}
        onSave={() => saveSettings({ ...likesSavePayload(form.likes), ...lyricsSavePayload(form.lyrics) })}
        saveLabel="Save likes & lyrics"
        errors={fieldErrors}
        ownedKeys={['likes', 'lyrics']}
      />
    </>
  );
}

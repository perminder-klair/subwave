// Google Cast media loading — the remote-playback analog of audio/player.ts.
//
// Cast is NOT audio routing (that's AirPlay): the Cast device fetches the
// stream URL itself and the phone becomes a remote control — local RNTP
// playback is torn down while a session is active (see hooks/useCast.ts).
// The Default Media Receiver (CC1AD845, the plugin default) plays the live
// MP3 mount directly, so no receiver registration is needed.
//
// Metadata is set ONCE at load: per-track updates on the Default Receiver
// would mean reloading media (an audible gap on a live stream), so the
// TV/speaker shows static station branding. A custom web receiver that polls
// /api/now-playing is the planned phase-3 upgrade.

import { MediaStreamType, type RemoteMediaClient } from 'react-native-google-cast';

export interface CastStreamMeta {
  /** Credential-free live MP3 mount (api.streamUrl()). Deliberately NOT
   *  cache-busted: Icecast always serves the live edge to a new client, and a
   *  stable URL lets useCast recognise (and adopt) an already-running session
   *  after an app restart. */
  url: string;
  stationName?: string;
  djName?: string;
  artworkUrl?: string | null;
}

export async function loadLiveStream(
  client: RemoteMediaClient,
  meta: CastStreamMeta,
): Promise<void> {
  await client.loadMedia({
    autoplay: true,
    mediaInfo: {
      contentUrl: meta.url,
      contentType: 'audio/mpeg',
      streamType: MediaStreamType.LIVE,
      metadata: {
        type: 'musicTrack',
        title: meta.stationName || 'SUB/WAVE',
        artist: meta.djName ? `${meta.djName} · live broadcast` : 'Live broadcast',
        images: meta.artworkUrl ? [{ url: meta.artworkUrl }] : undefined,
      },
    },
  });
}

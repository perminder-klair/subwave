// Cast fetches the MP3 stream itself while local playback is torn down.
// Updating Default Receiver metadata requires a reload and causes an audible gap.

import { MediaStreamType, type RemoteMediaClient } from 'react-native-google-cast';

export interface CastStreamMeta {
  /** Credential-free live MP3 mount. Deliberately NOT cache-busted: a stable
   *  URL lets useCast adopt an already-running session after an app restart,
   *  and Icecast serves the live edge to a new client anyway. */
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

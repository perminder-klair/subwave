// Google Cast controller — a thin wrapper over react-native-google-cast's hooks.
//
// Why this exists: SUB/WAVE streams plain MP3, and Google Home / Nest are
// Cast-for-Audio receivers, so casting is just "hand the receiver the
// /stream.mp3 URL + now-playing metadata and let it pull the stream itself."
// The phone becomes a remote the listener can walk away from (unlike Bluetooth,
// which tethers the phone and hijacks all of its audio).
//
// The native `CastButton` (see TopBar) owns the device-picker UI and the whole
// session lifecycle. This hook only surfaces session state and the two actions
// the app drives imperatively: load the live stream onto a freshly-connected
// receiver, and end the session. The Cast context itself is initialised
// natively by the Expo config plugin (receiverAppId in app.json) — there is no
// JS provider to mount.
//
// SPIKE NOTE: this is the Phase-0 validation surface. Local⇄cast playback
// arbitration (pausing RNTP while casting) lands in Phase 1 via usePlayer.

import { useCallback } from 'react';
import CastContext, {
  MediaStreamType,
  useCastDevice,
  useCastSession,
  useRemoteMediaClient,
} from 'react-native-google-cast';

export interface CastMeta {
  title?: string;
  artist?: string;
  album?: string;
  artwork?: string;
}

export interface CastController {
  /** True while a Cast session is connected to a receiver. */
  casting: boolean;
  /** True once the receiver's media client is ready to accept loadMedia(). */
  ready: boolean;
  /** Friendly name of the connected device (e.g. "Kitchen speaker"), or null. */
  deviceName: string | null;
  /** Hand the receiver the live MP3 URL + now-playing metadata. */
  castLoad: (streamUrl: string, meta?: CastMeta) => void;
  /** End the Cast session (stops playback on the receiver). */
  castStop: () => void;
}

export function useCast(): CastController {
  const session = useCastSession();
  const device = useCastDevice();
  // null until a session is connected and the receiver's media channel is live.
  const client = useRemoteMediaClient();

  const castLoad = useCallback(
    (streamUrl: string, meta?: CastMeta) => {
      if (!client) return;
      client
        .loadMedia({
          autoplay: true,
          mediaInfo: {
            contentUrl: streamUrl,
            contentType: 'audio/mpeg',
            // LIVE → the receiver hides the seek bar (mirrors isLiveStream on
            // the RNTP side); there's no scrubbing a continuous broadcast.
            streamType: MediaStreamType.LIVE,
            metadata: {
              type: 'musicTrack',
              title: meta?.title || 'SUB/WAVE',
              artist: meta?.artist,
              albumTitle: meta?.album,
              images: meta?.artwork ? [{ url: meta.artwork }] : undefined,
            },
          },
        })
        .catch(() => {});
    },
    [client],
  );

  const castStop = useCallback(() => {
    // endCurrentSession(stopCasting=true) stops receiver playback as it
    // disconnects, rather than leaving the speaker playing orphaned.
    CastContext.getSessionManager()
      .endCurrentSession(true)
      .catch(() => {});
  }, []);

  return {
    casting: !!session,
    ready: !!client,
    deviceName: device?.friendlyName ?? null,
    castLoad,
    castStop,
  };
}

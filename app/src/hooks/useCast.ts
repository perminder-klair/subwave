// Google Cast session state, merged over the local player.
//
// Returns a Player facade: with no Cast session it IS the local RNTP-backed
// player, untouched; while a session is connected, tune/stop/volume/status
// re-target the Cast device (the Cast device fetches the stream itself, so
// local playback stays torn down — a battery win for hours-long listening).
// Handoff is bidirectional: connecting mid-listen moves the audio to the Cast
// device; disconnecting while remote-tuned brings it back locally.
//
// Stations whose stream needs an Authorization header (#764 basic-auth bases)
// can't cast — the Cast device fetches the URL itself and the header doesn't
// ride along — so `castable` is false for them and the facade stays local
// (TopBar also hides the cast button off `cast.available`).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MediaPlayerState,
  useCastDevice,
  useCastSession,
  useCastState,
  useMediaStatus,
  useRemoteMediaClient,
  type RemoteMediaClient,
} from 'react-native-google-cast';
import { loadLiveStream } from '@/cast/castPlayer';
import type { Player, PlayerStatus } from '@/hooks/usePlayer';
import type { StationApi } from '@/lib/api';

export interface CastMeta {
  stationName?: string;
  djName?: string;
  artworkUrl?: string | null;
}

export interface CastInfo {
  /** Show the cast button? True when the station is castable (no basic-auth
   *  stream) and the Cast framework exists on this device (castState is null
   *  on Android without Play Services). */
  available: boolean;
  /** A session is active and the facade is remote. */
  connected: boolean;
  deviceName: string | null;
}

export function useCast(
  api: StationApi | null,
  local: Player,
  meta: CastMeta,
): { player: Player; cast: CastInfo } {
  const castState = useCastState();
  const session = useCastSession();
  const client = useRemoteMediaClient();
  const device = useCastDevice();
  const mediaStatus = useMediaStatus();

  const castable = !!api && !api.streamHeaders();
  const connected = castable && !!session && !!client;

  // Remote-playback intent — the cast-side analog of usePlayer's tunedIn.
  const [castTunedIn, setCastTunedIn] = useState(false);
  const [castVolume, setCastVolume] = useState(1);
  const preMuteVolume = useRef(1);

  // Refs for callbacks/effects that must see current values without re-binding.
  const castTunedInRef = useRef(castTunedIn);
  useEffect(() => { castTunedInRef.current = castTunedIn; }, [castTunedIn]);
  const apiRef = useRef(api);
  useEffect(() => { apiRef.current = api; }, [api]);
  const localRef = useRef(local);
  useEffect(() => { localRef.current = local; }, [local]);
  const metaRef = useRef(meta);
  useEffect(() => { metaRef.current = meta; }, [meta]);

  const loadToCast = useCallback(async (c: RemoteMediaClient) => {
    const a = apiRef.current;
    if (!a) return;
    // Optimistic: the facade's tunedIn must not blip false during handoff
    // (PlayerScreen disarms the sleep timer on a true→false transition).
    setCastTunedIn(true);
    try {
      await loadLiveStream(c, { url: a.streamUrl(), ...metaRef.current });
    } catch {
      setCastTunedIn(false);
    }
  }, []);

  // Session connect/disconnect — the handoff in both directions.
  const prevClientRef = useRef<RemoteMediaClient | null>(null);
  useEffect(() => {
    const prev = prevClientRef.current;
    prevClientRef.current = client;
    if (!prev && client) {
      // Connected. Seed the knob from the device's real volume, and move the
      // audio over if the listener was already tuned in locally.
      session?.getVolume().then((v) => {
        if (typeof v === 'number' && Number.isFinite(v)) {
          setCastVolume(Math.max(0, Math.min(1, v)));
        }
      }).catch(() => {});
      if (castable && localRef.current.tunedIn) {
        localRef.current.stop();
        void loadToCast(client);
      }
    } else if (prev && !client) {
      // Disconnected — resume locally if we were remote-tuned.
      const wasTuned = castTunedInRef.current;
      setCastTunedIn(false);
      if (wasTuned) localRef.current.tune();
    }
  }, [client, castable, session, loadToCast]);

  // Adopt an already-running session (app restart while the speaker plays):
  // if the receiver is playing OUR stream and we don't think we're tuned in,
  // sync up instead of showing a dark power ring over live audio.
  useEffect(() => {
    if (!connected || castTunedInRef.current) return;
    const a = apiRef.current;
    if (!a) return;
    const url = mediaStatus?.mediaInfo?.contentUrl;
    const ps = mediaStatus?.playerState;
    if (
      url && url.startsWith(a.streamUrl()) &&
      (ps === MediaPlayerState.PLAYING || ps === MediaPlayerState.BUFFERING || ps === MediaPlayerState.LOADING)
    ) {
      setCastTunedIn(true);
    }
  }, [connected, mediaStatus]);

  // The receiver went idle for a terminal reason (stream error, another sender
  // loaded other media, …) — reflect tuned-out rather than spinning forever.
  // idleReason is undefined outside a terminal idle (e.g. while loading).
  useEffect(() => {
    if (!castTunedIn) return;
    if (mediaStatus?.playerState === MediaPlayerState.IDLE && mediaStatus.idleReason) {
      setCastTunedIn(false);
    }
  }, [mediaStatus, castTunedIn]);

  // Station switch while casting: match the local player's behaviour (playback
  // stops on a base change; the listener re-tunes on the new station).
  const prevBaseRef = useRef(api?.base ?? null);
  useEffect(() => {
    const next = api?.base ?? null;
    if (prevBaseRef.current === next) return;
    prevBaseRef.current = next;
    if (castTunedInRef.current) {
      client?.stop().catch(() => {});
      setCastTunedIn(false);
    }
  }, [api, client]);

  const castTune = useCallback(() => {
    if (castTunedInRef.current) {
      client?.stop().catch(() => {});
      setCastTunedIn(false);
      return;
    }
    if (client) void loadToCast(client);
  }, [client, loadToCast]);

  const castStop = useCallback(() => {
    client?.stop().catch(() => {});
    setCastTunedIn(false);
  }, [client]);

  const castSetVolume = useCallback(
    (v: number) => {
      const clamped = Math.max(0, Math.min(1, v));
      setCastVolume(clamped);
      try {
        session?.setVolume(clamped);
      } catch {
        /* device may reject volume control (fixed-volume sinks) */
      }
    },
    [session],
  );

  // Functional updater, like usePlayer.toggleMute — TransportBar's knob
  // handler calls setVolume then toggleMute in one gesture, and the updater
  // must see the just-queued value, not this render's.
  const castToggleMute = useCallback(() => {
    setCastVolume((v) => {
      const next = v > 0 ? 0 : preMuteVolume.current || 1;
      if (v > 0) preMuteVolume.current = v;
      try {
        session?.setVolume(next);
      } catch {
        /* fixed-volume sink */
      }
      return next;
    });
  }, [session]);

  // Status from the receiver's player state. `paused` maps to playing-side:
  // the listener is still tuned (volume/stop work); a live mount has no
  // meaningful pause and the only way into it is another sender's controls.
  let castStatus: PlayerStatus = 'idle';
  if (castTunedIn) {
    const ps = mediaStatus?.playerState;
    castStatus =
      ps === MediaPlayerState.PLAYING || ps === MediaPlayerState.PAUSED
        ? 'playing'
        : 'connecting';
  }

  // `castTunedIn || local.tunedIn` keeps the facade's tunedIn continuously
  // true across the connect handoff (local flips false as cast flips true).
  const player: Player = useMemo(
    () =>
      connected
        ? {
            tunedIn: castTunedIn || local.tunedIn,
            status: castStatus,
            volume: castVolume,
            setVolume: castSetVolume,
            tune: castTune,
            stop: castStop,
            toggleMute: castToggleMute,
            muted: castVolume === 0,
          }
        : local,
    [connected, castTunedIn, castStatus, castVolume, castSetVolume, castTune, castStop, castToggleMute, local],
  );

  return {
    player,
    cast: {
      available: castable && castState != null,
      connected,
      deviceName: connected ? device?.friendlyName ?? null : null,
    },
  };
}

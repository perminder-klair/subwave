'use client';

import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';

// We pick MP3 vs Ogg-Opus on the client via canPlayType — Opus is roughly
// equal-or-better quality at half the bandwidth on browsers that decode it.
//
// `NEXT_PUBLIC_STREAM_URL` is the build-time host override (dev points the
// player at `http://localhost:7702/stream.mp3` because Icecast isn't on the
// web origin there). It used to pin a single URL; now it pins the *host* and
// we swap the path between `/stream.mp3` and `/stream.opus` on the same host.
// Operators who pointed it at a non-standard URL that doesn't end in
// `/stream.mp3` still get it verbatim (opus is null → codec detection off).
const STREAM_URL_OVERRIDE = process.env.NEXT_PUBLIC_STREAM_URL || '';
const MP3_PATH = '/stream.mp3';
const OPUS_PATH = '/stream.opus';

function resolveStreamUrls(): { mp3: string; opus: string | null } {
  if (!STREAM_URL_OVERRIDE) return { mp3: MP3_PATH, opus: OPUS_PATH };
  const idx = STREAM_URL_OVERRIDE.lastIndexOf(MP3_PATH);
  if (idx === -1) return { mp3: STREAM_URL_OVERRIDE, opus: null };
  const before = STREAM_URL_OVERRIDE.slice(0, idx);
  const after = STREAM_URL_OVERRIDE.slice(idx + MP3_PATH.length);
  return { mp3: STREAM_URL_OVERRIDE, opus: `${before}${OPUS_PATH}${after}` };
}

const { mp3: MP3_STREAM_URL, opus: OPUS_STREAM_URL } = resolveStreamUrls();

export type PlayerStatus = 'idle' | 'connecting' | 'playing';

export interface Player {
  audioRef: RefObject<HTMLAudioElement | null>;
  tunedIn: boolean;
  status: PlayerStatus;
  volume: number;
  setVolume: Dispatch<SetStateAction<number>>;
  tune: () => void;
  stop: () => void;
  toggleMute: () => void;
  muted: boolean;
}

export interface UsePlayerOptions {
  initialVolume?: number;
}

// Owns the <audio> element + tune-in state. The audioRef must be attached to
// an <audio> tag rendered by the consumer (so the Waveform's Web Audio API
// can also reach it).
export function usePlayer({ initialVolume = 1 }: UsePlayerOptions = {}): Player {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Resolved at mount via canPlayType. SSR + first render use the MP3 URL so
  // server and client markup agree; the useEffect below upgrades to Opus when
  // the browser confirms it can decode it.
  const [streamUrl, setStreamUrl] = useState<string>(MP3_STREAM_URL);
  const [tunedIn, setTunedIn] = useState(false);
  // 'idle' | 'connecting' | 'playing'. 'connecting' covers the unavoidable
  // gap between the tune-in gesture and the first audible audio frames —
  // surfaced in the UI so the player doesn't claim to be playing while silent.
  const [status, setStatus] = useState<PlayerStatus>('idle');
  const [volume, setVolume] = useState(initialVolume);
  const preMuteVolume = useRef(initialVolume || 1);

  // play() resolves asynchronously; pausing before it settles rejects the
  // promise with an AbortError. We hold the latest play() promise and a
  // generation counter so rapid tune/stop toggles (now trivially reachable
  // via the Space/K shortcuts) settle on the last action without spurious
  // errors or a stale teardown clobbering a fresh play.
  const playPromise = useRef<Promise<void> | null>(null);
  const gen = useRef(0);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  // Pick Opus on capable browsers (Chrome, Firefox, Edge, Safari 17+) so the
  // listener gets ~half the bandwidth at equal-or-better quality; everyone
  // else stays on MP3. A throwaway <audio> avoids racing the consumer's ref.
  // Skipped when the host override didn't fit the /stream.mp3 pattern — in
  // that case we have no opus URL to offer and the override is treated as a
  // pinned URL.
  useEffect(() => {
    if (!OPUS_STREAM_URL) return;
    const tester = document.createElement('audio');
    const opusOk = tester.canPlayType('audio/ogg; codecs=opus');
    if (opusOk === 'probably' || opusOk === 'maybe') {
      setStreamUrl(OPUS_STREAM_URL);
    }
  }, []);

  // Drive `status` from the <audio> element's own events: 'playing' fires when
  // audio is actually audible; 'waiting'/'stalled' mean a rebuffer; 'error'
  // means the connection failed. tune()/stop() set 'connecting'/'idle' eagerly;
  // these listeners settle it to the truth.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onPlaying = () => setStatus('playing');
    const onWaiting = () =>
      setStatus(s => (s === 'playing' ? 'connecting' : s));
    const onError = () => setStatus('idle');
    el.addEventListener('playing', onPlaying);
    el.addEventListener('waiting', onWaiting);
    el.addEventListener('stalled', onWaiting);
    el.addEventListener('error', onError);
    return () => {
      el.removeEventListener('playing', onPlaying);
      el.removeEventListener('waiting', onWaiting);
      el.removeEventListener('stalled', onWaiting);
      el.removeEventListener('error', onError);
    };
  }, []);

  // Tear down playback. Used by the Tune Out button and by PlayerApp when the
  // station goes off air, so the <audio> element isn't left retrying a dead
  // mount.
  const stop = () => {
    if (!audioRef.current) return;
    const el = audioRef.current;
    const myGen = ++gen.current;
    setTunedIn(false);
    setStatus('idle');
    // Let any in-flight play() settle before pausing, then bail if a later
    // tune() has already superseded this teardown.
    Promise.resolve(playPromise.current)
      .catch(() => {})
      .then(() => {
        if (gen.current !== myGen) return;
        el.pause();
        el.src = '';
      });
  };

  const tune = () => {
    if (!audioRef.current) return;
    if (tunedIn) {
      stop();
      return;
    }
    const el = audioRef.current;
    const myGen = ++gen.current;
    el.src = `${streamUrl}?t=${Date.now()}`;
    el.volume = volume;
    setTunedIn(true);
    setStatus('connecting');
    const p = el.play();
    playPromise.current = p;
    Promise.resolve(p).catch((err: unknown) => {
      // AbortError just means a later stop() interrupted this play — benign.
      const name = err && typeof err === 'object' && 'name' in err ? (err as { name?: string }).name : undefined;
      if (gen.current === myGen && name !== 'AbortError') {
        console.error('Play failed:', err);
      }
    });
  };

  // Mute is just volume 0; toggling restores the last non-zero level so the
  // keyboard 'M' shortcut and the command palette have a sensible round-trip.
  const toggleMute = () => {
    if (volume > 0) {
      preMuteVolume.current = volume;
      setVolume(0);
    } else {
      setVolume(preMuteVolume.current || 1);
    }
  };

  return { audioRef, tunedIn, status, volume, setVolume, tune, stop, toggleMute, muted: volume === 0 };
}

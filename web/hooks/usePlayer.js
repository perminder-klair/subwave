'use client';

import { useEffect, useRef, useState } from 'react';

const STREAM_URL = process.env.NEXT_PUBLIC_STREAM_URL || '/stream.mp3';

// Owns the <audio> element + tune-in state. The audioRef must be attached to
// an <audio> tag rendered by the consumer (so the Waveform's Web Audio API
// can also reach it).
export function usePlayer({ initialVolume = 0.8 } = {}) {
  const audioRef = useRef(null);
  const [tunedIn, setTunedIn] = useState(false);
  const [volume, setVolume] = useState(initialVolume);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  const tune = () => {
    if (!audioRef.current) return;
    if (tunedIn) {
      audioRef.current.pause();
      audioRef.current.src = '';
      setTunedIn(false);
    } else {
      audioRef.current.src = `${STREAM_URL}?t=${Date.now()}`;
      audioRef.current.volume = volume;
      audioRef.current.play().catch(err => console.error('Play failed:', err));
      setTunedIn(true);
    }
  };

  return { audioRef, tunedIn, volume, setVolume, tune };
}

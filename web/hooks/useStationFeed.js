'use client';

import { useEffect, useRef, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api';

// 5s polling of /now-playing + /state, plus a 1s elapsed tick reset on
// track-change. Single source of truth for "what's on air right now".
export function useStationFeed() {
  const [nowPlaying, setNowPlaying] = useState(null);
  const [context, setContext] = useState(null);
  const [dj, setDj] = useState(null);
  const [activeShow, setActiveShow] = useState(null);
  const [listeners, setListeners] = useState(null);
  const [state, setState] = useState({ upcoming: [], history: [], djLog: [] });
  const [elapsed, setElapsed] = useState(0);
  const trackStartRef = useRef(null);

  useEffect(() => {
    const tick = async () => {
      try {
        const [npRes, stRes] = await Promise.all([
          fetch(`${API_URL}/now-playing`).then(r => r.json()),
          fetch(`${API_URL}/state`).then(r => r.json()),
        ]);
        setNowPlaying(prev => {
          if (npRes.nowPlaying?.title !== prev?.title || npRes.nowPlaying?.artist !== prev?.artist) {
            trackStartRef.current = Date.now();
          }
          return npRes.nowPlaying;
        });
        setContext(npRes.context);
        if (npRes.dj) setDj(npRes.dj);
        // activeShow is { name, persona:{name} } | null — null = no show this hour.
        setActiveShow(npRes.activeShow ?? npRes.context?.activeShow ?? null);
        if (npRes.listeners) setListeners(npRes.listeners);
        setState(stRes);
      } catch {}
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      if (trackStartRef.current) {
        setElapsed(Math.floor((Date.now() - trackStartRef.current) / 1000));
      }
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const duration = nowPlaying?.duration ?? 0;
  const progress = duration > 0 ? Math.min(1, elapsed / duration) : 0;

  return { nowPlaying, context, dj, activeShow, listeners, state, elapsed, progress };
}

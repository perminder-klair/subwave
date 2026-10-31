'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { adminResponse, type AdminFetch } from '../../../lib/admin-query';

export function useJoinPreview(trackKey: string, adminFetch: AdminFetch) {
  const [active, setActive] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const url = useRef<string | null>(null);
  const clear = useCallback(() => {
    request.current?.abort();
    request.current = null;
    if (audio.current) { audio.current.onended = null; audio.current.onerror = null; audio.current.pause(); audio.current.removeAttribute('src'); audio.current.load(); audio.current = null; }
    if (url.current) { URL.revokeObjectURL(url.current); url.current = null; }
  }, []);
  useEffect(() => {
    setActive(null); setLoading(false); setPlaying(false); setMessage(null);
    return clear;
  }, [trackKey, clear]);

  const toggle = async (index: number, trackIds: string[]) => {
    // A second click cancels preparation or stops playback. Only one join plays.
    if (active === index && (loading || !audio.current?.paused)) {
      clear(); setActive(null); setLoading(false); setPlaying(false); setMessage(null); return;
    }
    if (active === index && audio.current) {
      try { await audio.current.play(); setPlaying(true); setMessage(null); }
      catch { setMessage('Could not play this preview. Try again.'); }
      return;
    }
    clear(); setActive(index); setLoading(true); setPlaying(false); setMessage(null);
    const ac = new AbortController();
    request.current = ac;
    try {
      const response = await adminResponse(adminFetch, '/library/sub-flow/join-preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackIds }), signal: ac.signal,
      });
      const blob = await response.blob();
      if (ac.signal.aborted) return;
      url.current = URL.createObjectURL(blob);
      const player = new Audio(url.current);
      audio.current = player;
      player.onended = () => { clear(); setActive(null); setPlaying(false); };
      player.onerror = () => { clear(); setActive(null); setPlaying(false); setMessage('Could not play this preview. Try again.'); };
      setLoading(false);
      try { await player.play(); if (!ac.signal.aborted) setPlaying(true); }
      catch {
        if (!ac.signal.aborted) setMessage('Preview ready. Press Play to listen.');
      }
    } catch (error) {
      if (ac.signal.aborted) return;
      clear(); setActive(null); setLoading(false); setPlaying(false);
      setMessage(error instanceof Error ? error.message : 'Could not prepare the preview. Try again.');
    }
  };
  return { active, loading, playing, message, toggle };
}

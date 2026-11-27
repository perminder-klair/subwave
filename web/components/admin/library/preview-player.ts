'use client';

// The admin's preview player: one audio element for the whole admin, so
// starting a track stops the one before it. A Library row's play button and its
// progress bar read this store; nothing here touches the live stream. The
// element plays a short-lived signed link the controller hands an admin
// (POST /library/:id/preview), because an <audio> element cannot send the
// console's Basic header; the link streams the original file with Range, so the
// bar seeks on real bytes. A link lapses after `expiresInSec` (6 h): resuming
// past that asks for a fresh one and carries on from the same position, and so
// does the press after any error, so a lapsed link met by a seek costs one
// press, never the place in the track.

import { useEffect, useSyncExternalStore } from 'react';

export type PreviewStatus = 'loading' | 'playing' | 'paused' | 'error';

export interface PreviewSnapshot {
  id: string | null;
  status: PreviewStatus | null;
  time: number;      // seconds
  duration: number;  // seconds; 0 until the element knows
  volume: number;    // 0..1, the operator's level, kept across previews
  muted: boolean;
}

// The slice of HTMLAudioElement the store drives, so a test can stand one in.
export interface PreviewAudio {
  src: string;
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  volume: number;
  muted: boolean;
  play(): Promise<void>;
  pause(): void;
  removeAttribute(name: string): void;
  load(): void;
  addEventListener(type: string, fn: () => void): void;
}

// A signed link to the audio and how long it is good for, from the moment it
// arrives (POST /library/:id/preview).
export interface PreviewLink {
  url: string;
  expiresInSec: number;
}

// Asked for a link this long before it lapses, so a resume never races the
// expiry with its first Range read.
export const LINK_EXPIRY_MARGIN_MS = 60_000;

// Where the level is kept between visits (localStorage in the browser).
export interface VolumeStore {
  get(): string | null;
  set(value: string): void;
}

const IDLE_TRACK = { id: null, status: null, time: 0, duration: 0 } as const;
const IDLE: PreviewSnapshot = { ...IDLE_TRACK, volume: 1, muted: false };

// "0.6" or "0.6:m" (muted); anything else is full level, unmuted.
export function parseVolume(raw: string | null): { volume: number; muted: boolean } {
  const m = /^(\d*\.?\d+)(:m)?$/.exec(raw ?? '');
  const v = m ? Number(m[1]) : Number.NaN;
  return { volume: Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1, muted: !!m?.[2] };
}

export function createPreviewPlayer(makeAudio: () => PreviewAudio, store?: VolumeStore, now: () => number = Date.now) {
  let audio: PreviewAudio | null = null;
  // When the current link lapses, on this browser's clock (never the server's,
  // so a skewed clock cannot keep a dead link).
  let linkExpiresAt = 0;
  // A position to restore once a fresh link's metadata is in: setting
  // currentTime before then is not kept by every browser.
  let pendingSeek: number | null = null;
  let saved: { volume: number; muted: boolean } = { volume: 1, muted: false };
  try { saved = parseVolume(store?.get() ?? null); } catch { /* storage blocked: full level */ }
  let snap: PreviewSnapshot = { ...IDLE, ...saved };
  // Bumped by every start and stop, so a link that arrives after the operator
  // moved on is dropped instead of starting the wrong track.
  let generation = 0;
  const listeners = new Set<() => void>();

  const publish = (next: Partial<PreviewSnapshot>) => {
    const merged = { ...snap, ...next };
    if (merged.id === snap.id && merged.status === snap.status && merged.time === snap.time
      && merged.duration === snap.duration && merged.volume === snap.volume && merged.muted === snap.muted) return;
    snap = merged;
    for (const l of listeners) l();
  };
  const knownDuration = (a: PreviewAudio) => (Number.isFinite(a.duration) && a.duration > 0 ? a.duration : 0);

  function element(): PreviewAudio {
    if (audio) return audio;
    const a = makeAudio();
    a.volume = snap.volume;
    a.muted = snap.muted;
    // While a position waits to be restored, the new source's 0 is not news.
    a.addEventListener('timeupdate', () => { if (snap.id && pendingSeek == null) publish({ time: a.currentTime }); });
    a.addEventListener('durationchange', () => { if (snap.id && knownDuration(a)) publish({ duration: knownDuration(a) }); });
    a.addEventListener('loadedmetadata', () => {
      if (!snap.id) return;
      const end = knownDuration(a);
      if (pendingSeek != null) {
        const t = end ? Math.min(pendingSeek, end) : pendingSeek;
        pendingSeek = null;
        a.currentTime = t;
        publish({ time: t });
      }
      if (end) publish({ duration: end });
    });
    a.addEventListener('playing', () => { if (snap.id) publish({ status: 'playing' }); });
    a.addEventListener('pause', () => { if (snap.id && snap.status === 'playing') publish({ status: 'paused' }); });
    a.addEventListener('ended', () => { stop(); });
    a.addEventListener('error', () => { if (snap.id && a.src) publish({ status: 'error' }); });
    audio = a;
    return a;
  }

  function stop() {
    generation++;
    pendingSeek = null;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    publish(IDLE_TRACK);
  }

  // Load `id` from a fresh link and play it, from `at` seconds (a resume after
  // the link lapsed, or a retry after an error) or from the start.
  async function start(id: string, link: () => Promise<PreviewLink>, at = { time: 0, duration: 0 }): Promise<void> {
    stop();
    const mine = generation;
    publish({ id, status: 'loading', time: at.time, duration: at.duration });
    let got: PreviewLink;
    try {
      got = await link();
    } catch {
      if (generation === mine) publish({ status: 'error' });
      return;
    }
    if (generation !== mine) return;
    const ttl = Number.isFinite(got.expiresInSec) && got.expiresInSec > 0 ? got.expiresInSec : 0;
    linkExpiresAt = now() + ttl * 1000;
    const a = element();
    pendingSeek = at.time > 0 ? at.time : null;
    a.src = got.url;
    try {
      await a.play();
    } catch {
      if (generation === mine) publish({ status: 'error' });
    }
  }

  // Play `id`, or pause/resume it when it is already the preview. `link` asks
  // the controller for a signed URL (only when a fresh one is needed).
  async function toggle(id: string, link: () => Promise<PreviewLink>): Promise<void> {
    if (snap.id === id && snap.status === 'playing') {
      element().pause();
      return;
    }
    if (snap.id === id && snap.status === 'loading') return;
    const here = { time: snap.time, duration: snap.duration };
    if (snap.id === id && snap.status === 'paused') {
      // The link lapsed while paused: the element's next Range read would be
      // refused, so sign again and pick up where it stopped.
      if (now() >= linkExpiresAt - LINK_EXPIRY_MARGIN_MS) return start(id, link, here);
      const mine = generation;
      publish({ status: 'loading' });
      try {
        await element().play();
      } catch {
        if (generation === mine) publish({ status: 'error' });
      }
      return;
    }
    // This track again after an error keeps its place; a new track starts.
    return start(id, link, snap.id === id ? here : undefined);
  }

  function seek(seconds: number) {
    if (!audio || !snap.id || !Number.isFinite(seconds)) return;
    const end = knownDuration(audio) || (pendingSeek != null ? snap.duration : 0);
    const t = Math.max(0, end ? Math.min(seconds, end) : seconds);
    // Dragged while a fresh link loads: the restore lands here instead.
    if (pendingSeek != null) pendingSeek = t;
    else audio.currentTime = t;
    publish({ time: t });
  }

  function persist() {
    try { store?.set(`${snap.volume}${snap.muted ? ':m' : ''}`); } catch { /* storage blocked */ }
  }

  // Moving the level up unmutes, as on any player; to zero is just quiet.
  function setVolume(v: number) {
    if (!Number.isFinite(v)) return;
    const volume = Math.max(0, Math.min(1, v));
    const muted = volume > 0 ? false : snap.muted;
    if (audio) { audio.volume = volume; audio.muted = muted; }
    publish({ volume, muted });
    persist();
  }

  // Unmuting at zero would be silent: it brings the level back to half.
  function toggleMute() {
    const muted = !snap.muted;
    const volume = !muted && snap.volume === 0 ? 0.5 : snap.volume;
    if (audio) { audio.volume = volume; audio.muted = muted; }
    publish({ volume, muted });
    persist();
  }

  return {
    toggle,
    seek,
    stop,
    setVolume,
    toggleMute,
    subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
    getSnapshot: () => snap,
  };
}

export type PreviewPlayer = ReturnType<typeof createPreviewPlayer>;

let shared: PreviewPlayer | null = null;
const VOLUME_KEY = 'subwave_preview_volume';
function sharedPlayer(): PreviewPlayer {
  shared ??= createPreviewPlayer(() => {
    const a = new Audio();
    a.preload = 'auto';
    return a;
  }, {
    get: () => localStorage.getItem(VOLUME_KEY),
    set: (v) => localStorage.setItem(VOLUME_KEY, v),
  });
  return shared;
}

// Whether this browser lets a page set an audio element's level. iOS and
// iPadOS Safari do not (the level is the hardware buttons'), and say so by
// keeping `volume` at 1 whatever is written: there the bar offers mute only.
let volumeSettable: boolean | null = null;
export function canSetVolume(): boolean {
  if (volumeSettable != null) return volumeSettable;
  if (typeof window === 'undefined') return true;
  try {
    const probe = new Audio();
    probe.volume = 0.5;
    volumeSettable = probe.volume === 0.5;
  } catch {
    volumeSettable = false;
  }
  return volumeSettable;
}

// Tables currently showing rows: the preview stops when the last one unmounts,
// so it never plays on with no control on screen.
let mounted = 0;

export function usePreviewPlayer() {
  const player = typeof window === 'undefined' ? null : sharedPlayer();
  const snap = useSyncExternalStore(
    player ? player.subscribe : () => () => {},
    player ? player.getSnapshot : () => IDLE,
    () => IDLE,
  );
  useEffect(() => {
    mounted++;
    return () => {
      mounted--;
      if (mounted === 0) shared?.stop();
    };
  }, []);
  return { snap, player };
}

export function fmtClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

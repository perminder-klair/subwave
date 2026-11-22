'use client';

// The skip cheat code (lib/skipCheat.ts): ↑ ↑ ↓ ↓ B A, typed, or swiped with
// two taps for B A.
//
// Listeners never get a skip. This is the admin's shortcut: it sends the
// credentials this browser already holds from signing in to /admin
// (lib/adminAuth.ts) to the admin-only `POST /dj/skip`, and the controller's
// `requireAdmin` is the gate. Without them nothing is sent; the code only gets
// a joke. The skip is TARGETED at the track the feed shows on air (`expectId`),
// so a code finished just as the song changes never skips the next one, and a
// jingle, bed or break on air is refused rather than cut.
//
// Every listener is passive and capture-phase: it never prevents a default or
// stops propagation, so a skin's own keys, taps and swipes behave as before. It
// does nothing in a showcase embed, while the station gate is up, or for keys
// typed into a text field.

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useAdminAuth } from '@/lib/adminAuth';
import { cn } from '@/lib/cn';
import { advanceCheat, CHEAT_START, keyToken, touchToken, type CheatToken } from '@/lib/skipCheat';
import { usePlayerFeed } from './PlayerCore';

const NICE_TRY = [
  'Nice try. That code only works for the booth.',
  'Access denied. The DJ has seen this one before.',
  '+30 lives. Still no skip, though.',
];

function isTextEntry(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

export function SkipCheat({ disabled }: { disabled: boolean }) {
  const { nowPlaying, leadMs } = usePlayerFeed();
  const { auth, adminFetch } = useAdminAuth();
  const [flash, setFlash] = useState(0);

  // Read at fire time, so the listeners stay registered once.
  const live = useRef({ disabled, nowPlaying, leadMs, auth, adminFetch });
  live.current = { disabled, nowPlaying, leadMs, auth, adminFetch };
  const busy = useRef(false);

  const fire = useCallback(async () => {
    const { nowPlaying: np, leadMs: lead, auth: token, adminFetch: send } = live.current;
    if (busy.current) return;
    const niceTry = () => toast(NICE_TRY[Math.floor(Math.random() * NICE_TRY.length)]);
    if (!token) return niceTry();
    const expectId = np?.subsonic_id;
    if (!expectId) return toast('Cheat code accepted, but no song is on air to skip.');

    busy.current = true;
    try {
      const r = await send('/dj/skip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectId }),
      });
      if (r.ok) {
        setFlash(n => n + 1);
        const secs = Math.round(lead / 1000);
        const title = np?.title ? `“${np.title}”` : 'the track';
        toast.success(`Cheat code accepted. Skipping ${title}.`, {
          description: secs > 1 ? `You'll hear it in about ${secs} s; the stream runs behind live.` : undefined,
        });
      } else if (r.status === 401) {
        niceTry();
      } else if (r.status === 409) {
        const body = await r.json().catch(() => null) as { error?: string } | null;
        toast(body?.error ?? 'That track already ended.');
      } else if (r.status === 429) {
        toast.error('Too many tries. The admin sign-in is locked for a while.');
      } else {
        toast.error(`Skip failed (${r.status}).`);
      }
    } catch {
      toast.error('Skip failed: could not reach the station.');
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    let state = CHEAT_START;
    const feed = (token: CheatToken | null) => {
      if (!token || live.current.disabled) return;
      const r = advanceCheat(state, token, Date.now());
      state = r.state;
      if (r.fired) void fire();
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || isTextEntry(e.target)) return;
      feed(keyToken(e.key));
    };

    let start: { x: number; y: number; t: number } | null = null;
    const onTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      // A second finger is a pinch or a zoom, never part of the code.
      start = e.touches.length === 1 && touch && !isTextEntry(e.target)
        ? { x: touch.clientX, y: touch.clientY, t: Date.now() }
        : null;
    };
    const onTouchEnd = (e: TouchEvent) => {
      const touch = e.changedTouches[0];
      if (!start || !touch || e.touches.length > 0) { start = null; return; }
      feed(touchToken(touch.clientX - start.x, touch.clientY - start.y, Date.now() - start.t));
      start = null;
    };
    const onTouchCancel = () => { start = null; };

    window.addEventListener('keydown', onKey, true);
    window.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
    window.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
    window.addEventListener('touchcancel', onTouchCancel, { capture: true, passive: true });
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('touchstart', onTouchStart, true);
      window.removeEventListener('touchend', onTouchEnd, true);
      window.removeEventListener('touchcancel', onTouchCancel, true);
    };
  }, [fire]);

  return flash > 0 ? <SkipFlash key={flash} /> : null;
}

/** A brief ▶▶ across the player. Its resting frame is invisible, and with reduced
 *  motion it never shows: the toast carries the message alone. */
function SkipFlash() {
  const [shown, setShown] = useState(true);
  useEffect(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setShown(false)));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-[60] hidden items-center justify-center motion-safe:flex"
    >
      <span
        className={cn(
          'font-mono text-7xl font-bold tracking-tighter text-ink transition-all duration-1000 ease-out sm:text-9xl',
          shown ? 'scale-100 opacity-100' : 'translate-x-[12%] scale-150 opacity-0',
        )}
      >
        ▶▶ SKIP
      </span>
    </div>
  );
}

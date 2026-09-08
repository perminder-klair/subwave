'use client';

// The hook siblings of shared.ts (which stays pure derivations). Everything
// here reads only the core contexts, per the skin contract (see types.ts);
// wording and layout stay with each skin.

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlayerActions, usePlayerFeed } from '@/components/player/PlayerCore';
import { useLiteMode } from '@/hooks/useLiteMode';

/** Whether a skin may run a JS-driven (motion) transition right now. Lite
 *  mode's `animation: none !important` reaches only CSS keyframes, so a skin
 *  that skips this gate stops honouring the low-power toggle.
 *
 *  Reduced motion is not this hook's job: MotionConfig's reducedMotion="user"
 *  drops transforms app-wide. It preserves opacity-only transitions, so those
 *  must also call useReducedMotion() (see subamp's LCD latch). */
export function useSkinMotion(): boolean {
  const { lite } = useLiteMode();
  return !lite;
}

// Poll cadence + give-up window for a submitted request's outcome. Past the
// deadline the accepted line stands.
const POLL_INTERVAL_MS = 1500;
const POLL_DEADLINE_MS = 60_000;

/** Copy for a request slip's three outcomes, when the controller doesn't
 *  supply its own line — each skin keeps its own voice. */
export interface RequestSlipCopy {
  /** Accepted, no ack line from the controller. */
  sent: string;
  /** Refused, no message from the controller. */
  refused: string;
  /** The network call itself failed. */
  failed: string;
}

export interface RequestSlip {
  text: string;
  setText: (v: string) => void;
  /** Optional "from" name (#1347); a skin that renders no field never calls
   *  setName and the request goes up unsigned. Deliberately not cleared by
   *  send(), so it carries to the next request in the session. */
  name: string;
  setName: (v: string) => void;
  /** Outcome line to show in place of the form, or null while composing.
   *  Upgrades in place once the pick resolves. */
  ack: string | null;
  /** Clear the ack and return to the form. Cancels any in-flight polling. */
  reset: () => void;
  sending: boolean;
  /** Submit the current text. No-op while empty or already sending. */
  send: () => Promise<void>;
}

/** The shared request-slip state machine: compose → send → show the
 *  controller's ack (or the skin's fallback copy) → reset. */
export function useRequestSlip(copy: RequestSlipCopy): RequestSlip {
  const { submitRequest, pollRequest } = usePlayerActions();
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [ack, setAck] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  // Poll lifecycle held in refs so reset()/unmount can stop an in-flight loop
  // before a late tick setAck()s onto a torn-down slip.
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollStopRef = useRef(false);
  const stopPolling = useCallback(() => {
    pollStopRef.current = true;
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);
  useEffect(() => stopPolling, [stopPolling]);

  const startPolling = (requestId: string) => {
    pollStopRef.current = false;
    const deadline = Date.now() + POLL_DEADLINE_MS;
    const tick = async () => {
      if (pollStopRef.current) return;
      if (Date.now() > deadline) return; // give up quietly; accepted line stands
      const data = await pollRequest(requestId);
      if (pollStopRef.current) return;
      if (data?.status === 'resolved') {
        const t = data.track;
        const pos =
          typeof data.queuePosition === 'number' && data.queuePosition > 0
            ? ` — #${data.queuePosition} in the queue`
            : '';
        setAck(
          data.ack ||
            (t?.title
              ? `Lining up “${t.title}”${t.artist ? ` by ${t.artist}` : ''}${pos}.`
              : copy.sent),
        );
        return;
      }
      if (data?.status === 'failed') {
        setAck(data.message || copy.refused);
        return;
      }
      if (data?.status === 'unknown') return;
      // pending, or a transient network null — keep polling.
      pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
    };
    pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
  };

  const send = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    stopPolling();
    setSending(true);
    try {
      const res = await submitRequest(trimmed, name.trim());
      setAck(res.success ? (res.ack || copy.sent) : (res.message || copy.refused));
      if (res.success) {
        setText('');
        // The match runs in the booth, so poll for the real pick and upgrade
        // the ack to the answer.
        if (res.requestId) startPolling(res.requestId);
      }
    } catch {
      setAck(copy.failed);
    } finally {
      setSending(false);
    }
  };

  const reset = useCallback(() => {
    stopPolling();
    setAck(null);
  }, [stopPolling]);
  return { text, setText, name, setName, ack, reset, sending, send };
}

export interface TrackLike {
  /** Likes are enabled on this station AND a likeable track is on air (jingles
   *  and spoken segments carry no id). Skins hide the heart when false. */
  available: boolean;
  /** This listener already liked the current airing (server-side dedup — no
   *  account, keyed on a hash of the connection). */
  liked: boolean;
  /** Total likes for the current song, all airings. */
  count: number;
  pending: boolean;
  /** Like the current track. No-op while unavailable, pending, or liked. */
  like: () => Promise<void>;
}

/** The heart button's state machine (#991). Wording and iconography stay with
 *  each skin. */
export function useTrackLike(): TrackLike {
  const { likeCurrent, likeStatus } = usePlayerActions();
  const feed = usePlayerFeed();
  const songId = feed.nowPlaying?.subsonic_id || null;

  // enabled starts false ("unknown") so stations with likes off never flash a
  // heart; the first status fetch flips it on.
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<{ songId: string | null; liked: boolean; count: number }>({
    songId: null,
    liked: false,
    count: 0,
  });
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ songId, liked: false, count: 0 });
    if (!songId) return;
    likeStatus().then(st => {
      if (cancelled || !st) return;
      setEnabled(st.enabled !== false);
      // Only apply if the answer is about the track we asked for; a status
      // racing a track change paints the wrong liked-state.
      if (st.songId && st.songId !== songId) return;
      setState({ songId, liked: !!st.liked, count: st.count ?? 0 });
    });
    return () => {
      cancelled = true;
    };
  }, [songId, likeStatus]);

  const like = useCallback(async () => {
    if (!songId || pending || (state.liked && state.songId === songId)) return;
    setPending(true);
    try {
      const res = await likeCurrent(songId);
      if (res && (res.ok || res.alreadyLiked)) {
        setState({ songId, liked: true, count: res.count ?? 0 });
      }
    } finally {
      setPending(false);
    }
  }, [songId, pending, state.liked, state.songId, likeCurrent]);

  return {
    available: enabled && !!songId,
    liked: state.liked && state.songId === songId,
    count: state.songId === songId ? state.count : 0,
    pending,
    like,
  };
}

/** Keyboard/button volume nudge — clamps to [0, 1] on whole-percent steps. */
export function useVolumeNudge(): (delta: number) => void {
  const { setVolume } = usePlayerActions();
  return useCallback(
    (delta: number) =>
      setVolume(v => Math.min(1, Math.max(0, Math.round((v + delta) * 100) / 100))),
    [setVolume],
  );
}

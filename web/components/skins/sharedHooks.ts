'use client';

// Stateful helpers shared by skin implementations — the hook siblings of
// shared.ts (which stays pure derivations). Everything here reads only the
// core contexts, per the skin contract (see types.ts); wording and layout
// stay with each skin.

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlayerActions } from '@/components/player/PlayerCore';

// Poll cadence + give-up window for a submitted request's outcome. Mirrors the
// classic RequestDrawer (classic/drawers/RequestDrawer.tsx) so every skin gets
// the same follow-through: accept, then the ack upgrades in place once the DJ
// picks. The controller resolves within a few seconds; 60s is a generous ceiling
// after which the accepted line simply stands.
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
  /** Optional "from" name — skins without a name field just never set it. */
  name: string;
  setName: (v: string) => void;
  /** Outcome line to show in place of the form, or null while composing.
   *  Upgrades in place: the instant accept ack is replaced by the DJ's on-air
   *  ack (or the matched track) once the pick resolves, and by the miss copy
   *  if the booth can't place it. */
  ack: string | null;
  /** Clear the ack and return to the form. Cancels any in-flight polling. */
  reset: () => void;
  sending: boolean;
  /** Submit the current text. No-op while empty or already sending. */
  send: () => Promise<void>;
}

/** The request-slip state machine every skin was hand-rolling: compose →
 *  send → show the controller's ack (or the skin's fallback copy) → reset. */
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

  // Poll the controller until the request resolves, fails, or the deadline
  // passes. The accepted ack holds while pending; on resolve it becomes the
  // DJ's on-air line (or the matched track), on failure the miss copy.
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
        // Accepted in ~50ms with a request id; the match runs in the booth.
        // Poll for the real pick so the ack upgrades from "on it" to the answer.
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

/** Keyboard/button volume nudge — clamps to [0, 1] on whole-percent steps. */
export function useVolumeNudge(): (delta: number) => void {
  const { setVolume } = usePlayerActions();
  return useCallback(
    (delta: number) =>
      setVolume(v => Math.min(1, Math.max(0, Math.round((v + delta) * 100) / 100))),
    [setVolume],
  );
}

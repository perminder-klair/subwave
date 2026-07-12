'use client';

// Stateful helpers shared by skin implementations — the hook siblings of
// shared.ts (which stays pure derivations). Everything here reads only the
// core contexts, per the skin contract (see types.ts); wording and layout
// stay with each skin.

import { useCallback, useState } from 'react';
import { usePlayerActions } from '@/components/player/PlayerCore';

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
  /** Outcome line to show in place of the form, or null while composing. */
  ack: string | null;
  /** Clear the ack and return to the form. */
  reset: () => void;
  sending: boolean;
  /** Submit the current text. No-op while empty or already sending. */
  send: () => Promise<void>;
}

/** The request-slip state machine every skin was hand-rolling: compose →
 *  send → show the controller's ack (or the skin's fallback copy) → reset. */
export function useRequestSlip(copy: RequestSlipCopy): RequestSlip {
  const { submitRequest } = usePlayerActions();
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [ack, setAck] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const send = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      const res = await submitRequest(trimmed, name.trim());
      setAck(res.success ? (res.ack || copy.sent) : (res.message || copy.refused));
      if (res.success) setText('');
    } catch {
      setAck(copy.failed);
    } finally {
      setSending(false);
    }
  };

  const reset = useCallback(() => setAck(null), []);
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

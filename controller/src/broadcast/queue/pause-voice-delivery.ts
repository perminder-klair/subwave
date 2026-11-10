// Durable observation of a pause-and-talk voice handoff. The controller is
// allowed to restart; Liquidsoap keeps running and advances the same stable
// delivery id from say.txt -> accepted -> started. Recovery acts on the
// strongest phase it can prove and never republishes an accepted voice.

import { readFileSync } from 'node:fs';
import { config } from '../../config.js';
import { parseVoiceMarker } from './voice-marker.js';
import { sleep } from './pure.js';

export type PauseVoiceDeliveryState =
  | { phase: 'unpublished' }
  | { phase: 'published' }
  | { phase: 'accepted'; acceptedAt: number }
  | { phase: 'started'; startedAt: number };

interface DeliveryMarker {
  deliveryId: string;
  at: number;
}

function parseDeliveryMarker(raw: string, clock: 'acceptedAt' | 'startedAt'): DeliveryMarker | null {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const deliveryId = typeof value.deliveryId === 'string' ? value.deliveryId : '';
  const seconds = Number(value[clock]);
  if (!deliveryId || !Number.isFinite(seconds) || seconds <= 0) return null;
  return { deliveryId, at: Math.round(seconds * 1000) };
}

export function parsePauseVoiceAccepted(raw: string): { deliveryId: string; acceptedAt: number } | null {
  const marker = parseDeliveryMarker(raw, 'acceptedAt');
  return marker ? { deliveryId: marker.deliveryId, acceptedAt: marker.at } : null;
}

export function parsePauseVoiceStarted(raw: string): { deliveryId: string; startedAt: number } | null {
  const marker = parseDeliveryMarker(raw, 'startedAt');
  return marker ? { deliveryId: marker.deliveryId, startedAt: marker.at } : null;
}

function readMarker<T>(path: string, parse: (raw: string) => T | null): T | null {
  try {
    return parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function handoffCarries(path: string, deliveryId: string): boolean {
  try {
    return readFileSync(path, 'utf8').includes(`subwave_pause_delivery="${deliveryId}"`);
  } catch {
    return false;
  }
}

export function inspectPauseVoiceDelivery(deliveryId: string): PauseVoiceDeliveryState {
  const started = readMarker(config.liquidsoap.pauseVoiceStartedFile, parsePauseVoiceStarted);
  if (started?.deliveryId === deliveryId) return { phase: 'started', startedAt: started.startedAt };

  // Compatibility with the first pause-and-talk mixer, which writes the
  // generic voice marker but predates the dedicated acceptance/start files.
  const generic = readMarker(config.liquidsoap.voicePlayingFile, parseVoiceMarker);
  if (generic?.voiceId === deliveryId) return { phase: 'started', startedAt: generic.airedAt };

  const accepted = readMarker(config.liquidsoap.pauseVoiceAcceptedFile, parsePauseVoiceAccepted);
  if (accepted?.deliveryId === deliveryId) return { phase: 'accepted', acceptedAt: accepted.acceptedAt };
  if (handoffCarries(config.liquidsoap.sayFile, deliveryId)) return { phase: 'published' };
  return { phase: 'unpublished' };
}

// Closes the tiny read/delete/push/ack interval in poll_voice. A controller
// restart can observe no say.txt after Liquidsoap removed it but before the
// accepted marker's atomic rename. The mixer is still alive, so a short wait
// turns that transient ambiguity into a durable answer.
export async function waitForPauseVoiceClaim(
  deliveryId: string,
  timeoutMs: number,
  pollMs = 50,
): Promise<PauseVoiceDeliveryState> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let state = inspectPauseVoiceDelivery(deliveryId);
  while (state.phase === 'unpublished' && Date.now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    state = inspectPauseVoiceDelivery(deliveryId);
  }
  return state;
}

export async function waitForPauseVoiceStarted(
  deliveryId: string,
  timeoutMs: number,
  pollMs = 100,
): Promise<number | null> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() <= deadline) {
    const state = inspectPauseVoiceDelivery(deliveryId);
    if (state.phase === 'started') return state.startedAt;
    if (Date.now() >= deadline) break;
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  return null;
}

// The JS half of the App Intents bridge. A Swift intent (Siri, Shortcuts, a
// Control) names an action; the handler set here performs it and its answer
// goes back to the waiting intent. A no-op outside iOS.

import { requireNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

export interface IntentReply {
  ok: boolean;
  /** Spoken by Siri, or shown by Shortcuts: the error when `ok` is false, the
   *  answer for an intent that has one (a song request). */
  message?: string;
}

export type IntentHandler = (
  action: string,
  args: Record<string, string>,
) => Promise<IntentReply>;

interface IntentRequest {
  token: string;
  action: string;
  args?: Record<string, string>;
}

interface Subscription {
  remove(): void;
}

interface NativeAppIntents {
  reply(token: string, ok: boolean, message: string | null): void;
  setOnAir(onAir: boolean): void;
  setStations(json: string): void;
  addListener(event: 'onIntent', fn: (request: IntentRequest) => void): Subscription;
}

// Android and binaries older than the bridge lack this module, and an OTA
// update must not crash them.
const native: NativeAppIntents | null = (() => {
  if (Platform.OS !== 'ios') return null;
  try {
    return requireNativeModule('SubwaveAppIntents') as unknown as NativeAppIntents;
  } catch {
    return null;
  }
})();

/** Tell the tune control (Control Center, Lock Screen, Action button) whether
 *  the station is on. The control cannot ask the player, so it shows this. */
export function setOnAir(onAir: boolean): void {
  try {
    native?.setOnAir(onAir);
  } catch {
    /* a binary older than the control */
  }
}

export interface SiriStation {
  /** The credential-free base URL, which is how Siri and Spotlight refer back
   *  to it. */
  id: string;
  name: string;
}

/** The saved stations and the active one, for Siri, Shortcuts and Spotlight,
 *  which cannot read the station store. Names and bases only: never a login
 *  or a station password. Re-indexes Spotlight. */
export function setStations(active: string | null, stations: SiriStation[]): void {
  try {
    native?.setStations(JSON.stringify({ active, stations }));
  } catch {
    /* a binary older than station support for Siri */
  }
}

/** Subscribing is what releases requests the module held while JS booted, so
 *  call this once, early, outside the React tree. */
export function setIntentHandler(handler: IntentHandler): Subscription | null {
  if (!native) return null;
  const bridge = native;
  try {
    return bridge.addListener('onIntent', ({ token, action, args }) => {
      void handler(action, args ?? {})
        .catch((): IntentReply => ({ ok: false }))
        .then((reply) => {
          try {
            bridge.reply(token, reply.ok, reply.message ?? null);
          } catch {
            /* the intent gives up on its own */
          }
        });
    });
  } catch {
    return null;
  }
}

// Live Activity control — the "on air" card on the Lock Screen, in the Dynamic
// Island, and (iOS 18+ mirrors it there for free) in the Apple Watch Smart
// Stack. The SwiftUI that renders it lives in targets/live-activity/.
//
// iOS-only by construction: Android's equivalent surface is the media
// notification, which react-native-track-player already owns. Every export here
// is a safe no-op on Android and on any iOS below the feature's floor, so
// callers never branch on platform.

import { requireNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

/** Immutable for the life of one activity — a station switch ends and restarts it. */
export interface LiveActivityConfig {
  /** Station display name, shown in the eyebrow. */
  station: string;
  /** Station theme accent as `#rrggbb`. */
  accent: string;
}

/** One on-air snapshot. */
export interface LiveActivityState {
  title: string;
  artist: string;
  /** Show name, e.g. "Night Shift". Omit outside a scheduled show. */
  show?: string | null;
  /** Stable cache key for the artwork — the subsonic id, or the persona's
   *  avatar path while the DJ is talking. */
  artworkKey?: string | null;
  /** Absolute artwork URL. The widget gets no network turn, so the app
   *  downloads this into the shared App Group container and passes the widget
   *  the filename it wrote. */
  artworkUrl?: string | null;
  /** Headers for the artwork fetch — `Authorization: Basic …` on a
   *  credentialed station (StationApi.streamHeaders). */
  artworkHeaders?: Record<string, string>;
  /** Epoch ms when this track became audible TO THIS LISTENER (listener-time,
   *  buffer offset already applied). The card's clock ticks natively from this,
   *  so it stays right for the whole song on one update. */
  startedAt?: number | null;
  /** Track length in seconds. Omit for anything unmeasured. */
  duration?: number | null;
  /** The DJ is mid-link. */
  talking?: boolean;
  likeCount?: number;
  liked?: boolean;
  /** A likeable track is on air and the station has likes on. False hides the
   *  heart entirely rather than showing one that cannot work. */
  likeable?: boolean;
}

interface Subscription {
  remove(): void;
}

interface NativeLiveActivity {
  isSupported(): boolean;
  start(config: LiveActivityConfig, state: LiveActivityState): Promise<boolean>;
  update(state: LiveActivityState): Promise<void>;
  stop(): Promise<void>;
  addListener(event: 'onLikePressed', fn: () => void): Subscription;
}

// requireNativeModule throws when the module is absent, which is every Android
// build and any iOS build made before this target existed (an OTA update can
// land JS that calls this on an older binary — expo-updates ships JS, never
// native code, so that combination is normal and must not crash).
const native: NativeLiveActivity | null = (() => {
  if (Platform.OS !== 'ios') return null;
  try {
    return requireNativeModule('SubwaveLiveActivity') as unknown as NativeLiveActivity;
  } catch {
    return null;
  }
})();

/** iOS 17+, the widget target is present, and the listener has not turned Live
 *  Activities off for SUB/WAVE in Settings. */
export function isLiveActivitySupported(): boolean {
  try {
    return native?.isSupported() ?? false;
  } catch {
    return false;
  }
}

/** Put the card up. Resolves false when the system refused it (permission
 *  revoked, too many activities) — never throws. */
export async function startLiveActivity(
  config: LiveActivityConfig,
  state: LiveActivityState,
): Promise<boolean> {
  try {
    return (await native?.start(config, state)) ?? false;
  } catch {
    return false;
  }
}

/** Push a new snapshot to whatever card is up. No-op when none is. */
export async function updateLiveActivity(state: LiveActivityState): Promise<void> {
  try {
    await native?.update(state);
  } catch {
    /* the card is the least important thing on screen — never surface this */
  }
}

/** Take the card down. */
export async function stopLiveActivity(): Promise<void> {
  try {
    await native?.stop();
  } catch {
    /* ignored */
  }
}

/** The heart, tapped from the card. The tap is handed back to JS rather than
 *  performed natively so the like goes out through the app's own API client —
 *  one code path, and no station URL or credential in an app extension. */
export function addLikePressedListener(fn: () => void): Subscription | null {
  if (!native) return null;
  try {
    return native.addListener('onLikePressed', fn);
  } catch {
    return null;
  }
}

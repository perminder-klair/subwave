// The native card lives in targets/live-activity. These exports are no-ops
// outside iOS so callers can use them without platform branches.

import { requireNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

/** Immutable for the life of one activity; a station switch restarts it. */
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
  /** Artwork cache key: the subsonic id, or the persona's avatar path while
   *  the DJ is talking. */
  artworkKey?: string | null;
  /** Absolute artwork URL. The widget gets no network turn, so the app
   *  downloads this into the shared App Group container and hands the widget
   *  the filename. */
  artworkUrl?: string | null;
  /** `Authorization: Basic …` on a credentialed station. */
  artworkHeaders?: Record<string, string>;
  /** Epoch ms when the track became audible to this listener (buffer offset
   *  already applied). The card's clock ticks natively from this, so one
   *  update keeps it right for the whole song. */
  startedAt?: number | null;
  /** Seconds. Omit when unmeasured. */
  duration?: number | null;
  /** The DJ is mid-link. */
  talking?: boolean;
  likeCount?: number;
  liked?: boolean;
  /** False hides the heart rather than showing one that cannot work. */
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

// Android and older iOS binaries lack this module. JS-only OTA updates
// must tolerate that without crashing.
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

/** Put the card up. Resolves false when the system refused it; never throws. */
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
    /* ignored */
  }
}

export async function stopLiveActivity(): Promise<void> {
  try {
    await native?.stop();
  } catch {
    /* ignored */
  }
}

/** The heart, tapped from the card. The tap is handed back to JS so the like
 *  goes out through the app's own API client: no station URL or credential in
 *  an app extension. */
export function addLikePressedListener(fn: () => void): Subscription | null {
  if (!native) return null;
  try {
    return native.addListener('onLikePressed', fn);
  } catch {
    return null;
  }
}

// Rewrites incoming system deep links before Expo Router tries to match them.
//
// react-native-track-player taps the lock-screen / media notification through a
// launch intent whose data is a sentinel URL — `trackplayer://notification.click`
// (MusicService.kt) — purely so an app *could* tell a notification tap apart.
// Expo Router has no such route, so the tap landed on the "unmatched route"
// (+not-found) page. We catch that sentinel (any scheme — RNTP's `trackplayer`,
// or our own `subwave` scheme) and send it to the player at `/` instead, where
// the audio the user tapped on is already playing. Everything else passes
// through untouched.

import type { NativeIntent } from 'expo-router';

export const redirectSystemPath: NonNullable<NativeIntent['redirectSystemPath']> = ({ path }) => {
  try {
    // `path` is the raw URL on a cold start (e.g. `trackplayer://notification.click`)
    // or a router path on a warm start — match the sentinel host in either form.
    if (path.includes('notification.click')) return '/';
    return path;
  } catch {
    return '/';
  }
};

// Rewrites incoming system deep links before Expo Router matches them.
//
// RNTP routes a media-notification tap through a sentinel URL,
// `trackplayer://notification.click`, which has no Expo Router route and lands
// on +not-found. Catch that sentinel under any scheme and send it to the
// player at `/`; everything else passes through untouched.

import type { NativeIntent } from 'expo-router';

export const redirectSystemPath: NonNullable<NativeIntent['redirectSystemPath']> = ({ path }) => {
  try {
    // `path` is the raw URL on a cold start and a router path on a warm one,
    // so match the sentinel host in either form.
    if (path.includes('notification.click')) return '/';
    return path;
  } catch {
    return '/';
  }
};

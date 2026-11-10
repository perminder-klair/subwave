// RNTP notification taps use trackplayer://notification.click, which has no
// Expo Router route. Send that sentinel to the player under any scheme.

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

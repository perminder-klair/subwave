// Whether the HLS transport is ACTIVE — the one answer every HLS surface reads:
// the mixer handoff (settings/liquidsoap.ts), the listener count
// (broadcast/hls-listeners.ts), the debug and connect views and Doctor.
//
// Two conditions, and the second is the one that matters:
//   * the operator switched it on (`stream.hlsEnabled`, off by default);
//   * the stream password is OFF. `privacy.listenerAuth` gates the icecast
//     mounts through Icecast's URL auth, but HLS is static files served by the
//     edge, which checks nothing — running both would hand the station to
//     anyone who knows /hls/live.m3u8 while the operator believes it is
//     locked. So a locked station does not write HLS at all, and every
//     surface says why rather than showing a mount that 404s.
//
// Pure, no settings import, so the settings layer can call it without a cycle.

export interface HlsPolicyInput {
  stream?: { hlsEnabled?: unknown } | null;
  privacy?: { listenerAuth?: unknown } | null;
}

export function hlsActive(s: HlsPolicyInput | null | undefined): boolean {
  return s?.stream?.hlsEnabled === true && s?.privacy?.listenerAuth !== true;
}

// Why an operator who switched HLS on isn't getting it, or null when nothing is
// holding it back (off, or on and active).
export function hlsBlockedReason(s: HlsPolicyInput | null | undefined): string | null {
  if (s?.stream?.hlsEnabled !== true) return null;
  if (s?.privacy?.listenerAuth === true) {
    return 'the stream password is on, and HLS is served as plain files the password cannot protect';
  }
  return null;
}

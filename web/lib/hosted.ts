// Hosted mode (SUBWAVE_HOSTED): a station run by SUB/WAVE Cloud. The admin
// server pages read it from the env here and hand it to the client sections
// through components/admin/HostedContext.tsx.
//
// This module must stay free of 'use client': the server pages CALL
// hostedFromEnv, and every export of a client module is a client reference on
// the server, so calling one there throws (a production build shows only
// React error #441, "Panel failed to render").

export interface HostedInfo {
  hosted: boolean;
  // A hosted music library (Navidrome + upload box run for this station):
  // where its owner uploads and browses. Absent = they bring their own server.
  musicUploadUrl?: string;
  musicLibraryUrl?: string;
  // The plan's concurrent-listener ceiling (SUBWAVE_LISTENER_CAP, set by the box
  // agent to the ICECAST_MAX_CLIENTS it gives the broadcast container).
  listenerCap?: number;
  // The plan's stream bitrate ceiling in kbps (SUBWAVE_MAX_BITRATE). Bitrate
  // pickers offer only values at or under it, and FLAC is unavailable.
  maxBitrate?: number;
}

// The hosted info from this process's env. Only https URLs are passed
// through, so a stray value can't become a javascript: link.
export function hostedFromEnv(env: Record<string, string | undefined>): HostedInfo {
  const hosted = ['1', 'true', 'yes'].includes((env.SUBWAVE_HOSTED || '').trim().toLowerCase());
  const url = (v?: string) => (v && /^https:\/\/[^\s"'<>]+$/.test(v.trim()) ? v.trim() : undefined);
  const cap = (v?: string) => {
    const n = Number((v || '').trim());
    return Number.isInteger(n) && n >= 1 && n <= 10000 ? n : undefined;
  };
  const bitrate = (v?: string) => {
    const n = cap(v);
    return n !== undefined && n >= 32 ? n : undefined;
  };
  return {
    hosted,
    ...(hosted && url(env.SUBWAVE_MUSIC_UPLOAD_URL) ? { musicUploadUrl: url(env.SUBWAVE_MUSIC_UPLOAD_URL) } : {}),
    ...(hosted && url(env.SUBWAVE_MUSIC_LIBRARY_URL) ? { musicLibraryUrl: url(env.SUBWAVE_MUSIC_LIBRARY_URL) } : {}),
    ...(hosted && cap(env.SUBWAVE_LISTENER_CAP) ? { listenerCap: cap(env.SUBWAVE_LISTENER_CAP) } : {}),
    ...(hosted && bitrate(env.SUBWAVE_MAX_BITRATE) ? { maxBitrate: bitrate(env.SUBWAVE_MAX_BITRATE) } : {}),
  };
}

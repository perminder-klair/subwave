// Hosted mode (SUBWAVE_HOSTED): a station run by SUB/WAVE Cloud. The admin
// server pages read it from the env here and hand it to the client sections
// through components/admin/HostedContext.tsx.
//
// Every variable is parsed by the controller's own parser for it
// (controller/src/schemas/hosted.ts, through the generated mirror), so this
// page and the controller can't read one value two ways. The controller is the
// one that warns about a malformed value; here it just reads as unset.
//
// This module must stay free of 'use client': the server pages CALL
// hostedFromEnv, and every export of a client module is a client reference on
// the server, so calling one there throws (a production build shows only
// React error #441, "Panel failed to render").

import type { z } from 'zod';
import {
  hostedFlagSchema,
  hostedHttpsUrlSchema,
  hostedListenerCapSchema,
  hostedMaxBitrateSchema,
} from './schemas.generated';

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

// One variable through its parser: unset, empty or malformed → undefined.
function read<T>(schema: z.ZodType<T, string>, raw: string | undefined): T | undefined {
  if (raw == null || raw.trim() === '') return undefined;
  const parsed = schema.safeParse(raw.trim());
  return parsed.success ? parsed.data : undefined;
}

// The hosted info from this process's env. Only https URLs are passed
// through, so a stray value can't become a javascript: link.
export function hostedFromEnv(env: Record<string, string | undefined>): HostedInfo {
  const hosted = read(hostedFlagSchema, env.SUBWAVE_HOSTED) === true;
  if (!hosted) return { hosted };
  const musicUploadUrl = read(hostedHttpsUrlSchema, env.SUBWAVE_MUSIC_UPLOAD_URL);
  const musicLibraryUrl = read(hostedHttpsUrlSchema, env.SUBWAVE_MUSIC_LIBRARY_URL);
  const listenerCap = read(hostedListenerCapSchema, env.SUBWAVE_LISTENER_CAP);
  const maxBitrate = read(hostedMaxBitrateSchema, env.SUBWAVE_MAX_BITRATE);
  return {
    hosted,
    ...(musicUploadUrl ? { musicUploadUrl } : {}),
    ...(musicLibraryUrl ? { musicLibraryUrl } : {}),
    ...(listenerCap ? { listenerCap } : {}),
    ...(maxBitrate ? { maxBitrate } : {}),
  };
}

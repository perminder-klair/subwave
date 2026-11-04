'use client';

// Hosted mode (SUBWAVE_HOSTED): a station run by SUB/WAVE Cloud. The server
// page reads the env (force-dynamic, so prebuilt images resolve it at runtime)
// and provides it here, so deep sections (library tagger, music source, the
// persona engine picker) can show what the box agent manages without threading
// a prop through every panel. The controller enforces the same rules on save
// (controller/src/setup/hosted.ts); this only decides what to show.

import { createContext, useContext, type ReactNode } from 'react';

export interface HostedInfo {
  hosted: boolean;
  // A hosted music library (Navidrome + upload box run for this station):
  // where its owner uploads and browses. Absent = they bring their own server.
  musicUploadUrl?: string;
  musicLibraryUrl?: string;
}

const HostedContext = createContext<HostedInfo>({ hosted: false });

export function HostedProvider({ value, children }: { value: HostedInfo; children: ReactNode }) {
  return <HostedContext.Provider value={value}>{children}</HostedContext.Provider>;
}

export function useHosted(): HostedInfo {
  return useContext(HostedContext);
}

// Server-side: the hosted info from this process's env. Only https URLs are
// passed through, so a stray value can't become a javascript: link.
export function hostedFromEnv(env: Record<string, string | undefined>): HostedInfo {
  const hosted = ['1', 'true', 'yes'].includes((env.SUBWAVE_HOSTED || '').trim().toLowerCase());
  const url = (v?: string) => (v && /^https:\/\/[^\s"'<>]+$/.test(v.trim()) ? v.trim() : undefined);
  return {
    hosted,
    ...(hosted && url(env.SUBWAVE_MUSIC_UPLOAD_URL) ? { musicUploadUrl: url(env.SUBWAVE_MUSIC_UPLOAD_URL) } : {}),
    ...(hosted && url(env.SUBWAVE_MUSIC_LIBRARY_URL) ? { musicLibraryUrl: url(env.SUBWAVE_MUSIC_LIBRARY_URL) } : {}),
  };
}

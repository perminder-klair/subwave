'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useAdminAuth } from '@/lib/adminAuth';
import {
  personalScrobbleEnabled,
  setPersonalScrobbleEnabled,
  subscribePersonalScrobble,
} from '@/lib/personalScrobble';

const HEARTBEAT_MS = 5_000;

export interface PersonalScrobbleState {
  authenticated: boolean;
  available: boolean | null;
  providers: string[];
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}

export function usePersonalScrobble({
  allowed,
  playbackActive,
}: {
  allowed: boolean;
  playbackActive: boolean;
}): PersonalScrobbleState {
  const { auth, hydrated, adminFetch } = useAdminAuth();
  const enabled = useSyncExternalStore(
    subscribePersonalScrobble,
    personalScrobbleEnabled,
    () => false,
  );
  const [available, setAvailable] = useState<boolean | null>(null);
  const [providers, setProviders] = useState<string[]>([]);
  const playbackIdRef = useRef<string | null>(null);

  const authenticated = allowed && hydrated && auth != null;

  useEffect(() => {
    if (!authenticated) {
      setAvailable(null);
      setProviders([]);
      return;
    }
    let live = true;
    adminFetch('/scrobble/personal', { cache: 'no-store' })
      .then(async response => {
        if (!live || !response.ok) return;
        const body = await response.json() as { available?: boolean; providers?: unknown };
        if (!live) return;
        setAvailable(body.available === true);
        const names: Record<string, string> = {
          lastfm: 'Last.fm',
          listenbrainz: 'ListenBrainz',
        };
        setProviders(Array.isArray(body.providers)
          ? body.providers
            .filter((value): value is string => typeof value === 'string')
            .map(value => names[value] ?? value)
          : []);
      })
      .catch(() => {});
    return () => { live = false; };
  }, [authenticated, adminFetch]);

  useEffect(() => {
    if (!authenticated || !enabled || available !== true || !playbackActive) return;
    if (!playbackIdRef.current) {
      playbackIdRef.current = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID().replaceAll('-', '')
        : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    }
    const playbackId = playbackIdRef.current;
    const report = (state: 'playing' | 'stopped') => {
      void adminFetch('/scrobble/personal', {
        method: 'POST',
        keepalive: true,
        // Capture the credential for cleanup: sign-out removes it from the
        // shared auth store before this effect's stop report runs.
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ playbackId, state }),
      }).catch(() => {});
    };
    report('playing');
    const timer = window.setInterval(() => report('playing'), HEARTBEAT_MS);
    return () => {
      window.clearInterval(timer);
      report('stopped');
    };
  }, [authenticated, enabled, available, playbackActive, adminFetch, auth]);

  return {
    authenticated,
    available,
    providers,
    enabled,
    setEnabled: setPersonalScrobbleEnabled,
  };
}

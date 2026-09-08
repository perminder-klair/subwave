// Community stations directory client: the curated list the web app publishes
// at `${directoryUrl}/stations.json`, so a fresh installer can browse without
// knowing a URL. The origin defaults to the featured station's web origin and
// is overridable via app.json `extra.directoryUrl`.

import Constants from 'expo-constants';
import { featuredStation } from './station';

/** Mirrors the web `Station` interface; lat/lon are dropped (no map in app). */
export interface DirectoryStation {
  slug: string;
  name: string;
  url: string;
  location?: string;
  country?: string;
  operator?: string;
  genre?: string;
  description?: string;
  featured?: boolean;
  submitted?: string;
}

// Independent of lib/api's timeout: a hung directory origin must not stall the
// Stations screen.
const FETCH_TIMEOUT_MS = 8000;

export function directoryUrl(): string {
  const extra = Constants.expoConfig?.extra as { directoryUrl?: string } | undefined;
  return (extra?.directoryUrl || featuredStation().url).replace(/\/+$/, '');
}

/** The published directory, or [] on any failure (the section just hides). */
export async function fetchDirectory(signal?: AbortSignal): Promise<DirectoryStation[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort);
  }
  try {
    const res = await fetch(`${directoryUrl()}/stations.json`, {
      cache: 'no-store',
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as unknown;
    return Array.isArray(data) ? (data as DirectoryStation[]) : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

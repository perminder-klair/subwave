// Directory origin defaults to the featured station; app.json extra.directoryUrl overrides it.

import Constants from 'expo-constants';
import { readDirectory } from './directory-read';
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

export function directoryUrl(): string {
  const extra = Constants.expoConfig?.extra as { directoryUrl?: string } | undefined;
  return (extra?.directoryUrl || featuredStation().url).replace(/\/+$/, '');
}

/** The published directory, or [] on any failure (the section just hides). */
export function fetchDirectory(signal?: AbortSignal): Promise<DirectoryStation[]> {
  return readDirectory(() => `${directoryUrl()}/stations.json`, signal);
}

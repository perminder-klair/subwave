// The read behind fetchDirectory, apart from directory.ts so it runs without
// Expo's native modules: the deadline and the abort are api.ts's, and only the
// budget is this read's own.

import { FETCH_TIMEOUT_MS, fetchWithTimeout, readJson } from './api';
import type { DirectoryStation } from './directory';

/** The list at `url()`, or [] on any failure. Headers and body share one
 *  FETCH_TIMEOUT_MS, where a station call gets that much for each, so the
 *  Stations screen and onboarding never wait past it for their Discover rows.
 *  It carries no Station login: the directory is public, on its own origin. */
export async function readDirectory(url: () => string, signal?: AbortSignal): Promise<DirectoryStation[]> {
  const startedAt = Date.now();
  try {
    const res = await fetchWithTimeout(url(), { cache: 'no-store', signal });
    if (!res.ok) return [];
    const data = await readJson(res, FETCH_TIMEOUT_MS - (Date.now() - startedAt));
    return Array.isArray(data) ? (data as DirectoryStation[]) : [];
  } catch {
    return [];
  }
}

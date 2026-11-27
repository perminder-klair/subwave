// History lists plays, not tracks, while the Library selection is a set of
// track ids (HistoryTab.tsx). Pure, so the rule is tested without a browser.
import type { PlayEntry } from './types';

// The page's tickable tracks, once each and in page order: a track aired twice
// on the page is one track to select, and a play with no track id has none.
// `toTrack` is the tab's own play-to-Track mapping.
export function historyPageTracks<T>(rows: readonly PlayEntry[] | null, toTrack: (p: PlayEntry) => T): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const p of rows || []) {
    if (!p.trackId || seen.has(p.trackId)) continue;
    seen.add(p.trackId);
    out.push(toTrack(p));
  }
  return out;
}

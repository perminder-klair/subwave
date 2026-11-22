// What jingles.m3u holds: the mixer-counted rotate's draw list, which is the
// on-air show's jingle list (#2367). Pure, so the one writer (jingles.ts
// rewritePlaylist) and its tests share one rule.
//
// The list rule is allowedForShow's, the one every automatic draw uses: an
// empty or absent list is every jingle, so a station without lists writes the
// bytes it always wrote; a non-empty list is strict, and one that matches
// nothing writes an EMPTY file. The mixer handles that as it handles a station
// with no jingles at all: the rotate skips the unavailable source and music
// keeps flowing (measured, scripts/liquidsoap-jingle-swap.py `empty`). Unlike
// the controller-counted rotate, which spends a skipped slot, the mixer banks
// it: the stinger it skipped airs at the first seam after a list returns.
//
// The library order is the sidecar's key order, unfiltered by what is on disk,
// exactly as before: the mixer resolves each line and skips one it cannot.

import { allowedForShow } from './show-allowlist.js';

export function rotatePlaylistFilenames(
  library: readonly string[],
  allowlist: readonly string[] | undefined,
): string[] {
  return allowedForShow([...library], allowlist, f => f);
}

// The exact bytes of jingles.m3u: one absolute path per line, a trailing
// newline only when there is a line.
export function rotatePlaylistText(dir: string, filenames: readonly string[]): string {
  const lines = filenames.map(f => `${dir}/${f}`);
  return lines.join('\n') + (lines.length ? '\n' : '');
}

export interface RotatePlaylistView {
  // Jingles in the library (the sidecar's keys).
  library: number;
  // Lines the on-air show's list leaves in the file.
  playlist: number;
  // Whether a show's list is filtering the library.
  filtered: boolean;
}

// For doctor: how the file relates to the library, so an empty file is told
// apart from an empty library.
export function rotatePlaylistView(
  library: readonly string[],
  allowlist: readonly string[] | undefined,
): RotatePlaylistView {
  return {
    library: library.length,
    playlist: rotatePlaylistFilenames(library, allowlist).length,
    filtered: !!allowlist?.length,
  };
}

// AI SDK tool library — the music-discovery tools the picker agent calls to
// explore the library before choosing the next track.
//
// One tool per file under `tools/`, each declaring its own `available` gate.
// This module is the registry: it holds the ORDER the model sees them in and
// nothing else. Adding a tool is adding a file plus a line here; a tool's
// availability rule lives with the tool, because it is a fact about that tool.
//
// Every tool returns a slim song list (see slim.ts) so the model has stable ids
// to reference and enough signal to reason about flow. `buildPickerTools`
// returns the `seen` Map that accumulates every song any tool surfaced, so the
// picker can resolve the agent's chosen id back to a full track object.
//
// The whole pick's constraints arrive as ONE `PickerScope` value and are never
// re-listed field-by-field on the way in — see the note at the top of scope.ts
// for the defect class that shape exists to close.
//
// `recentIds`/`recentKeys` are filtered out inside every tool (via the shared
// collect()) so the agent never has to be told "avoid these" — it simply can't
// see them. We deliberately do NOT filter by recent *artist*: the similarity
// tools (similarSongs, tracksTowardJourney, tracks*LikeThis) return tracks
// clustered around what's currently playing — i.e. the just-played artist's
// neighbours — so an artist-recency strip gutted them to ~1 result while the
// 12h track guard already prevents literal repeats (issue: thin picker pools on
// niche catalogues). Track-recency alone is enough here; back-to-back artist
// variety is enforced downstream at the point of choice, in
// dj-agent.pickViaAgent (re-pick off the on-air artist when possible, #1124),
// so the tools can keep surfacing same-artist neighbours for the model to weigh.

import type { ToolSet } from 'ai';
import { buildPickerContext, pickerScope, type PickerScope } from './scope.js';
import type { PickerToolModule } from './defs.js';

import searchLibrary from './tools/search-library.js';
import similarSongs from './tools/similar-songs.js';
import topSongsByArtist from './tools/top-songs-by-artist.js';
import recentByArtist from './tools/recent-by-artist.js';
import songsByGenre from './tools/songs-by-genre.js';
import tracksByMood from './tools/tracks-by-mood.js';
import tracksByEnergy from './tools/tracks-by-energy.js';
import tracksLikeThis from './tools/tracks-like-this.js';
import tracksThatSoundLikeThis from './tools/tracks-that-sound-like-this.js';
import searchByLyrics from './tools/search-by-lyrics.js';
import searchBySound from './tools/search-by-sound.js';
import deepCuts from './tools/deep-cuts.js';
import recentlyAdded from './tools/recently-added.js';
import starredSongs from './tools/starred-songs.js';
import randomSongs from './tools/random-songs.js';
import showPlaylistTracks from './tools/show-playlist-tracks.js';
import episodeArtistTracks from './tools/episode-artist-tracks.js';
import tracksTowardJourney from './tools/tracks-toward-journey.js';
import identifyRequestedTrack from './tools/identify-requested-track.js';

// Registration order — this is the order the model sees the tools in, so keep
// it stable rather than alphabetising: it matches the historical object literal.
export const PICKER_TOOLS: readonly PickerToolModule[] = [
  searchLibrary,
  similarSongs,
  topSongsByArtist,
  recentByArtist,
  songsByGenre,
  tracksByMood,
  tracksByEnergy,
  tracksLikeThis,
  tracksThatSoundLikeThis,
  searchByLyrics,
  searchBySound,
  deepCuts,
  recentlyAdded,
  starredSongs,
  randomSongs,
  showPlaylistTracks,
  episodeArtistTracks,
  tracksTowardJourney,
  identifyRequestedTrack,
];

export { pickerScope };
export type { PickerScope, PickerContext } from './scope.js';
export type { PickerToolModule } from './defs.js';

// Builds a fresh tool set scoped to one pick. Takes the scope whole — callers
// pass the object through, never its fields.
export function buildPickerTools(scope: Partial<PickerScope> = {}): { tools: ToolSet; seen: Map<string, any> } {
  const ctx = buildPickerContext(pickerScope(scope));
  const tools: ToolSet = {};
  for (const mod of PICKER_TOOLS) {
    if (mod.available && !mod.available(ctx)) continue;
    tools[mod.name] = mod.build(ctx);
  }
  return { tools, seen: ctx.seen };
}

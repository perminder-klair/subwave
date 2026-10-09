// Register tools in model-visible order; each owns its availability gate.
// Tools return slim tracks and accumulate full tracks in seen for final id resolution.
// Pass constraints as PickerScope (see scope.ts). Filter recent tracks, not artists:
// artist filtering depleted niche similarity pools. Artist variety is enforced at
// pickViaSelectionRoute's final choice (#1124).

import type { ToolSet } from 'ai';
import { buildPickerContext, pickerScope, type PickerScope } from './scope.js';
import { withToolDeadline, type PickerToolModule } from './defs.js';

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
import listenerFavourites from './tools/listener-favourites.js';
import randomSongs from './tools/random-songs.js';
import showPlaylistTracks from './tools/show-playlist-tracks.js';
import episodeArtistTracks from './tools/episode-artist-tracks.js';
import tracksTowardJourney from './tools/tracks-toward-journey.js';
import identifyRequestedTrack from './tools/identify-requested-track.js';
import songsByEra from './tools/songs-by-era.js';
import sonicSimilarTracks from './tools/sonic-similar-tracks.js';

import frequentAlbums from './tools/frequent-albums.js';
import moodPlaylistTracks from './tools/mood-playlist-tracks.js';
import similarArtistTracks from './tools/similar-artist-tracks.js';
import moodWildcard from './tools/mood-wildcard.js';

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
  listenerFavourites,
  randomSongs,
  showPlaylistTracks,
  episodeArtistTracks,
  tracksTowardJourney,
  identifyRequestedTrack,
  songsByEra,
  sonicSimilarTracks,
  frequentAlbums,
  moodPlaylistTracks,
  similarArtistTracks,
  moodWildcard,
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
    tools[mod.name] = withToolDeadline(mod.name, mod.build(ctx));
  }
  return { tools, seen: ctx.seen };
}

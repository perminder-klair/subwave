// The community SHOW catalog lives in the `subwave-community` repo and is fetched
// live (community/registry.ts). A shareable show carries only portable substance
// — a brief (topic) + music-steering filters (moods/genres/eras/energy) + mode
// flags (programme/banter/segmentSkill). Every install-specific field (host
// persona + guests, theme, playlist anchors, weekly schedule slot) is re-bound by
// the install route (routes/shows.ts POST /shows/community/:slug/install).
//
// This module re-exports the CommunityShow type + accessors so routes import from
// a stable path, mirroring skills/loader.ts + personas/community.ts.
export type { CommunityShow } from '../community/registry.js';
export {
  communityShows as listCommunityShows,
  readCommunityShow,
} from '../community/registry.js';

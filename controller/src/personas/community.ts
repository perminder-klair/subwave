// The community DJ-persona catalog now lives in the `community` repo and
// is fetched live (community/registry.ts) — it is no longer a dir COPYd into the
// controller image. This module re-exports the CommunityPersona type + the
// list/read accessors so routes/personas.ts, routes/public.ts, and the admin UI
// keep importing them from here unchanged.
//
// A community persona carries only portable knobs (displayName, tagline, soul,
// frequency, scriptLength, tone dials, language) + provenance. Station-specific
// fields (id, tts, avatar, skills) are applied by the install route
// (routes/personas.ts POST /personas/community/:slug/install).
export type { CommunityPersona } from '../community/registry.js';
export {
  communityPersonas as listCommunityPersonas,
  readCommunityPersona,
} from '../community/registry.js';

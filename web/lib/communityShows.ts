// Server-side lookup of the shipped community show catalog, used by the public
// /shows showcase page. Mirrors lib/communitySkills.ts: it runs in the Next.js
// server (the `web` container in prod), NOT the browser, so it reaches the
// controller directly over the internal compose network rather than through the
// browser's `/api` Caddy route.
//   CONTROLLER_INTERNAL_URL (set on the web service in both prod composes)
//   → http://localhost:7701 (dev fallback: `npm run dev` web runs on the host
//     and the dev compose binds the controller on 7701).
const CONTROLLER_BASE = (
  process.env.CONTROLLER_INTERNAL_URL || 'http://localhost:7701'
).replace(/\/$/, '');

// One era window in a show's music filters. Mirrors the controller's EraWindow
// (community/registry.ts): either bound may be null (open-ended).
export interface EraWindow {
  fromYear: number | null;
  toYear: number | null;
}

// One entry in the shipped community catalog (GET /shows/community). Mirrors the
// controller's CommunityShow (community/registry.ts) — the portable substance
// only (brief + music-steering filters + mode flags), minus install-specific
// bindings. The showcase is browse-only and station-agnostic.
export interface CommunityShow {
  slug: string;
  name: string; // the show's title
  topic: string; // the produced-show brief
  moods: string[];
  genres: string[];
  eras: EraWindow[];
  energies: string[];
  filtersStrict: boolean;
  banter: boolean;
  programme: boolean;
  segmentSkill: string;
  maxTrackSeconds: number | null;
  // Provenance stamped by the submission workflow — absent on hand-added or
  // pre-provenance entries, so every consumer must degrade gracefully.
  submittedBy?: string; // GitHub login of the contributor who submitted it
  dateAdded?: string; // ISO date (YYYY-MM-DD) it first entered the catalog
  dateModified?: string; // ISO date (YYYY-MM-DD) of the last catalog change
}

interface CommunityResponse {
  community?: CommunityShow[];
}

// Fetch the shipped community catalog from the controller. Returns [] on any
// failure (controller down, timeout, non-OK, malformed) so the showcase page
// renders its empty state instead of throwing.
export async function fetchCommunityShows(): Promise<CommunityShow[]> {
  try {
    const res = await fetch(`${CONTROLLER_BASE}/shows/community`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as CommunityResponse;
    return Array.isArray(data?.community) ? data.community : [];
  } catch {
    return [];
  }
}

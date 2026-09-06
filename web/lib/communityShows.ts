// Server-side lookup of the shipped community show catalog for /shows. Mirrors
// lib/communitySkills.ts: runs in the Next.js server, NOT the browser, so it
// reaches the controller over the internal compose network
// (CONTROLLER_INTERNAL_URL) rather than the browser's `/api` Caddy route.
// Falls back to http://localhost:7701 for dev.
const CONTROLLER_BASE = (
  process.env.CONTROLLER_INTERNAL_URL || 'http://localhost:7701'
).replace(/\/$/, '');

// Mirrors the controller's EraWindow; either bound may be null (open-ended).
export interface EraWindow {
  fromYear: number | null;
  toYear: number | null;
}

// One entry from GET /shows/community. Mirrors the controller's CommunityShow,
// carrying the portable substance only, minus install-specific bindings.
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
  minTrackLengthSeconds: number | null;
  // Stamped by the submission workflow. Absent on hand-added or pre-provenance
  // entries, so consumers must degrade gracefully.
  submittedBy?: string; // GitHub login of the contributor who submitted it
  dateAdded?: string; // ISO date (YYYY-MM-DD) it first entered the catalog
  dateModified?: string; // ISO date (YYYY-MM-DD) of the last catalog change
}

interface CommunityResponse {
  community?: CommunityShow[];
}

// Returns [] on any failure so the showcase page renders its empty state
// instead of throwing.
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

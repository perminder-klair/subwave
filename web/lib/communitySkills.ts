// Server-side lookup of the shipped community skill catalog, used by the public
// /skills showcase page. Mirrors lib/station.ts: it runs in the Next.js server
// (the `web` container in prod), NOT the browser, so it reaches the controller
// directly over the internal compose network rather than through the browser's
// `/api` Caddy route.
//   CONTROLLER_INTERNAL_URL (set on the web service in both prod composes)
//   → http://localhost:7701 (dev fallback: `npm run dev` web runs on the host
//     and the dev compose binds the controller on 7701).
const CONTROLLER_BASE = (
  process.env.CONTROLLER_INTERNAL_URL || 'http://localhost:7701'
).replace(/\/$/, '');

// One entry in the shipped community catalog (GET /skills/community). Mirrors
// the controller's CommunitySkill (skills/loader.ts) minus per-station install
// state — the showcase is browse-only and station-agnostic.
export interface CommunitySkill {
  slug: string;
  label: string;
  brief: string; // the agent's brief (SKILL.md body)
  cooldown?: string; // e.g. "6h" — the frontmatter value, verbatim
  window?: 'any' | 'commute';
  context?: string; // comma-separated "right now" fields
  // Provenance stamped by the submission workflow — absent on hand-added or
  // pre-provenance entries, so every consumer must degrade gracefully.
  submittedBy?: string; // GitHub login of the contributor who submitted it
  dateAdded?: string; // ISO date (YYYY-MM-DD) it first entered the catalog
  dateModified?: string; // ISO date (YYYY-MM-DD) of the last catalog change
}

interface CommunityResponse {
  community?: CommunitySkill[];
}

// Fetch the shipped community catalog from the controller. Returns [] on any
// failure (controller down, timeout, non-OK, malformed) so the showcase page
// renders its empty state instead of throwing.
export async function fetchCommunitySkills(): Promise<CommunitySkill[]> {
  try {
    const res = await fetch(`${CONTROLLER_BASE}/skills/community`, {
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

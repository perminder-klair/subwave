// Server-side lookup of the shipped community skill catalog for /skills.
// Mirrors lib/station.ts: runs in the Next.js server, NOT the browser, so it
// reaches the controller over the internal compose network
// (CONTROLLER_INTERNAL_URL) rather than the browser's `/api` Caddy route.
// Falls back to http://localhost:7701 for dev.
const CONTROLLER_BASE = (
  process.env.CONTROLLER_INTERNAL_URL || 'http://localhost:7701'
).replace(/\/$/, '');

// One entry from GET /skills/community. Mirrors the controller's CommunitySkill
// minus per-station install state.
export interface CommunitySkill {
  slug: string;
  label: string;
  brief: string; // the agent's brief (SKILL.md body)
  cooldown?: string; // e.g. "6h" — the frontmatter value, verbatim
  window?: 'any' | 'commute';
  context?: string; // comma-separated "right now" fields
  feed?: string; // RSS/Atom URL the skill reads before it speaks
  // Stamped by the submission workflow. Absent on hand-added or pre-provenance
  // entries, so consumers must degrade gracefully.
  submittedBy?: string; // GitHub login of the contributor who submitted it
  dateAdded?: string; // ISO date (YYYY-MM-DD) it first entered the catalog
  dateModified?: string; // ISO date (YYYY-MM-DD) of the last catalog change
}

interface CommunityResponse {
  community?: CommunitySkill[];
}

// Returns [] on any failure so the showcase page renders its empty state
// instead of throwing.
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

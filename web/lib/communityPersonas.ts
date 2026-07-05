// Server-side lookup of the shipped community persona catalog, used by the
// public /personas showcase page. Mirrors lib/communitySkills.ts: it runs in
// the Next.js server (the `web` container in prod), NOT the browser, so it
// reaches the controller directly over the internal compose network rather
// than through the browser's `/api` Caddy route.
//   CONTROLLER_INTERNAL_URL (set on the web service in both prod composes)
//   → http://localhost:7701 (dev fallback: `npm run dev` web runs on the host
//     and the dev compose binds the controller on 7701).
const CONTROLLER_BASE = (
  process.env.CONTROLLER_INTERNAL_URL || 'http://localhost:7701'
).replace(/\/$/, '');

// One entry in the shipped community catalog (GET /personas/community).
// Mirrors the controller's CommunityPersona (personas/community.ts) — the
// showcase is browse-only and station-agnostic.
export interface CommunityPersona {
  slug: string;
  displayName: string; // the DJ's on-air name
  tagline?: string;
  soul: string; // the character prose (PERSONA.md body)
  frequency: 'quiet' | 'moderate' | 'aggressive';
  scriptLength: 'concise' | 'extended';
  djMode: boolean;
  humour?: number; // tone dials 0-10; absent = neutral
  localColour?: number;
  warmth?: number;
  language?: string;
  // Provenance stamped by the submission workflow — absent on hand-added
  // entries, so every consumer must degrade gracefully.
  submittedBy?: string; // GitHub login of the contributor who submitted it
  dateAdded?: string; // ISO date (YYYY-MM-DD) it first entered the catalog
  dateModified?: string; // ISO date (YYYY-MM-DD) of the last catalog change
}

interface CommunityResponse {
  community?: CommunityPersona[];
}

// Fetch the shipped community catalog from the controller. Returns [] on any
// failure (controller down, timeout, non-OK, malformed) so the showcase page
// renders its empty state instead of throwing.
export async function fetchCommunityPersonas(): Promise<CommunityPersona[]> {
  try {
    const res = await fetch(`${CONTROLLER_BASE}/personas/community`, {
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

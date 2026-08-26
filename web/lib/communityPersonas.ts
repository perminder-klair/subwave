// Server-side lookup of the shipped community persona catalog for /personas.
// Mirrors lib/communitySkills.ts: runs in the Next.js server, NOT the browser,
// so it reaches the controller over the internal compose network
// (CONTROLLER_INTERNAL_URL) rather than the browser's `/api` Caddy route.
// Falls back to http://localhost:7701 for dev.
const CONTROLLER_BASE = (
  process.env.CONTROLLER_INTERNAL_URL || 'http://localhost:7701'
).replace(/\/$/, '');

// One entry from GET /personas/community. Mirrors the controller's
// CommunityPersona.
export interface CommunityPersona {
  slug: string;
  displayName: string; // the DJ's on-air name
  tagline?: string;
  soul: string; // the character prose (PERSONA.md body)
  frequency: 'silent' | 'quiet' | 'moderate' | 'chatty' | 'aggressive';
  scriptLength: 'one-liner' | 'concise' | 'extended' | 'storyteller';
  djMode: boolean;
  linkStyle?: 'natural' | 'announce';
  humour?: number; // tone dials 0-10; absent = neutral
  localColour?: number;
  warmth?: number;
  language?: string;
  // Stamped by the submission workflow. Absent on hand-added entries, so
  // consumers must degrade gracefully.
  submittedBy?: string; // GitHub login of the contributor who submitted it
  dateAdded?: string; // ISO date (YYYY-MM-DD) it first entered the catalog
  dateModified?: string; // ISO date (YYYY-MM-DD) of the last catalog change
}

interface CommunityResponse {
  community?: CommunityPersona[];
}

// Returns [] on any failure so the showcase page renders its empty state
// instead of throwing.
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

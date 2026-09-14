// Loader for the community catalog index (catalog.json), so the public station
// directory refreshes without a web redeploy. Server-side only. 30-min ISR
// revalidate (matches the controller's catalog TTL), memoised per render, and
// degrades to an EMPTY catalog on any failure. COMMUNITY_CATALOG_URL overrides
// the source; the default is raw GitHub.
const CATALOG_URL =
  process.env.COMMUNITY_CATALOG_URL ||
  'https://raw.githubusercontent.com/getsubwave/community/main/catalog.json';

export interface CommunityCatalog {
  skills: Record<string, unknown>[];
  personas: Record<string, unknown>[];
  shows: Record<string, unknown>[];
  stations: Record<string, unknown>[];
  apps: Record<string, unknown>[];
}

const EMPTY: CommunityCatalog = { skills: [], personas: [], shows: [], stations: [], apps: [] };

const arr = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? (v as Record<string, unknown>[]) : [];

export async function fetchCommunityCatalog(): Promise<CommunityCatalog> {
  try {
    const res = await fetch(CATALOG_URL, {
      signal: AbortSignal.timeout(8000),
      next: { revalidate: 1800 },
    });
    if (!res.ok) throw new Error(`community catalog HTTP ${res.status}`);
    const data = (await res.json()) as Record<string, unknown>;
    return {
      skills: arr(data.skills),
      personas: arr(data.personas),
      shows: arr(data.shows),
      stations: arr(data.stations),
      // `apps` postdates the other four; arr() maps a missing key to [], so an
      // older catalog is an empty directory rather than a crash.
      apps: arr(data.apps),
    };
  } catch {
    return EMPTY;
  }
}

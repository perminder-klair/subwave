// Build-/render-time loader for the community catalog index (catalog.json)
// published by the subwave-community repo. The public station directory
// (/stations + /stations.json) sources its data from here instead of the old
// local web/content/stations files, so the community station list refreshes
// without a web redeploy.
//
// Server-side only. Fetched with a 30-min ISR revalidate (matches the
// controller's catalog TTL) and memoised per render, and it degrades to an
// EMPTY catalog on any failure (unreachable host, non-200, bad JSON, timeout)
// so the build/page never breaks on a network blip — same posture as the old
// "no content dir → empty" fallback.
//
// Override the source with COMMUNITY_CATALOG_URL (build env); the default is the
// jsDelivr mirror of the community repo, CDN-cached and rate-limit-free.
const CATALOG_URL =
  process.env.COMMUNITY_CATALOG_URL ||
  'https://cdn.jsdelivr.net/gh/getsubwave/subwave-community@main/catalog.json';

export interface CommunityCatalog {
  skills: Record<string, unknown>[];
  personas: Record<string, unknown>[];
  shows: Record<string, unknown>[];
  stations: Record<string, unknown>[];
}

const EMPTY: CommunityCatalog = { skills: [], personas: [], shows: [], stations: [] };

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
    };
  } catch {
    return EMPTY;
  }
}

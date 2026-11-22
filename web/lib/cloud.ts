// The paid side of the project (DJ Brain, hosted stations) lives in
// subwave-brain, behind the portal at my.getsubwave.com. This site only
// describes it and links there: checkout, accounts and keys stay on the portal.
//
// Prices come from the brain's public catalog (GET /public/plans), so this page
// never carries its own copy to drift. A failed or malformed read degrades to
// a page without prices, never to an error: the page still links to the
// portal's pricing, which is authoritative.
export const PORTAL_URL = 'https://my.getsubwave.com';
export const PORTAL_PRICING_URL = `${PORTAL_URL}/pricing`;
export const PORTAL_WAITLIST_URL = `${PORTAL_URL}/waitlist`;

export type CloudPlan = {
  tier: string;
  name: string;
  usd: { month: number; year: number };
  annual: boolean;
  voiceHours: number;
  storageGb?: number;
  listeningHours?: number;
};

export type CloudCatalog = { brain: CloudPlan[]; hosted: CloudPlan[] };

const FETCH_TIMEOUT_MS = 3000;
const REVALIDATE_S = 3600;

function isPlan(v: unknown): v is CloudPlan {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  const usd = p.usd as Record<string, unknown> | undefined;
  return (
    typeof p.tier === 'string' &&
    typeof p.name === 'string' &&
    !!usd &&
    typeof usd.month === 'number' &&
    typeof usd.year === 'number' &&
    typeof p.voiceHours === 'number'
  );
}

async function getJson(path: string): Promise<unknown> {
  try {
    const res = await fetch(`${PORTAL_URL}${path}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      next: { revalidate: REVALIDATE_S },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function getCloudCatalog(): Promise<CloudCatalog | null> {
  const body = (await getJson('/public/plans')) as Record<string, unknown> | null;
  if (!body || !Array.isArray(body.brain) || !Array.isArray(body.hosted)) return null;
  const brain = body.brain.filter(isPlan);
  const hosted = body.hosted.filter(isPlan);
  if (brain.length === 0 && hosted.length === 0) return null;
  return { brain, hosted };
}

// Whether a hosted checkout can start. Unknown counts as open, as the brain's
// own /public/status does: the portal's checkout gate is authoritative, and
// the worst case is one click onto its waitlist message.
export async function hostedSignupsOpen(): Promise<boolean> {
  const body = (await getJson('/public/status')) as Record<string, unknown> | null;
  if (!body) return true;
  return body.acceptingSignups !== false && body.signupsPaused !== true;
}

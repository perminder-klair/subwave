// Server-side station identity lookup, used by the force-dynamic homepage's
// generateMetadata() to personalise the share-card preview (issue #272).
//
// This runs in the Next.js server (the `web` container in prod), NOT the
// browser, so it cannot use NEXT_PUBLIC_API_URL — that resolves to `/api`, a
// browser-relative path routed through Caddy. Instead reach the controller
// directly over the internal compose network:
//   CONTROLLER_INTERNAL_URL (set on the web service in both prod composes)
//   → http://localhost:7701 (dev fallback: `npm run dev` web runs on the host
//     and the dev compose binds the controller on 7701).
const CONTROLLER_BASE = (
  process.env.CONTROLLER_INTERNAL_URL || 'http://localhost:7701'
).replace(/\/$/, '');

export interface StationIdentity {
  station: string;
  tagline: string;
}

// Fetch the operator's station name + DJ tagline from the controller's public
// /dj endpoint. Returns null on any failure (controller down, timeout, non-OK)
// so the caller can fall back to the generic SUB/WAVE branding — the preview
// must never break.
export async function fetchStationIdentity(): Promise<StationIdentity | null> {
  try {
    const res = await fetch(`${CONTROLLER_BASE}/dj`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      station: typeof data?.station === 'string' ? data.station : '',
      tagline: typeof data?.tagline === 'string' ? data.tagline : '',
    };
  } catch {
    return null;
  }
}

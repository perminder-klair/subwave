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
  stationDescription: string;
  tagline: string;
}

// The product name — also the default value of the controller's
// `settings.station`, so an un-personalised install reports this verbatim.
export const DEFAULT_STATION = 'SUB/WAVE';

// Fetch the operator's station name, station-level description and DJ tagline
// from the controller's public /dj endpoint. Returns null on any failure
// (controller down, timeout, non-OK) so the caller can fall back to the generic
// SUB/WAVE branding — the preview must never break.
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
      stationDescription:
        typeof data?.stationDescription === 'string' ? data.stationDescription : '',
      tagline: typeof data?.tagline === 'string' ? data.tagline : '',
    };
  } catch {
    return null;
  }
}

export interface StationMeta {
  name: string;
  description: string;
}

// Resolve the share-card name + description for a player route. Returns null
// when there is nothing operator-specific to say, so callers keep whatever
// generic SUB/WAVE copy they already ship.
//
// Description precedence (issue #1086):
//   1. settings.stationDescription — station-level, persona-independent. What a
//      shared link *should* say, and stable whoever is on air.
//   2. the active persona's tagline — only when `allowPersonaTagline`.
//   3. a generated sentence naming the station.
//
// `allowPersonaTagline` exists because rung 2 is the very drift #1086 reports:
// the tagline changes with whoever is on air, so a link shared at noon and one
// shared at midnight describe the station differently. It is NOT a good default
// — it is back-compat. The homepage opts in because issue #272 already shipped
// tagline-personalised previews there and silently downgrading those installs
// to a generated sentence would be a visible regression. Routes that never had
// it (/listen) leave it off, so they are persona-independent from day one.
export async function fetchStationMeta(
  { allowPersonaTagline = false }: { allowPersonaTagline?: boolean } = {},
): Promise<StationMeta | null> {
  const id = await fetchStationIdentity();
  const station = id?.station?.trim() || '';
  const stationDescription = id?.stationDescription?.trim() || '';
  const tagline = allowPersonaTagline ? id?.tagline?.trim() || '' : '';

  // Nothing to personalise: no station (or still the default product name) and
  // no usable description source → behave as an un-personalised install.
  const named = station && station !== DEFAULT_STATION;
  if (!named && !stationDescription && !tagline) return null;

  const name = station || DEFAULT_STATION;
  return {
    name,
    description:
      stationDescription ||
      tagline ||
      `Tune in to ${name} — one live stream, with an AI DJ picking tracks and talking between them.`,
  };
}

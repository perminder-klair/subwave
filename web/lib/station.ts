// Server-side station identity lookup for the homepage's generateMetadata()
// share-card preview (#272). Runs in the Next.js server, so it cannot use
// NEXT_PUBLIC_API_URL (a browser-relative `/api`); it reaches the controller
// over the internal compose network.
const CONTROLLER_BASE = (
  process.env.CONTROLLER_INTERNAL_URL || 'http://localhost:7701'
).replace(/\/$/, '');

export interface StationIdentity {
  station: string;
  stationDescription: string;
  tagline: string;
}

// Also the default of the controller's `settings.station`, so an
// un-personalised install reports this verbatim.
export const DEFAULT_STATION = 'SUB/WAVE';

// Returns null on any failure so the caller falls back to generic SUB/WAVE
// branding. The preview must never break.
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

// Returns null when there's nothing operator-specific to say, so callers keep
// their generic SUB/WAVE copy.
//
// Description precedence (#1086): settings.stationDescription, then the active
// persona's tagline (only when `allowPersonaTagline`), then a generated
// sentence naming the station. `allowPersonaTagline` is back-compat only — it
// makes the preview vary by time of day — so only the homepage opts in.
export async function fetchStationMeta(
  { allowPersonaTagline = false }: { allowPersonaTagline?: boolean } = {},
): Promise<StationMeta | null> {
  const id = await fetchStationIdentity();
  const station = id?.station?.trim() || '';
  const stationDescription = id?.stationDescription?.trim() || '';
  const tagline = allowPersonaTagline ? id?.tagline?.trim() || '' : '';

  // No station (or still the default product name) and no usable description:
  // behave as an un-personalised install.
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

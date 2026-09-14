// What the icecast render decided about trusted reverse proxies (#1613), as
// pure decision logic. Split from the reader so it can be tested without
// config.js / node:fs.
//
// Icecast's only peer is the edge, so admin -> Listeners shows the proxy's
// container address unless <x-forwarded-for> names that proxy. The marker
// (state/trusted-proxies.json, written by docker/broadcast-entrypoint.sh and
// the AIO supervisor's render_icecast) is how that decision reaches the admin
// console. Every ambiguous input resolves to UNKNOWN, which renders nothing —
// degrading to the unexplained peer address beats a hint that guesses.

export interface TrustedProxyState {
  /** False when no usable marker exists: an older broadcast image, a state dir
   *  the render could not write, or a pair that has never rendered. Callers
   *  must show nothing rather than infer a miss from it. */
  known: boolean;
  /** Addresses that reached icecast.xml. 0 is the reported symptom. */
  count: number;
  /** Which knob produced the candidates (`ICECAST_TRUSTED_PROXY_IPS`,
   *  `ICECAST_TRUSTED_PROXY_HOSTS`, `aio-loopback`), null when unknown. */
  source: string | null;
  proxies: string[];
  /** Entries the render refused. icecast-KH matches an EXACT IP, so a CIDR is
   *  accepted and then silently never matches. */
  dropped: string[];
}

const UNKNOWN: TrustedProxyState = {
  known: false, count: 0, source: null, proxies: [], dropped: [],
};

/** This parses a file on disk, so anything outside the charset icecast accepts
 *  is dropped rather than rendered into the console. */
const SAFE = /^[0-9A-Za-z.:/_-]{1,48}$/;

function strings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string' && SAFE.test(v));
}

/**
 * Read the parsed trusted-proxies.json (or null) into a verdict.
 * Absent, malformed or self-contradicting → UNKNOWN.
 */
export function trustedProxyState(marker: unknown): TrustedProxyState {
  if (!marker || typeof marker !== 'object') return UNKNOWN;
  const m = marker as { count?: unknown; source?: unknown; proxies?: unknown; dropped?: unknown };

  // The count is the load-bearing field — a marker without one says nothing.
  if (typeof m.count !== 'number' || !Number.isInteger(m.count) || m.count < 0) return UNKNOWN;
  const source = typeof m.source === 'string' && SAFE.test(m.source) ? m.source : null;
  if (source === null) return UNKNOWN;

  const proxies = strings(m.proxies);
  // A count disagreeing with its list means a writer this reader does not
  // understand; either half would contradict the config icecast is running.
  if (proxies.length !== m.count) return UNKNOWN;

  return { known: true, count: m.count, source, proxies, dropped: strings(m.dropped) };
}

/** Whether the Listeners table should explain itself. True only when the render
 *  actually reported a problem: nothing trusted (so every row is the edge), or
 *  something the operator configured was thrown away. */
export function needsTrustedProxyHint(s: TrustedProxyState): boolean {
  return s.known && (s.count === 0 || s.dropped.length > 0);
}

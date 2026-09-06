// What the icecast render decided about trusted reverse proxies (#1613) —
// pure decision logic.
//
// Split from the reader (trusted-proxies.ts) so scripts/trusted-proxies.test.ts
// can pin it without dragging in config.js / node:fs, the same split as
// music-starve-pure.ts.
//
// Icecast's only peer is the edge, so admin -> Listeners shows the proxy's
// container address unless <x-forwarded-for> names that proxy. On the bundled
// Caddy that resolves by DNS; on docker-compose.byo.yml there is no `caddy`
// service to resolve, so it misses on every boot and every listener row
// renders the same private address. The mechanism was right and the SILENCE
// was the bug: the operator's only signal was one line on the broadcast
// container's stderr.
//
// The marker (state/trusted-proxies.json, written by
// docker/broadcast-entrypoint.sh and the AIO supervisor's render_icecast) is
// how that decision reaches the admin console. Every ambiguous input resolves
// to UNKNOWN, which renders nothing: a controller running ahead of its
// broadcast image sees no marker at all, and degrading to today's behaviour —
// the peer address, unexplained — is strictly better than a hint that guesses.

export interface TrustedProxyState {
  /** False when no usable marker exists: an older broadcast image, a state dir
   *  the render could not write, or a pair that has never rendered. Callers
   *  must show nothing rather than infer a miss from it. */
  known: boolean;
  /** Addresses that reached icecast.xml. 0 is the reported symptom. */
  count: number;
  /** Which source produced the candidates — `ICECAST_TRUSTED_PROXY_IPS`,
   *  `ICECAST_TRUSTED_PROXY_HOSTS` (the DNS path) or `aio-loopback`. Null when
   *  unknown. A miss names the knob that was tried, not just the count. */
  source: string | null;
  proxies: string[];
  /** Entries the render refused. icecast-KH matches an EXACT IP, so a CIDR is
   *  accepted and then silently never matches — an operator who set the var
   *  and still sees the proxy address is usually looking at one of these. */
  dropped: string[];
}

const UNKNOWN: TrustedProxyState = {
  known: false, count: 0, source: null, proxies: [], dropped: [],
};

/** The marker's source labels are shell literals and its addresses are already
 *  validated against the same charset icecast accepts, but this parses a file
 *  on disk — anything else is dropped rather than rendered into the console. */
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
  // A count that disagrees with the list it summarises is a marker from a
  // writer this reader does not understand. Trusting either half of it would
  // put a hint on screen that contradicts the config icecast is running.
  if (proxies.length !== m.count) return UNKNOWN;

  return { known: true, count: m.count, source, proxies, dropped: strings(m.dropped) };
}

/** Whether the Listeners table should explain itself. True only when the render
 *  actually reported a problem: nothing trusted (so every row is the edge), or
 *  something the operator configured was thrown away. */
export function needsTrustedProxyHint(s: TrustedProxyState): boolean {
  return s.known && (s.count === 0 || s.dropped.length > 0);
}

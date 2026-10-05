import type { ConnectionsState, TrustedProxyState } from './types';

// Shape a GET /listeners/connections body into what the Listeners card reads.
// Kept out of queries.ts (and free of value imports) so a controller test can
// load it without React. Every advisory key the controller sends must be passed
// on here: rebuilding the object field by field is how `geoip` was once dropped
// and the blank-Country hint never reached the page.
export function toConnectionsState(
  body: Partial<ConnectionsState> | null | undefined,
  unknownTrustedProxies: TrustedProxyState,
): ConnectionsState {
  return {
    count: body?.count ?? 0,
    connections: body?.connections ?? [],
    // An older controller omits the key entirely; `known: false` is the same
    // "say nothing" verdict the controller's own unknown case produces.
    trustedProxies: body?.trustedProxies ?? unknownTrustedProxies,
    // Absent on an older controller; the hint then stays silent.
    ...(body?.geoip ? { geoip: body.geoip } : {}),
  };
}

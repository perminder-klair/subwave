import type { ConnectionsState, TrustedProxyState } from './types';

// Preserve controller advisory fields when projecting listener connections.
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

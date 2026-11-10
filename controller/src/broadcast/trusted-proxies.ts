// IO shell around trusted-proxies-pure.ts, which owns every decision (#1613).

import { readFileSync } from 'node:fs';
import { config } from '../config.js';
import { trustedProxyState, type TrustedProxyState } from './trusted-proxies-pure.js';

export { needsTrustedProxyHint } from './trusted-proxies-pure.js';
export type { TrustedProxyState };

/** What the last icecast render trusted. Absent/unreadable/malformed → unknown.
 *  Unmemoised: one small file behind an admin-gated route. */
export function currentTrustedProxies(): TrustedProxyState {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(readFileSync(config.liquidsoap.trustedProxiesFile, 'utf8'));
  } catch {
    // Absent is normal on a broadcast image that predates the marker.
    parsed = null;
  }
  return trustedProxyState(parsed);
}

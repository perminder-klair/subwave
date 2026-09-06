// Reads the icecast render's trusted-proxy marker (#1613). The IO shell around
// trusted-proxies-pure.ts, which owns every decision and is separately pinned.

import { readFileSync } from 'node:fs';
import { config } from '../config.js';
import { trustedProxyState, type TrustedProxyState } from './trusted-proxies-pure.js';

export { needsTrustedProxyHint } from './trusted-proxies-pure.js';
export type { TrustedProxyState };

/** What the last icecast render trusted. Absent/unreadable/malformed → unknown;
 *  see trustedProxyState for why every failure resolves that way.
 *
 *  No memo, unlike music-starve.ts: that one sits under /state, which every
 *  listener polls at 5s. This is one small file behind an admin-gated route. */
export function currentTrustedProxies(): TrustedProxyState {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(readFileSync(config.liquidsoap.trustedProxiesFile, 'utf8'));
  } catch {
    // Absent is the normal case on a station whose broadcast image predates
    // the marker, and on one whose pair has not rendered since the upgrade.
    parsed = null;
  }
  return trustedProxyState(parsed);
}

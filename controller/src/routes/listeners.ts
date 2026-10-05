// Admin-gated GET /listeners — recent listener-count time-series, persisted
// by broadcast/listeners.ts. Feeds the admin sparkline.
import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import {
  history,
  historyBytes,
  getListenerCount,
  getConnections,
  groupConnections,
} from '../broadcast/listeners.js';
import { currentTrustedProxies } from '../broadcast/trusted-proxies.js';
import { resolveConnectionCountry } from '../broadcast/listener-country.js';
import { beaconCountryFor } from '../broadcast/beacon-countries.js';
import { lookupCountry, geoipStatus } from '../broadcast/geoip.js';

export const router = express.Router();

router.get('/listeners', requireAdmin, async (req, res) => {
  try {
    // Caps at one week: past that the JSONL is too big to parse in-memory.
    const sinceMinutes = Math.max(
      5,
      Math.min(parseInt(String(req.query.sinceMinutes ?? ''), 10) || 1440, 7 * 1440),
    );
    const since = new Date(Date.now() - sinceMinutes * 60 * 1000);
    const samples = await history({ since });
    const bytes = await historyBytes();
    res.json({
      current: getListenerCount(),
      sinceMinutes,
      bytes,
      samples,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Live per-listener detail from Icecast's admin interface. 502 on an Icecast
// auth/transport failure, so the UI can tell "nobody listening" (200, empty)
// from "couldn't reach Icecast admin".
router.get('/listeners/connections', requireAdmin, async (_req, res) => {
  try {
    // Group by IP+UA (same dedup as the headline count), deliberately NOT by IP
    // alone: the forwarded address may be untrusted and one NAT is many listeners.
    // Country per row (beacon first, then the GeoIP database). Absent when
    // neither knows, never a guess. Advisory, like trustedProxies below.
    const connections = groupConnections(await getConnections()).map(c => {
      const found = resolveConnectionCountry({
        ip: c.ip,
        beaconLookup: beaconCountryFor,
        geoipLookup: lookupCountry,
      });
      return found ? { ...c, country: found.country, countrySource: found.source } : c;
    });
    // What the icecast render trusted (#1613), so the UI can explain rows that
    // are all the edge's address. Advisory — it gates nothing.
    res.json({
      count: connections.length,
      connections,
      trustedProxies: currentTrustedProxies(),
      // Whether the Country column's database link can run, so blank cells
      // explain themselves. Advisory, like trustedProxies.
      geoip: geoipStatus(),
    });
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

// Audience-source analytics. POST /beacon is public and one-shot per session
// from the player; GET /audience is the admin rollup for the Stats page.
import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { unverifiedCfIp, clientIp } from '../middleware/ratelimit.js';
import * as audience from '../broadcast/audience.js';
import { resolveListenerCountry } from '../broadcast/listener-country.js';
import { lookupCountry } from '../broadcast/geoip.js';
import * as settings from '../settings.js';

export const router = express.Router();

router.post('/beacon', (req, res) => {
  // Analytics must never break a listener — swallow everything, always 204.
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    // The CF header is an unverified HINT here even when TRUST_CF_CONNECTING_IP
    // is off — a forgery only skews a rollup. Never reuse this ordering for
    // anything that throttles or locks out; clientIp() stays the gated one.
    const ip = unverifiedCfIp(req) || clientIp(req);
    // The country is a fail-open CHAIN (#1485), not one header. Read live so an
    // admin edit applies without a restart, and defensively so a settings read
    // can never break a listener's first page load.
    let countryHeader = '';
    try {
      countryHeader = String((settings.get() as any)?.stream?.countryHeader || '');
    } catch { /* fall through to the header/GeoIP links */ }
    audience.record({
      ip,
      country: resolveListenerCountry({
        headers: req.headers as Record<string, unknown>,
        ip,
        countryHeader,
        geoipLookup: lookupCountry,
      }),
      referrer: typeof body.referrer === 'string' ? body.referrer.slice(0, 500) : undefined,
      utmSource: typeof body.utmSource === 'string' ? body.utmSource.slice(0, 60) : undefined,
      path: typeof body.path === 'string' ? body.path.slice(0, 200) : undefined,
    });
  } catch {
    /* ignore */
  }
  res.status(204).end();
});

router.get('/audience', requireAdmin, (req, res) => {
  // Window clamps to 60 min … 90 days; day-bucket resolution past that is moot.
  const sinceMinutes = Math.max(
    60,
    Math.min(parseInt(String(req.query.sinceMinutes ?? ''), 10) || 1440, 90 * 1440),
  );
  res.json(audience.summary({ sinceMinutes }));
});

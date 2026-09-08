// The station-password gate for listener-facing READS (#1575). Deliberately NOT
// requireAdmin: open on a public station (no credential, no counter), FAILS
// CLOSED on a private one. POST /listener-auth's opposite fail-OPEN direction is
// deliberate; never unify the two.
import type { NextFunction, Request, Response } from 'express';
import * as settings from '../settings.js';
import { stationAuthCandidate, stationAuthDecision } from '../util/listener-auth.js';
import { checkAuthRateLimit, clientIp } from './ratelimit.js';

// Two deliberate differences from POST /station-auth's use of the same limiter:
// only FAILURES are counted (this is a read an agent may poll), and they land in
// this route's OWN bucket, so a stale-password integration cannot spend the
// attempts a human on that address needs to unlock the player.
export async function requireStationAuth(req: Request, res: Response, next: NextFunction) {
  await settings.load();
  const s = settings.get();
  const ok = stationAuthDecision({
    privatePlayer: s?.privacy?.privatePlayer === true,
    listenerAuth: s?.privacy?.listenerAuth === true,
    password: s?.privacy?.password || '',
    candidate: stationAuthCandidate({
      headerToken: req.headers['x-station-auth'],
      authorization: req.headers.authorization,
      query: (req.query as Record<string, unknown> | undefined)?.auth,
    }),
  });
  if (ok) return next();

  const gate = checkAuthRateLimit(clientIp(req), 'station-read');
  if (!gate.ok) {
    res.setHeader('Retry-After', String(gate.retryAfter));
    return res.status(429).json({ error: 'too many attempts' });
  }
  return res.status(401).json({
    error:
      'station password required — this station is private. Send it as an ' +
      'x-station-auth header (preferred), an Authorization: Bearer token, or ' +
      'an ?auth= query param (logged by proxies — a header is safer).',
  });
}

// CORS for the Next.js frontend. Wide open (`*`) — the controller sits behind
// Caddy in prod and is only reachable on the LAN in dev.
export function cors(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE');
  // X-Station-Auth carries the station password on a station-gated read
  // (middleware/station-auth.ts); unlisted, a cross-origin player holding the
  // password had every such read blocked by its own browser. X-Subwave-Console
  // is the same story for the admin console (middleware/auth.ts).
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Station-Auth, X-Subwave-Console');
  // Readable cross-origin so a client can wait as long as a 429/503 asked.
  res.setHeader('Access-Control-Expose-Headers', 'Retry-After');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
}

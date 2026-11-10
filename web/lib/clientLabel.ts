// Listener-connection helpers for the admin views reading Icecast's
// per-connection feed (GET /listeners/connections), so the Dash live table and
// the Stats device breakdown label devices and format durations identically.

export interface ListenerConnection {
  ip: string;
  mount: string;
  userAgent: string;
  connectedSeconds: number;
  // Raw sockets folded into this row. Safari opens 2 per client (counts as one
  // listener); >1 surfaces as a ×N badge. Absent/1 for normal single-socket clients.
  connections?: number;
  // ISO alpha-2 from GET /listeners/connections: that IP's own player beacon
  // first, else the operator's GeoIP database. Absent when neither knows.
  country?: string;
  countrySource?: 'beacon' | 'geoip';
}

// Hours is the coarsest unit; listeners rarely sit for days.
export function fmtConnected(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '—';
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// Checked before the browser/device families: players embed "Mozilla"
// boilerplate that would otherwise misclassify them as a browser.
function playerLabel(u: string): string {
  if (u.includes('sonos')) return 'Sonos';
  if (u.includes('vlc')) return 'VLC';
  if (u.includes('itunes') || u.includes('applecoremedia')) return 'iTunes / Music';
  if (u.includes('winamp')) return 'Winamp';
  if (u.includes('foobar')) return 'foobar2000';
  return '';
}

// Device / OS token, or '' if unrecognised.
function deviceToken(u: string): string {
  return u.includes('iphone')
    ? 'iPhone'
    : u.includes('ipad')
      ? 'iPad'
      : u.includes('android')
        ? 'Android'
        : u.includes('macintosh') || u.includes('mac os')
          ? 'Mac'
          : u.includes('windows')
            ? 'Windows'
            : u.includes('linux')
              ? 'Linux'
              : '';
}

// `edg` (Edge) is checked before `chrome` because Edge's UA carries both.
function browserToken(u: string): string {
  return u.includes('firefox')
    ? 'Firefox'
    : u.includes('edg')
      ? 'Edge'
      : u.includes('chrome') || u.includes('chromium')
        ? 'Chrome'
        : u.includes('safari')
          ? 'Safari'
          : '';
}

// Best-effort and deliberately shallow; the full UA stays in the title attribute.
export function clientLabel(ua: string): string {
  if (!ua) return 'unknown';
  const u = ua.toLowerCase();
  const player = playerLabel(u);
  if (player) return player;
  const label = [deviceToken(u), browserToken(u)].filter(Boolean).join(' · ');
  // Show the first token of the raw UA rather than a useless "unknown", which
  // helps with hardware radios and odd clients.
  return label || ua.split(/[\s/]/)[0] || 'unknown';
}

// Device / OS class only, for the aggregate breakdown. An unrecognised UA
// collapses to 'Other' so the breakdown stays low-cardinality instead of
// fragmenting on raw tokens the way per-row clientLabel does.
export function deviceLabel(ua: string): string {
  if (!ua) return 'Other';
  const u = ua.toLowerCase();
  return playerLabel(u) || deviceToken(u) || 'Other';
}

// Shared listener-connection helpers for the admin views that read Icecast's
// per-connection admin feed (GET /listeners/connections): the Dash live table
// and the Stats "connected now" device breakdown. Extracted from DashPanel so
// both surfaces label devices and format durations identically.

export interface ListenerConnection {
  ip: string;
  mount: string;
  userAgent: string;
  connectedSeconds: number;
  // Raw sockets folded into this row. Safari opens 2 per client (counts as one
  // listener); >1 surfaces as a ×N badge. Absent/1 for normal single-socket clients.
  connections?: number;
}

// connectedSeconds → short human string. Listeners rarely sit for days, so
// hours is the coarsest unit we bother with.
export function fmtConnected(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '—';
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// A dedicated media player (Sonos, VLC, …), or '' if the UA isn't one. Checked
// before the browser/device families because players embed "Mozilla"
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

// Browser family token, or '' if unrecognised. `edg` (Edge) is checked before
// `chrome` because Edge's UA carries both tokens.
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

// Collapse a raw user-agent into a short "Device · App" label for the live
// connections table. Best-effort and deliberately shallow — the full UA stays
// in the title attribute.
export function clientLabel(ua: string): string {
  if (!ua) return 'unknown';
  const u = ua.toLowerCase();
  const player = playerLabel(u);
  if (player) return player;
  const label = [deviceToken(u), browserToken(u)].filter(Boolean).join(' · ');
  // Nothing recognised — show the first token of the raw UA rather than a
  // useless "unknown" (helps with hardware radios / odd clients).
  return label || ua.split(/[\s/]/)[0] || 'unknown';
}

// Device / OS class only (iPhone, Mac, Sonos, …) for the aggregate device
// breakdown. Players report as themselves; an unrecognised UA collapses to
// 'Other' so the breakdown stays low-cardinality rather than fragmenting on raw
// tokens (which the per-row clientLabel keeps, but an aggregate must not).
export function deviceLabel(ua: string): string {
  if (!ua) return 'Other';
  const u = ua.toLowerCase();
  return playerLabel(u) || deviceToken(u) || 'Other';
}

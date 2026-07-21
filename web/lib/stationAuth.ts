// Station password token for private stations (#478).
//
// One shared password backs both privacy locks: it opens the web player when
// privacy.privatePlayer is on, and it authenticates the Icecast stream when
// privacy.listenerAuth is on. Whichever gate the listener meets first, the
// password they type is stored here and serves the other too.
//
// Browsers can't attach basic-auth credentials to an <audio> element, so the
// stream side rides the token as an `auth=` query param — Icecast's URL auth
// forwards the mount INCLUDING its query string to the controller, which
// accepts either that or a real basic-auth `pass` field.
//
// Stored in localStorage like the skin/theme overrides; cleared when the
// controller rejects it (i.e. the operator rotated the password).
const KEY = 'subwave-station-auth';

export function getStationAuthToken(): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(KEY) || '';
  } catch {
    return '';
  }
}

export function setStationAuthToken(token: string): void {
  try {
    window.localStorage.setItem(KEY, token);
  } catch {
    // Private-mode storage failures just mean re-prompting next visit.
  }
}

export function clearStationAuthToken(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

// Append the stored token to a stream URL (no-op when no token is stored —
// the common public-station case). The player's URLs always carry a ?t=
// cache-buster already, but handle both shapes for safety.
export function withStreamAuth(url: string): string {
  const token = getStationAuthToken();
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}auth=${encodeURIComponent(token)}`;
}

// Ask the controller whether a password is valid.
//
// This deliberately hits /station-auth, NOT the /listener-auth endpoint that
// Icecast calls. They share the password but not the failure mode:
// /listener-auth fails OPEN when stream auth is off (it has to — that covers
// the window where icecast.xml still carries the auth blocks but the setting
// is already off). Asking it here would mean a private player with stream auth
// off accepts any password at all. /station-auth fails closed.
//
// apiBase is the station's API root ('/api' same-origin in prod, an absolute
// origin in dev).
export async function checkStationAuth(apiBase: string, password: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiBase}/station-auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

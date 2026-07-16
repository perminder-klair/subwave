// Listener stream-auth token for private stations (#478).
//
// When the operator enables Icecast listener auth, browsers can't attach
// basic-auth credentials to an <audio> element — so the web player rides the
// shared station password as an `auth=` query param instead. Icecast's URL
// auth forwards the mount INCLUDING its query string to the controller's
// POST /listener-auth, which accepts either the basic-auth `pass` field or
// this token. Stored in localStorage like the skin/theme overrides; cleared
// when the controller rejects it (password rotated).
const KEY = 'subwave-stream-auth';

export function getStreamAuthToken(): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(KEY) || '';
  } catch {
    return '';
  }
}

export function setStreamAuthToken(token: string): void {
  try {
    window.localStorage.setItem(KEY, token);
  } catch {
    // Private-mode storage failures just mean re-prompting next visit.
  }
}

export function clearStreamAuthToken(): void {
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
  const token = getStreamAuthToken();
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}auth=${encodeURIComponent(token)}`;
}

// Ask the controller whether a password is valid — the same endpoint Icecast
// itself calls on every listener connect (`action=listener_add`), so a 200
// here means the stream will accept the token. apiBase is the station's API
// root ('/api' same-origin in prod, an absolute origin in dev).
export async function checkStreamAuth(apiBase: string, password: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiBase}/listener-auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ action: 'listener_add', pass: password }).toString(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

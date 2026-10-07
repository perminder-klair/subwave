// Both privacy locks share the stored password token. Audio elements cannot send Basic auth, so
// stream URLs include auth=; clear the token on rejection.
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

// No-op when no token is stored (the common public-station case). Player URLs
// already carry a ?t= cache-buster, but handle both shapes.
export function withStreamAuth(url: string): string {
  const token = getStationAuthToken();
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}auth=${encodeURIComponent(token)}`;
}

// Use fail-closed /station-auth. /listener-auth fails open when stream auth is disabled and would
// let a private player accept any password.
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

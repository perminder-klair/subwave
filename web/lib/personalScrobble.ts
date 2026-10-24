// Per-browser opt-in for authenticated personal scrobbling. The preference is
// intentionally local: signing in elsewhere must not turn that player's audio
// into this operator's listening history.

const STORAGE_KEY = 'subwave-personal-scrobble';
const CHANGE_EVENT = 'subwave-personal-scrobble-change';
let sessionEnabled = false;

export function personalScrobbleEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return sessionEnabled;
  }
}

export function setPersonalScrobbleEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  sessionEnabled = enabled;
  try {
    if (enabled) window.localStorage.setItem(STORAGE_KEY, '1');
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch { /* the module fallback keeps this choice for the tab session */ }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribePersonalScrobble(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(CHANGE_EVENT, listener);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(CHANGE_EVENT, listener);
  };
}

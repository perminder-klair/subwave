// Which clock the player's wall-clock times read in: the station's zone (the
// default) or this listener's own. A per-browser choice from the Appearance
// menu, like lite mode, never station state.
//
// Station time is the default because the DJ speaks the time in the station's
// zone, and a booth stamp that disagrees with what was just said reads as a bug
// (#418). A listener far from the station can still ask for their own clock;
// they then hear one time and read another, which is what they chose.
//
// Only the player's displayed times follow it. Schedule grids keep the station
// zone whatever this says: a show's hours are station hours, and the "now"
// marker has to land on the cell the controller resolves the active show from.
// The classic schedule drawer still works in station hours but labels each one
// in the chosen clock (lib/scheduleClock.ts).
// Durations (elapsed / remaining) have no zone at all.

export type ClockZone = 'station' | 'local';

const STORAGE_KEY = 'subwave-clock-zone';
const DEFAULT_ZONE: ClockZone = 'station';

// Every mounted reader, so a toggle in the menu re-renders the whole player
// rather than just the menu that flipped it.
const listeners = new Set<() => void>();

// Held in memory too, so a choice still applies for this page's life where
// storage is blocked (private mode, a sandboxed embed).
let current: ClockZone | null = null;

export function normalizeClockZone(raw: unknown): ClockZone {
  return raw === 'local' ? 'local' : DEFAULT_ZONE;
}

/** The saved choice; 'station' on the server, unset, or unreadable storage. */
export function getClockZone(): ClockZone {
  if (current) return current;
  if (typeof window === 'undefined') return DEFAULT_ZONE;
  try {
    current = normalizeClockZone(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    current = DEFAULT_ZONE;
  }
  return current;
}

/** Saves the choice for this browser and tells every reader. Storage failures
 *  are swallowed: the choice still holds for this page. No-op on the server. */
export function setClockZone(zone: ClockZone): void {
  if (typeof window === 'undefined') return;
  current = normalizeClockZone(zone);
  try {
    window.localStorage.setItem(STORAGE_KEY, current);
  } catch { /* private mode / quota — non-fatal */ }
  for (const onChange of listeners) onChange();
}

/** Calls `onChange` after every setClockZone, and when another tab saves one.
 *  Returns the unsubscribe. */
export function subscribeClockZone(onChange: () => void): () => void {
  listeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY) return;
    current = normalizeClockZone(e.newValue);
    onChange();
  };
  const canListen = typeof window !== 'undefined' && typeof window.addEventListener === 'function';
  if (canListen) window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(onChange);
    if (canListen) window.removeEventListener('storage', onStorage);
  };
}

/** This browser's IANA zone, or null where Intl can't say. */
export function localTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** The zone the player renders wall-clock times in. Local mode names the
 *  browser's zone explicitly; station mode passes the station's through, which
 *  is null before the first poll (and every formatter then uses the browser's). */
export function displayTimezone(
  stationTz: string | null,
  zone: ClockZone,
  localTz: string | null = localTimezone(),
): string | null {
  return zone === 'local' ? localTz : stationTz;
}

/** Test seam: forget the in-memory choice so the next read goes to storage. */
export function resetClockZoneForTests(): void {
  current = null;
  listeners.clear();
}

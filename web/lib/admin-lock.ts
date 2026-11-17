// The controller's brute-force lock as the console reads it. requireAdmin answers
// it with a 429 that refuses the right password too (controller/src/middleware/
// auth.ts). Every other 429 on an admin route is that route's own business, so
// `code` is what identifies this one.
const LOCK_CODE = 'admin_locked';
// Only for a proxy that drops Retry-After: the controller's own window.
const FALLBACK_LOCK_MS = 15 * 60_000;

/** When the lock on this response lifts, or null if it isn't the lock. */
export async function adminLockedUntil(response: Response, now = Date.now()): Promise<number | null> {
  if (response.status !== 429) return null;
  const body = await response.clone().json().catch(() => null) as { code?: unknown } | null;
  if (body?.code !== LOCK_CODE) return null;
  const seconds = Number(response.headers.get('Retry-After'));
  return now + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : FALLBACK_LOCK_MS);
}

/** Time left on the lock, rounded up: it never reads as over before it is. */
export function lockRemaining(lockedUntil: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.ceil((lockedUntil - now) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.ceil(seconds / 60)} min`;
}

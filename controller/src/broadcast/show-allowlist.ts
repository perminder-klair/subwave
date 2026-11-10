// The on-air show's imaging allowlist (#1875, #1188), applied at pick time by
// every automatic draw: the jingle rotate, the over-music ID and the link bed.
//
// Empty or absent list = every item, which is how a station without lists has
// always behaved. A non-empty list is strict: only listed items, never a
// station fallback. A listed name that no longer exists matches nothing, so a
// list whose entries were all deleted yields no item and the draw is skipped
// rather than quietly widening to the whole library.
export function allowedForShow<T>(
  items: T[],
  allowlist: readonly string[] | undefined,
  key: (item: T) => string,
): T[] {
  if (!allowlist?.length) return items;
  const allowed = new Set(allowlist);
  return items.filter(item => allowed.has(key(item)));
}

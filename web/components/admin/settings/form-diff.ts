import type { FormState } from './shared';

/**
 * Read one dotted path out of the form. Returns undefined for a missing branch
 * rather than throwing, so a path that names a key a given settings.json has
 * never carried compares equal on both sides and reads as clean.
 */
export function atPath(form: FormState | null, path: string): unknown {
  let node: unknown = form;
  for (const key of path.split('.')) {
    if (!node || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

export const samePath = (a: FormState | null, b: FormState | null, path: string) =>
  JSON.stringify(atPath(a, path) ?? null) === JSON.stringify(atPath(b, path) ?? null);

/**
 * How many individual controls differ between two form branches.
 *
 * Counting LEAVES, not top-level keys: `requests` is one key holding seven
 * fields, and "1 unsaved change" under a card where the operator just edited
 * three of them reads as a bug in the counter.
 */
export function countLeafDiffs(a: unknown, b: unknown): number {
  if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) return 0;
  const plain = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  // An array is one control (the TTS corrections list, the compat params
  // table), not one control per row.
  if (!plain(a) || !plain(b)) return 1;
  let n = 0;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    n += countLeafDiffs(a[key], b[key]);
  }
  return n;
}

/**
 * The paths a section owns that differ from the last saved baseline.
 *
 * Diffing against the BASELINE rather than the server's current values is what
 * makes the count survive the 3s refetch: the baseline only moves when a save
 * succeeds, so an operator mid-edit keeps seeing their own change count.
 */
export function dirtyPaths(
  form: FormState | null,
  baseline: FormState | null,
  paths: readonly string[],
): string[] {
  if (!form || !baseline) return [];
  return paths.filter(path => !samePath(form, baseline, path));
}

/**
 * Settings keys a save posts under a name the FormState does NOT use.
 *
 * `rebaselineSavedPatch` already re-homes the VALUES (audio.stemCache* is edited
 * as `transitions.*`); anything that scopes by FormState key has to follow the
 * same map or it misses the alias. Discard is the case that bites: rolling back
 * `transitions` while leaving the `audio.stemCacheGb` message on screen parks an
 * error under a value that no longer produced it.
 */
const FORM_KEY_ALIASES: Record<string, readonly string[]> = {
  transitions: ['audio'],
};

/** Does `path` belong to any of these FormState keys, alias included? */
export function ownsErrorPath(formKeys: readonly string[], path: string): boolean {
  const under = (key: string) => path === key || path.startsWith(`${key}.`);
  return formKeys.some(key => under(key) || (FORM_KEY_ALIASES[key] ?? []).some(under));
}

/**
 * Replace exactly the errors belonging to the keys this patch carried.
 *
 * Scoped by TOP-LEVEL key, because that is the unit a save button posts and the
 * unit the controller reports against: a `{beds: …}` save owns every
 * `beds.*` error and nothing else. Merging blindly would let a fixed field keep
 * showing its old message; clearing everything would wipe an unrelated
 * section's unresolved error the moment any other control saved.
 */
export function mergePatchErrors(
  prev: Record<string, string>,
  patch: Record<string, unknown>,
  next: Record<string, string> | undefined,
): Record<string, string> {
  const owned = Object.keys(patch);
  const isOwned = (path: string) =>
    owned.some((key) => path === key || path.startsWith(`${key}.`));
  const out: Record<string, string> = {};
  for (const [path, message] of Object.entries(prev)) {
    if (!isOwned(path)) out[path] = message;
  }
  for (const [path, message] of Object.entries(next || {})) out[path] = message;
  return out;
}

export const sameForm = (a: FormState, b: FormState) => JSON.stringify(a) === JSON.stringify(b);

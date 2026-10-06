// Two decisions the Google key pool's admin UI has to get right, both pulled out
// of the components so they can be tested without a render — the repo has no
// component-rendering test setup, and the logic here is the part that regresses.
//
// They are together because they are the same subject: what the POOL's existence
// means for the rest of the form.

// Which environment variable holds a given provider's key.
export const GOOGLE_KEY_VAR = 'GOOGLE_GENERATIVE_AI_API_KEY';

/**
 * Is this provider's single-key field INERT because a pool is configured?
 *
 * Applies to the fallback leg as much as the primary, and that is the whole point
 * of putting it here. `googleKeyFetch` is installed on every `google` client the
 * registry builds, primary and fallback alike, and it consults one process-wide
 * pool. So a pool is the station's only Google credential for BOTH legs: a
 * fallback Google key saved while a pool exists is stored, reported as saved, and
 * then never read by anything.
 *
 * The primary field got this guard first, and the fallback did not — one field
 * greyed out, its twin editable, both writing the same ignored variable. Two
 * call sites reading one predicate is what stops that coming back; a third copy
 * of the condition would drift again.
 */
export function googleKeyFieldInert(keyVar: string | undefined, poolCount: number): boolean {
  return keyVar === GOOGLE_KEY_VAR && poolCount > 0;
}

/**
 * Did the refetch that follows a pool mutation actually reconcile the rows?
 *
 * A refetch is what makes the on-screen rows describe the pool again, so the rows
 * may only be unlocked if it succeeded. `postAndRefresh` used to treat "did not
 * throw" as success, and React Query's `refetch` resolves with
 * `{ isError: true }` rather than throwing unless `throwOnError` is set — which
 * it is not. So a refetch that failed took the success path: `desynced` was
 * cleared and every row control came back enabled, against a list the operator
 * could no longer see and mutations would no longer match.
 *
 * A refetch that DOES throw is handled by the caller's catch, which is the same
 * answer; this covers the case that silently reported the opposite.
 */
export function refetchReconciled(result: unknown): boolean {
  if (result == null || typeof result !== 'object') return true;
  const outcome = result as { isError?: unknown; status?: unknown; error?: unknown };
  // `status` is checked alongside `isError` so a client that reports one and not
  // the other still answers correctly; a rejected result with neither is not
  // treated as a failure, because nothing here can know it failed.
  if (outcome.isError === true) return false;
  if (outcome.status === 'error') return false;
  return true;
}
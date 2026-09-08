// ZodError → operator-readable string; a raw ZodError's `.message` is a ~15-line
// JSON blob that lands verbatim in a toast. Neutral ground: both
// middleware/validate.ts and settings/validate.ts import from here, since
// settings/ must not import middleware/.
import type { ZodError } from 'zod';

// Dotted path ('webhooks.1.url'), which is also react-hook-form's setError syntax.
function pathOf(issue: ZodError['issues'][number]): string {
  return issue.path.join('.');
}

/**
 * One message per field, keyed by dotted path. The accumulator MUST stay a
 * null-prototype object: field names come from user data, and on a `{}` literal
 * `toString` is swallowed by the first-wins guard while `__proto__` is dropped
 * outright.
 */
export function flattenIssues(error: ZodError): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const issue of error.issues) {
    const key = pathOf(issue);
    // First error per field wins.
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

/**
 * A flat, single-line message — what a 400's `error` string carries.
 *
 * The dotted path is prefixed UNCONDITIONALLY: zod's messages name a constraint
 * and never a location, and even a custom message never names the array index,
 * so without it two rows failing the same rule read identically. Don't
 * reintroduce a per-code heuristic; the set of field-agnostic codes is open.
 *
 * `root` names the value when the SCHEMA is unrooted — a validator parsing a
 * bare array passes its settings key so '0.url' reads as 'webhooks.0.url'.
 */
export function firstMessage(error: ZodError, root?: string): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid request body';
  // pathOf is '' for a root-level issue, so a bare `root` survives on its own.
  const key = [root, pathOf(issue)].filter(Boolean).join('.');
  return key ? `${key}: ${issue.message}` : issue.message;
}

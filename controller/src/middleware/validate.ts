// Route-boundary body validation against a shared zod schema.
//
// This is NOT a replacement for settings.update()'s own validation —
// update() is reached by paths that never touch a route (backup import,
// onboarding save) and remains the authoritative chokepoint. This middleware
// runs EARLIER and produces a field-level error payload the admin form can map
// back onto individual inputs.
//
// The error contract is additive: `error` is the flat string every existing
// client already reads from a 400; `fieldErrors` is new and optional.
//
// The ZodError → readable-string translation lives in util/zod-error.ts, shared
// with settings/validate.ts — settings/ must not import middleware/.
import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';
import { validateSettingsPatch } from '../settings/patch-registry.js';
import { firstMessage, flattenIssues } from '../util/zod-error.js';

export interface ValidateBodyOptions {
  /**
   * How the flat `error` string is built.
   *
   * `'prefixed'` (the default) puts the dotted path in front, because zod's
   * built-in messages name a CONSTRAINT and never a location — 'expected array,
   * received string' is useless without 'webhooks.1.url' ahead of it.
   *
   * `'verbatim'` takes the first issue's message as written. Use it ONLY for a
   * schema whose every message already names its own field, where prefixing
   * doubles the location: `POST /library/blocklist/rules` would otherwise
   * answer 'label: rule.label is required'. This is the same narrow exception
   * settings/patch-registry.ts documents, and for the same reason — these
   * strings are what the store's own chokepoint throws, so the route and the
   * chokepoint must not report the same body two different ways.
   *
   * `fieldErrors` is unaffected either way: it always carries the dotted path,
   * which is where a form needs it.
   */
  messages?: 'prefixed' | 'verbatim';
}

function flatError(error: Parameters<typeof flattenIssues>[0], opts?: ValidateBodyOptions): string {
  // firstMessage remains the fallback for an issue carrying no message at all,
  // so a future schema cannot produce a bare 400.
  return opts?.messages === 'verbatim'
    ? error.issues[0]?.message || firstMessage(error)
    : firstMessage(error);
}

export function validateBody(schema: ZodType, opts?: ValidateBodyOptions) {
  return (req: Request, res: Response, next: NextFunction) => {
    const r = schema.safeParse(req.body);
    if (!r.success) {
      return res.status(400).json({
        error: flatError(r.error, opts),
        fieldErrors: flattenIssues(r.error),
      });
    }
    req.body = r.data;
    next();
  };
}

/**
 * Same validation, LISTENER-facing error shape. Public forms only — today that
 * is POST /request and nothing else. Two differences from validateBody, both
 * because the reader is a listener looking at a request box rather than an
 * operator looking at an admin form:
 *
 *  - **No dotted-path prefix.** `firstMessage` prefixes unconditionally, right
 *    when the operator has to find `webhooks.1.url` among nine rows and wrong
 *    when the string stands alone: "text: Keep it under 280 characters." reads
 *    as a bug to a listener.
 *  - **`success: false` and `message` ride along.** The web player pre-flights
 *    the mirrored schema and never meets this 400, but the native app posts
 *    /request directly and reads `data.message`. It ships through the app
 *    stores, so an already-installed build meeting a new refusal must have
 *    something to render or the drawer shows an empty failure card.
 */
export function validatePublicBody(schema: ZodType) {
  return (req: Request, res: Response, next: NextFunction) => {
    const r = schema.safeParse(req.body);
    if (!r.success) {
      const message = r.error.issues[0]?.message || 'invalid request body';
      return res.status(400).json({
        success: false,
        error: message,
        message,
        fieldErrors: flattenIssues(r.error),
      });
    }
    req.body = r.data;
    next();
  };
}

/**
 * Same contract, for a schema that cannot exist until the request does.
 *
 * A show is the first shape that can't be validated against itself — its host
 * has to name a real persona, its moods a live mood, its theme an installed
 * one — so its schema is a FACTORY over a context read from live settings.
 * Rather than let that route hand-roll its own 400, it hands over a resolver
 * and the error payload stays shaped in exactly one place.
 *
 * A resolver that throws yields a 500, not a 400: failing to READ the context
 * is a server fault, and reporting it as a validation error would tell the
 * operator their input was bad when it never got looked at.
 */
/**
 * Same contract, for the one body that is a PARTIAL PATCH rather than an object.
 *
 * `POST /settings` carries any subset of 43 top-level keys, so there is no
 * single `ZodType` to hand `validateBody` — a schema over the whole settings
 * object would strip every key a form learns to send next. The per-key registry
 * (settings/patch-registry.ts) validates only the keys actually present and
 * roots each issue path at its settings key, which is what finally gives the
 * dozen panels posting here the `fieldErrors` channel #1323 built.
 *
 * Unlike validateBody this does NOT rewrite req.body. settings.update() runs
 * the same schemas as it applies each key and stays the authoritative
 * chokepoint — it is reached by backup restore and onboarding, which never pass
 * through here at all.
 */
export function validateSettingsBody() {
  return (req: Request, res: Response, next: NextFunction) => {
    const failure = validateSettingsPatch(req.body || {});
    if (failure) return res.status(400).json(failure);
    next();
  };
}

export function validateBodyAsync(
  resolve: (req: Request) => Promise<ZodType> | ZodType,
  opts?: ValidateBodyOptions,
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    let schema: ZodType;
    try {
      schema = await resolve(req);
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
    const r = schema.safeParse(req.body);
    if (!r.success) {
      return res.status(400).json({
        error: flatError(r.error, opts),
        fieldErrors: flattenIssues(r.error),
      });
    }
    req.body = r.data;
    next();
  };
}

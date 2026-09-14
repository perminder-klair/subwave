// Route-boundary body validation against a shared zod schema. NOT a replacement
// for settings.update()'s validation, which stays the authoritative chokepoint
// (backup import and onboarding never touch a route). `error` is the flat string
// every existing client reads from a 400; `fieldErrors` is additive.
import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';
import { validateSettingsPatch } from '../settings/patch-registry.js';
import { firstMessage, flattenIssues } from '../util/zod-error.js';

export interface ValidateBodyOptions {
  /**
   * `'prefixed'` (default) puts the dotted path in front, since zod messages
   * name a constraint and never a location. `'verbatim'` is for schemas whose
   * messages already name their own field, where prefixing doubles the location.
   * `fieldErrors` always carries the dotted path either way.
   */
  messages?: 'prefixed' | 'verbatim';
}

function flatError(error: Parameters<typeof flattenIssues>[0], opts?: ValidateBodyOptions): string {
  // firstMessage is the fallback for an issue carrying no message at all.
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
 * Same validation, LISTENER-facing error shape (public forms only, today just
 * POST /request). No dotted-path prefix, since the string stands alone in a
 * request box; `success: false` + `message` ride along because the native app
 * posts /request directly and reads `data.message`.
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
 * Same contract, for the one body that is a PARTIAL PATCH rather than an object:
 * `POST /settings` carries any subset of the top-level keys, so the per-key
 * registry validates only the keys present. Unlike validateBody it does NOT
 * rewrite req.body — settings.update() runs the same schemas and stays the
 * authoritative chokepoint.
 */
export function validateSettingsBody() {
  return (req: Request, res: Response, next: NextFunction) => {
    const failure = validateSettingsPatch(req.body || {});
    if (failure) return res.status(400).json(failure);
    next();
  };
}

/**
 * Same contract, for a schema that cannot exist until the request does (a show
 * schema is a factory over a context read from live settings). A resolver that
 * throws yields 500, not 400: failing to READ the context is a server fault.
 */
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

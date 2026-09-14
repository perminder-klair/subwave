// Shared listener-request schema — POST /request's `{ text, name }`. Run at the
// route boundary and once in PlayerCore's submitRequest, the chokepoint every
// skin's box goes through. The on-air safety pipeline (injection stripping,
// opener cuts, reserved-name screening, 'anon' fallback) is NOT here: that is
// util/request-guard.ts, which repairs rather than refuses.
import { z } from 'zod';

// One figure for the route, the guard and the browser; request-guard's NAME_MAX
// is an alias of this.
export const REQUEST_TEXT_MAX = 280;
export const REQUEST_NAME_MAX = 40;

// Explicit null reads as absent. (Named per-module: the mirror is one flat file.)
const requestNullToUndefined = (v: unknown) => (v == null ? undefined : v);

// Messages are listener-facing and stand alone without a field prefix, so this
// schema MUST be mounted through middleware/validate.ts's validatePublicBody —
// the ordinary validateBody prefixes the dotted path onto every one of them.
export const listenerRequestSchema = z.object({
  text: z
    .string({ error: 'Empty request' })
    .trim()
    .min(1, 'Empty request')
    .max(REQUEST_TEXT_MAX, `Keep it under ${REQUEST_TEXT_MAX} characters.`),
  // Optional, but refused rather than sliced; no `.catch()` (it cannot tell a
  // wrong type from a too-long value). Reserved names are the guard's business.
  name: z.preprocess(
    requestNullToUndefined,
    z
      .string({ error: 'Names must be plain text.' })
      .trim()
      .max(REQUEST_NAME_MAX, `Keep the name under ${REQUEST_NAME_MAX} characters.`)
      .default(''),
  ),
});

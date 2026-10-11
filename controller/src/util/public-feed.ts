// The public projections of GET /state and GET /session: explicit allowlists,
// never a spread of internal state. Both routes are unauthenticated, polled by
// every player, and open even on a private station, so a field reaches them
// only by being named here.
//
// What stays out, and why:
//   - `djLog` (the booth log) is operator diagnostics. Admin routes write
//     settings, blocklist and error detail into it, and publicError() parks the
//     internal error text it withholds there. The admin reads it from
//     GET /debug and GET /debug/dj-log. Withheld by leaving the key ABSENT: no
//     listener client has ever read it, and every shipped client tolerates it
//     missing.
//   - session turn meta beyond what a booth renders: the agent's `toolCalls`
//     and `steps` (tool arguments, results and backend error text) and
//     `promptSuffix` (model-only coaching). The admin sees tool trails in the
//     LLM call log on /debug.
//
// Pure: no settings, queue or session imports.

/** Top-level keys of queue.snapshot() a listener may see. The queue items are
 *  already a projection (queue.snapshot()'s mapItem), so they pass through. */
const PUBLIC_QUEUE_KEYS = [
  'current',
  'upcoming',
  'history',
  'nextTransition',
  'autoPick',
  'autoLink',
  'pickerBusy',
] as const;

export type PublicQueueState = Partial<Record<(typeof PUBLIC_QUEUE_KEYS)[number], unknown>>;

/** queue.snapshot() reduced to its public keys. A key the snapshot lacks stays
 *  absent rather than becoming `undefined`. */
export function publicQueueState(snap: Record<string, unknown> | null | undefined): PublicQueueState {
  const out: PublicQueueState = {};
  if (!snap) return out;
  for (const k of PUBLIC_QUEUE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(snap, k)) out[k] = snap[k];
  }
  return out;
}

/** Session turn meta keys the booth renders, plus the persona id (already
 *  public on /personas) so a client can join a line to the roster. Readers:
 *  web/lib/sessionFeed.ts, the skins' BoothDrawer/MetaLine, and the app's
 *  lib/sessionFeed.ts + voice-turn.ts. */
const PUBLIC_TURN_META_KEYS = [
  'personaId',
  'personaName',
  'airedAt',
  'durationMs',
  'trackId',
  'title',
  'artist',
  'say',
  'requester',
  'requestedBy',
  'source',
  'carried',
  'carriedFrom',
  'boundary',
] as const;

export interface PublicTurn {
  t: unknown;
  role: unknown;
  kind: unknown;
  text: unknown;
  meta: Record<string, unknown>;
}

interface TurnLike {
  t?: unknown;
  role?: unknown;
  kind?: unknown;
  text?: unknown;
  meta?: unknown;
}

/** One booth turn reduced to the public shape. `meta` is always an object, as
 *  it always has been, so `turn.meta.x` reads keep working on old clients. */
export function publicSessionTurn(turn: TurnLike): PublicTurn {
  const src = turn?.meta && typeof turn.meta === 'object' ? (turn.meta as Record<string, unknown>) : {};
  const meta: Record<string, unknown> = {};
  for (const k of PUBLIC_TURN_META_KEYS) {
    if (Object.prototype.hasOwnProperty.call(src, k)) meta[k] = src[k];
  }
  return { t: turn?.t, role: turn?.role, kind: turn?.kind, text: turn?.text, meta };
}

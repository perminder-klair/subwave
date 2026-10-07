// Booth carry across a hard session roll (#1690). DISPLAY ONLY.
//
// A hard roll starts the new session with an empty `messages` array, and every
// listener booth reads GET /session, so a passive display went blank the
// moment a new show began. At the roll, a bounded tail of the outgoing show's
// displayable turns is snapshotted onto the new session (`boothCarry`), and
// GET /session composes it in front of the live turns behind a show-boundary
// separator for a limited time.
//
// The carry must never become prompt memory (#1479): it lives in its own
// field, which only the GET /session projection reads. promptMemory(),
// priorPromptMemory(), windowMessages(), queue.getDjRecap() and
// queue.getRecentOpeners() all read `messages` and never see it.
//
// Pure: no settings, queue or clock imports; time and the clock label are
// passed in.

/** Newest eligible outgoing turns kept. Client tail limits scroll them out
 *  naturally as the new show talks. */
export const BOOTH_CARRY_MAX_TURNS = 12;
/** Only turns this close before the boundary are carried, so a roll after
 *  long downtime (or a quiet outgoing show) carries little or nothing. */
export const BOOTH_CARRY_LOOKBACK_MS = 30 * 60_000;
/** How long after the boundary GET /session keeps serving the carry. After
 *  this the payload is byte-identical to the no-carry shape. */
export const BOOTH_CARRY_TTL_MS = 30 * 60_000;

export interface BoothTurn {
  t: string;
  role: string;
  kind: string;
  text: string;
  meta: { personaName?: string; [k: string]: unknown };
}

export interface BoothCarry {
  fromSessionId: string;
  /** Outgoing show name; null for an autonomous block. */
  fromShow: string | null;
  fromPersona: string | null;
  /** ISO boundary used for selection and expiry, including recovered handoffs. */
  boundaryAt: string;
  /** A same-key roll (the 4h cap): the turns are plain copies and no
   *  separator is drawn, because no show boundary actually happened. */
  sameShow: boolean;
  turns: BoothTurn[];
}

export interface BoothCarrySource {
  id: string;
  key: string;
  show: { name?: string } | null;
  persona: { name?: string } | null;
  messages: readonly BoothTurn[];
}

export interface BoothCarryTarget {
  key: string;
  ctxAt?: string;
  startedAt: string;
}

export interface BoothBoundary {
  at: string;
  show: string | null;
  persona: string | null;
  fromShow: string | null;
  fromSessionId: string;
}

function eligible(turn: BoothTurn | null | undefined, cutoffMs: number): boolean {
  if (!turn || typeof turn.text !== 'string' || !turn.text.trim()) return false;
  if (turn.kind === 'sfx' || turn.role === 'event') return false;
  const t = Date.parse(turn.t);
  return Number.isFinite(t) && t >= cutoffMs;
}

/** Snapshot the outgoing session's recent displayable turns for the incoming
 *  one. Reads `prev.messages` only, never a carry `prev` itself holds, so
 *  carries do not chain across consecutive boundaries. The caller supplies
 *  the actual boundary, including when recovery happens later. Returns copies;
 *  `prev` is not mutated. Null when nothing is eligible. */
export function snapshotBoothCarry(
  prev: BoothCarrySource,
  next: BoothCarryTarget,
  boundaryMs: number,
): BoothCarry | null {
  if (!prev || !Array.isArray(prev.messages)) return null;
  const cutoffMs = boundaryMs - BOOTH_CARRY_LOOKBACK_MS;
  const sameShow = prev.key === next.key;
  const fromPersona = prev.persona?.name || null;

  const picked: BoothTurn[] = [];
  for (let i = prev.messages.length - 1; i >= 0 && picked.length < BOOTH_CARRY_MAX_TURNS; i--) {
    const turn = prev.messages[i];
    if (eligible(turn, cutoffMs)) picked.push(turn);
  }
  if (!picked.length) return null;

  const turns = picked.reverse().map((turn): BoothTurn => {
    const meta = { ...(turn.meta || {}) };
    if (!sameShow) {
      meta.carried = true;
      meta.carriedFrom = prev.id;
      const voiced = turn.role === 'segment' || turn.role === 'dj';
      if (voiced && !meta.personaName && fromPersona) meta.personaName = fromPersona;
    }
    return { ...turn, meta };
  });

  return {
    fromSessionId: prev.id,
    fromShow: prev.show?.name || null,
    fromPersona,
    boundaryAt: new Date(boundaryMs).toISOString(),
    sameShow,
    turns,
  };
}

/** The listener booth feed for GET /session: carried turns, the show-boundary
 *  separator, then the live session's non-sfx turns. Outside the TTL (or with
 *  no carry) it is exactly the live non-sfx turns. `clockLabel` formats the
 *  boundary moment in the station's zone and clock style. The caller applies
 *  its own tail limit. */
export function composeBoothFeed(
  current: {
    messages: readonly BoothTurn[];
    boothCarry?: BoothCarry | null;
    show?: { name?: string } | null;
    persona?: { name?: string } | null;
  },
  nowMs: number,
  clockLabel: (atIso: string) => string,
): BoothTurn[] {
  const live = current.messages.filter(m => m.kind !== 'sfx');
  const carry = current.boothCarry;
  if (!carry || !Array.isArray(carry.turns) || !carry.turns.length) return live;
  const boundaryMs = Date.parse(carry.boundaryAt);
  if (!Number.isFinite(boundaryMs) || nowMs - boundaryMs > BOOTH_CARRY_TTL_MS) return live;
  if (carry.sameShow) return [...carry.turns, ...live];

  const show = current.show?.name || null;
  const persona = current.persona?.name || null;
  const boundary: BoothBoundary = {
    at: carry.boundaryAt,
    show,
    persona,
    fromShow: carry.fromShow,
    fromSessionId: carry.fromSessionId,
  };
  const separator: BoothTurn = {
    t: carry.boundaryAt,
    role: 'event',
    kind: 'show-boundary',
    text: `${clockLabel(carry.boundaryAt)} · ${show || persona || 'On air'}`,
    meta: { boundary },
  };
  return [...carry.turns, separator, ...live];
}

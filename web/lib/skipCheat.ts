// The player's skip cheat code: a short Konami code, typed or swiped.
//
// It is a shortcut for the station's admin, never a listener skip. One stream
// is what every listener hears, so the code only reaches `POST /dj/skip` with
// the admin's own stored credentials, and the controller's `requireAdmin` stays
// the only gate. Anyone else who finds it gets a joke and nothing is sent
// (`components/player/SkipCheat.tsx`).
//
// The sequence is ↑ ↑ ↓ ↓ B A: the Konami code without its ← → ← →, which was
// too fiddly on a phone. On a keyboard that is the arrow keys and the letters. On a touch screen each arrow is a swipe anywhere on the
// player, and B A are two taps: the player is a fixed, non-scrolling page, so a
// swipe moves nothing else. This module only reads gestures and matches the
// sequence; it holds no DOM and no timers.

export type CheatToken = 'up' | 'down' | 'left' | 'right' | 'b' | 'a' | 'tap';

/** On touch, a tap stands in for both B and A. */
const SEQUENCE: readonly CheatToken[] = ['up', 'up', 'down', 'down', 'b', 'a'];

/** A pause longer than this starts the sequence over, so stray swipes from
 *  minutes ago can't complete it. */
export const CHEAT_GAP_MS = 3_000;

/** A touch that moves less than this is a tap. */
const TAP_MAX_PX = 12;
/** A tap held longer than this is a long press, not a tap. */
const TAP_MAX_MS = 350;
/** A swipe must move at least this far along its axis... */
const SWIPE_MIN_PX = 30;
/** ...and take no longer than this. */
const SWIPE_MAX_MS = 800;

export interface CheatState {
  /** How many tokens of SEQUENCE have matched so far. */
  matched: number;
  /** When the last token was accepted, ms. */
  at: number;
}

export const CHEAT_START: CheatState = { matched: 0, at: 0 };

function accepts(expected: CheatToken | undefined, got: CheatToken): boolean {
  if (got === expected) return true;
  return got === 'tap' && (expected === 'b' || expected === 'a');
}

/** Feed one token. `fired` is true exactly when it completes the sequence, and
 *  the state then starts over. */
export function advanceCheat(state: CheatState, token: CheatToken, now: number): { state: CheatState; fired: boolean } {
  const matched = state.matched > 0 && now - state.at > CHEAT_GAP_MS ? 0 : state.matched;
  if (accepts(SEQUENCE[matched], token)) {
    const next = matched + 1;
    if (next === SEQUENCE.length) return { state: CHEAT_START, fired: true };
    return { state: { matched: next, at: now }, fired: false };
  }
  // A miss can still begin the sequence (an extra ↑ before the ↑ ↑, say). The
  // only token that can begin it is ↑, so this restarts at 1 or 0; matching
  // against a longer prefix of the sequence never helps.
  if (accepts(SEQUENCE[0], token)) {
    // ↑ ↑ ↑ keeps two ↑ matched: the newest pair is still a valid opening.
    // Later in the sequence the token before this ↑ was never a ↑, so it is 1.
    const keep = matched === 2 ? 2 : 1;
    return { state: { matched: keep, at: now }, fired: false };
  }
  return { state: CHEAT_START, fired: false };
}

/** The token for a key, or null. Letters ignore case. */
export function keyToken(key: string): CheatToken | null {
  switch (key) {
    case 'ArrowUp': return 'up';
    case 'ArrowDown': return 'down';
    case 'ArrowLeft': return 'left';
    case 'ArrowRight': return 'right';
    case 'b': case 'B': return 'b';
    case 'a': case 'A': return 'a';
    default: return null;
  }
}

/** The token for one finished touch: its movement from start to end in px and
 *  its duration in ms. null for anything that is neither a tap nor a clean
 *  swipe (a drag, a diagonal, a long press). */
export function touchToken(dx: number, dy: number, ms: number): CheatToken | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < TAP_MAX_PX && ay < TAP_MAX_PX) return ms <= TAP_MAX_MS ? 'tap' : null;
  if (ms > SWIPE_MAX_MS) return null;
  // Mostly along one axis: half again as far along it as across it.
  if (ax >= SWIPE_MIN_PX && ax >= 1.5 * ay) return dx > 0 ? 'right' : 'left';
  if (ay >= SWIPE_MIN_PX && ay >= 1.5 * ax) return dy > 0 ? 'down' : 'up';
  return null;
}

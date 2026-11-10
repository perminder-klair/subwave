// The machine's moving state, held outside React: the message and the rotors
// it turns, the key held down, the bulb a typed letter lit, and the frame the
// ambient clock last drew. The clock writes a frame as often as every 28 ms;
// held in the skin's own state, every tick re-rendered the whole machine (both
// layouts, ~1,000 nodes) at up to ~36 Hz, which iPad Safari could not keep up
// with. Here only the leaves that show a clock-rate value — a bulb, a tape
// character, a rotor window, the rotor readout — subscribe to that one value
// (useMachine), and the skin re-renders only when the message changes. No
// React here, so the reducer and the store can be tested on their own.

import { EMPTY_MESSAGE, deleteLast, stepRotors, typeInto, type Message, type Rotors } from './cipher';

/** What the lampboard and the tape show between keypresses. */
export interface Frame {
  /** The keys run the bulbs, not the clock. */
  keys: boolean;
  /** The bulb the clock lit. */
  lit: string | null;
  /** Index into the song's lamp sequence on the beat, -1 when none. */
  cursor: number;
  /** Tuning sweep: how much of the title has resolved (0–1), and the scatter
   *  seed for the rest. */
  scramble: number;
  seed: number;
  /** Characters of the DJ's line typed so far. */
  talkN: number;
}

export interface MachineState {
  msg: Message;
  /** The key held down: a letter, 'SPACE', or null. */
  down: string | null;
  /** The bulb the last typed letter lit. */
  keyLit: string | null;
  frame: Frame;
}

export type MachineAction =
  | { type: 'type'; ch: string; vol: number }
  | { type: 'up' }
  | { type: 'unlight' }
  | { type: 'del' }
  | { type: 'clear' }
  | { type: 'rotors'; rotors: Rotors }
  /** A clock tick: what it draws, and how the rotors move with it. */
  | { type: 'frame'; frame: Frame; rotors?: Rotors | 'step' };

/** Nothing running: the keys have the board, the title is resolved. */
export const STILL: Frame = { keys: true, lit: null, cursor: -1, scramble: 1, seed: 0, talkN: 0 };

const keyId = (ch: string) => (ch === ' ' ? 'SPACE' : ch.toUpperCase());

const sameFrame = (a: Frame, b: Frame) =>
  a.keys === b.keys && a.lit === b.lit && a.cursor === b.cursor
  && a.scramble === b.scramble && a.seed === b.seed && a.talkN === b.talkN;

/** Returns the same state when an action changes nothing, so the store can
 *  skip waking its readers. */
export function machineReducer(state: MachineState, action: MachineAction): MachineState {
  switch (action.type) {
    case 'type': {
      const typed = typeInto(state.msg, action.ch, action.vol);
      // A key that types nothing still goes down.
      if (!typed) return state.down === keyId(action.ch) ? state : { ...state, down: keyId(action.ch) };
      return { ...state, msg: typed.msg, down: keyId(action.ch), keyLit: typed.lamp };
    }
    case 'up':
      return state.down ? { ...state, down: null } : state;
    case 'unlight':
      return state.keyLit ? { ...state, keyLit: null } : state;
    case 'del':
      return state.msg.plain ? { ...state, msg: deleteLast(state.msg), keyLit: null } : state;
    case 'clear':
      return state.msg.plain ? { ...state, msg: { ...EMPTY_MESSAGE, rotors: state.msg.rotors }, keyLit: null } : state;
    case 'rotors': {
      const { middle, right } = action.rotors;
      const now = state.msg.rotors;
      return middle === now.middle && right === now.right ? state : { ...state, msg: { ...state.msg, rotors: action.rotors } };
    }
    case 'frame': {
      const moved = action.rotors === 'step' ? stepRotors(state.msg.rotors) : action.rotors;
      const next = moved ? machineReducer(state, { type: 'rotors', rotors: moved }) : state;
      return sameFrame(next.frame, action.frame) ? next : { ...next, frame: action.frame };
    }
  }
}

/** The bulb lit now. A message on the tape always hands the board to the
 *  keys, even before the clock has heard it should stop. */
export const litOf = (s: MachineState): string | null => (s.frame.keys || s.msg.plain ? s.keyLit : s.frame.lit);

export interface MachineStore {
  get: () => MachineState;
  dispatch: (action: MachineAction) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createMachineStore(rotors: Rotors): MachineStore {
  let state: MachineState = { msg: { ...EMPTY_MESSAGE, rotors }, down: null, keyLit: null, frame: STILL };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    dispatch: action => {
      const next = machineReducer(state, action);
      if (next === state) return;
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

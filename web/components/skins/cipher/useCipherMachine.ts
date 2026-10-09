'use client';

// The machine's moving state: the listener's message and the rotors it turns,
// which key is held, which bulb is lit — and one ambient clock that runs the
// lampboard when nobody is typing (the tuning sweep, the song spelled out on
// the beat, the DJ's words typed onto the tape). The clock is a chain of
// timeouts, one per letter rather than a frame loop, and it stands down
// entirely when the skin is calm (lite or reduced motion): the render then
// paints a still frame.

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  EMPTY_MESSAGE,
  SCAN,
  deleteLast,
  foldLetter,
  scatter,
  stepRotors,
  typeInto,
  type Message,
  type Rotors,
} from './cipher';

/** What the ambient clock is running. */
export type Ambient = 'off' | 'connecting' | 'music' | 'talk';

export interface MachineInput {
  /** What the clock should run while nobody is typing; a message on the tape
   *  always switches it off, so the bulbs answer the keys. */
  ambient: Ambient;
  /** Lite or reduced motion: no clock, a still frame. */
  calm: boolean;
  /** Rotor I's position (the volume), which enciphers along with II and III. */
  vol: number;
  /** The song as lampboard entries (see lampSequence). */
  seq: (string | null)[];
  /** Milliseconds per lampboard letter. */
  beat: number;
  /** When the track started (epoch ms), so the spelling starts with the song. */
  anchor: number | null;
  /** The DJ's line, typed out while it airs. */
  talk: string;
  /** Milliseconds per typed character of `talk`. */
  talkMs: number;
}

/** Where the lampboard is in the song, as the tape prints it. */
export interface Spelling {
  /** Index into the song's sequence on the beat, -1 when none. */
  cursor: number;
  /** Tuning sweep: how much of the title has resolved (0–1), and the scatter
   *  seed for the rest. */
  scramble: number;
  seed: number;
}

export interface Machine {
  msg: Message;
  /** The key held down: a letter, 'SPACE', or null. */
  down: string | null;
  /** The bulb lit right now. */
  lit: string | null;
  spelling: Spelling;
  /** Characters of the DJ's line typed so far. */
  talkN: number;
  /** Type a character. `hold` keeps the key down (and its bulb lit) until
   *  release(); otherwise it springs back on its own. */
  press: (ch: string, hold?: boolean) => void;
  release: () => void;
  del: () => void;
  clear: () => void;
  setRotors: (rotors: Rotors) => void;
}

interface State {
  msg: Message;
  down: string | null;
  keyLit: string | null;
}

type Action =
  | { type: 'type'; ch: string; vol: number }
  | { type: 'up' }
  | { type: 'unlight' }
  | { type: 'del' }
  | { type: 'clear' }
  | { type: 'step' }
  | { type: 'rotors'; rotors: Rotors };

const keyId = (ch: string) => (ch === ' ' ? 'SPACE' : ch.toUpperCase());

function machineReducer(state: State, action: Action): State {
  switch (action.type) {
    case 'type': {
      const typed = typeInto(state.msg, action.ch, action.vol);
      // A key that types nothing still goes down.
      if (!typed) return { ...state, down: keyId(action.ch) };
      return { msg: typed.msg, down: keyId(action.ch), keyLit: typed.lamp };
    }
    case 'up':
      return state.down ? { ...state, down: null } : state;
    case 'unlight':
      return state.keyLit ? { ...state, keyLit: null } : state;
    case 'del':
      return state.msg.plain ? { ...state, msg: deleteLast(state.msg), keyLit: null } : state;
    case 'clear':
      return state.msg.plain ? { ...state, msg: { ...EMPTY_MESSAGE, rotors: state.msg.rotors }, keyLit: null } : state;
    case 'step':
      return { ...state, msg: { ...state.msg, rotors: stepRotors(state.msg.rotors) } };
    case 'rotors':
      return { ...state, msg: { ...state.msg, rotors: action.rotors } };
  }
}

// The sweep re-randomises every 60ms; the title resolves over 1.8s and holds
// for 0.8s before searching again, for as long as the stream takes to lock.
const SWEEP_MS = 60;
const RESOLVE_MS = 1800;
const SWEEP_CYCLE_MS = 2600;
// How long a typed letter's bulb stays lit, held or not.
const KEY_LIT_MS = 700;
const RELEASE_LIT_MS = 120;
const KEY_SPRING_MS = 160;

interface AmbientFrame {
  /** Which run this frame belongs to; a stale frame from the previous run is
   *  ignored rather than flashed. */
  run: string;
  lit: string | null;
  cursor: number;
  talkN: number;
  scramble: number;
  seed: number;
}

export function useCipherMachine(input: MachineInput): Machine {
  const { calm, vol, seq, beat, anchor, talk, talkMs } = input;
  const [s, dispatch] = useReducer(machineReducer, {
    msg: { ...EMPTY_MESSAGE, rotors: { middle: 10, right: 16 } },
    down: null,
    keyLit: null,
  });
  const ambient: Ambient = s.msg.plain ? 'off' : input.ambient;

  const timers = useRef<{ spring?: number; unlight?: number }>({});
  useEffect(() => {
    const t = timers.current;
    return () => {
      window.clearTimeout(t.spring);
      window.clearTimeout(t.unlight);
    };
  }, []);

  const unlightIn = (ms: number) => {
    window.clearTimeout(timers.current.unlight);
    timers.current.unlight = window.setTimeout(() => dispatch({ type: 'unlight' }), ms);
  };

  const press = (ch: string, hold = false) => {
    window.clearTimeout(timers.current.spring);
    window.clearTimeout(timers.current.unlight);
    dispatch({ type: 'type', ch, vol });
    if (hold) return;
    timers.current.spring = window.setTimeout(() => dispatch({ type: 'up' }), KEY_SPRING_MS);
    unlightIn(KEY_LIT_MS);
  };

  const release = () => {
    window.clearTimeout(timers.current.spring);
    dispatch({ type: 'up' });
    unlightIn(RELEASE_LIT_MS);
  };

  // The run key names everything that restarts the clock; the sequence rides
  // a ref so a fresh array with the same letters doesn't.
  const seqKey = seq.join('');
  const seqRef = useRef(seq);
  seqRef.current = seq;
  const run = `${ambient}|${seqKey}|${anchor ?? ''}|${talk}`;
  const live = !calm && ambient !== 'off';

  const [frame, setFrame] = useState<AmbientFrame | null>(null);

  useEffect(() => {
    if (!live) return;
    const start = Date.now();
    let timer = 0;
    let last = -1;

    const sweep = () => {
      const el = Date.now() - start;
      const k = Math.floor(el / SWEEP_MS);
      setFrame({
        run, lit: SCAN[k % SCAN.length] ?? null, cursor: -1, talkN: 0,
        scramble: Math.min(1, (el % SWEEP_CYCLE_MS) / RESOLVE_MS), seed: k,
      });
      dispatch({ type: 'rotors', rotors: { middle: scatter(k, 1), right: scatter(k, 2) } });
      timer = window.setTimeout(sweep, SWEEP_MS);
    };

    const spell = () => {
      const list = seqRef.current;
      if (!list.length) return;
      const since = Math.max(0, Date.now() - (anchor ?? start));
      const i = Math.floor(since / beat) % list.length;
      if (i !== last) {
        const lamp = list[i] ?? null;
        setFrame({ run, lit: lamp, cursor: i, talkN: 0, scramble: 1, seed: 0 });
        // The right rotor steps once per decoded letter.
        if (lamp && last !== -1) dispatch({ type: 'step' });
        last = i;
      }
      timer = window.setTimeout(spell, beat - (since % beat) + 4);
    };

    const chars = Array.from(talk);
    const type = () => {
      const n = Math.floor((Date.now() - start) / talkMs);
      if (n !== last) {
        last = n;
        const lamp = n < chars.length ? foldLetter(chars[n] ?? '') : null;
        setFrame({ run, lit: lamp, cursor: -1, talkN: Math.min(n + 1, chars.length), scramble: 1, seed: 0 });
        if (lamp) dispatch({ type: 'step' });
      }
      // The line is down on the tape; the clock's job is done.
      if (n >= chars.length) return;
      timer = window.setTimeout(type, talkMs);
    };

    if (ambient === 'connecting') sweep();
    else if (ambient === 'music') spell();
    else if (ambient === 'talk' && talkMs > 0) type();
    return () => window.clearTimeout(timer);
  }, [live, run, ambient, anchor, beat, talk, talkMs]);

  // A frame from another run (or none yet) reads as that run's first moment;
  // calm reads as its finished still frame.
  const f = live && frame?.run === run ? frame : null;
  const talkLen = Array.from(talk).length;

  return {
    msg: s.msg,
    down: s.down,
    lit: ambient === 'off' ? s.keyLit : (f?.lit ?? null),
    spelling: {
      cursor: f?.cursor ?? -1,
      scramble: live && ambient === 'connecting' ? (f?.scramble ?? 0) : 1,
      seed: f?.seed ?? 0,
    },
    talkN: live ? (f?.talkN ?? 0) : talkLen,
    press,
    release,
    del: useCallback(() => dispatch({ type: 'del' }), []),
    clear: useCallback(() => dispatch({ type: 'clear' }), []),
    setRotors: useCallback((rotors: Rotors) => dispatch({ type: 'rotors', rotors }), []),
  };
}

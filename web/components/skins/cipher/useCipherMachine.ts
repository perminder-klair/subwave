'use client';

// The machine's moving state: the listener's message and the rotors it turns,
// which key is held, which bulb is lit — and one ambient clock that runs the
// lampboard when nobody is typing (the tuning sweep, the song spelled out on
// the beat, the DJ's words typed onto the tape). The clock is a chain of
// timeouts, one per letter rather than a frame loop, and it stands down
// entirely when the skin is calm (lite or reduced motion): it then draws one
// still frame. All of it lives in a store outside React (machineStore.ts says
// why): the skin reads only the message, and each leaf reads its own value
// through useMachine.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { SCAN, foldLetter, mod26, scatter, type Rotors } from './cipher';
import { STILL, createMachineStore, type Frame, type MachineState, type MachineStore } from './machineStore';

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

export interface Machine {
  /** Where the leaves read the clock-rate state (useMachine). */
  store: MachineStore;
  /** The message on the tape, and its cipher. */
  plain: string;
  cipher: string;
  /** Type a character. `hold` keeps the key down (and its bulb lit) until
   *  release(); otherwise it springs back on its own. */
  press: (ch: string, hold?: boolean) => void;
  release: () => void;
  del: () => void;
  clear: () => void;
  /** Set rotor II (middle) or III (right) by hand. */
  turn: (which: keyof Rotors, to: number) => void;
}

/** One value from the machine. The caller re-renders only when that value
 *  changes, so `select` returns a primitive or a reference held in the state,
 *  never a fresh object. */
export function useMachine<T>(store: MachineStore, select: (s: MachineState) => T): T {
  const read = () => select(store.get());
  return useSyncExternalStore(store.subscribe, read, read);
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

export function useCipherMachine(input: MachineInput): Machine {
  const { calm, vol, seq, beat, anchor, talk, talkMs } = input;
  const [store] = useState(() => createMachineStore({ middle: 10, right: 16 }));
  const { dispatch } = store;
  const plain = useMachine(store, s => s.msg.plain);
  const cipher = useMachine(store, s => s.msg.cipher);
  const ambient: Ambient = plain ? 'off' : input.ambient;

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

  // A layout effect, so a new run's first frame replaces the last run's
  // before the browser paints: a new song never flashes the old one's beat.
  useLayoutEffect(() => {
    const chars = Array.from(talk);
    if (!live) {
      // Calm reads as the run's finished still frame: the line typed out.
      dispatch({ type: 'frame', frame: { ...STILL, keys: ambient === 'off', talkN: chars.length } });
      return;
    }
    // The run's first moment, until its first tick says otherwise.
    const first: Frame = { ...STILL, keys: false, scramble: ambient === 'connecting' ? 0 : 1 };
    dispatch({ type: 'frame', frame: first });
    const start = Date.now();
    let timer = 0;
    let last = -1;

    const sweep = () => {
      const el = Date.now() - start;
      const k = Math.floor(el / SWEEP_MS);
      dispatch({
        type: 'frame',
        frame: { ...first, lit: SCAN[k % SCAN.length] ?? null, scramble: Math.min(1, (el % SWEEP_CYCLE_MS) / RESOLVE_MS), seed: k },
        rotors: { middle: scatter(k, 1), right: scatter(k, 2) },
      });
      timer = window.setTimeout(sweep, SWEEP_MS);
    };

    const spell = () => {
      const list = seqRef.current;
      if (!list.length) return;
      const since = Math.max(0, Date.now() - (anchor ?? start));
      const i = Math.floor(since / beat) % list.length;
      if (i !== last) {
        const lamp = list[i] ?? null;
        // The right rotor steps once per decoded letter.
        dispatch({ type: 'frame', frame: { ...first, lit: lamp, cursor: i }, rotors: lamp && last !== -1 ? 'step' : undefined });
        last = i;
      }
      timer = window.setTimeout(spell, beat - (since % beat) + 4);
    };

    const type = () => {
      const n = Math.floor((Date.now() - start) / talkMs);
      if (n !== last) {
        last = n;
        const lamp = n < chars.length ? foldLetter(chars[n] ?? '') : null;
        dispatch({ type: 'frame', frame: { ...first, lit: lamp, talkN: Math.min(n + 1, chars.length) }, rotors: lamp ? 'step' : undefined });
      }
      // The line is down on the tape; the clock's job is done.
      if (n >= chars.length) return;
      timer = window.setTimeout(type, talkMs);
    };

    if (ambient === 'connecting') sweep();
    else if (ambient === 'music') spell();
    else if (ambient === 'talk' && talkMs > 0) type();
    return () => window.clearTimeout(timer);
  }, [live, run, ambient, anchor, beat, talk, talkMs, dispatch]);

  return {
    store,
    plain,
    cipher,
    press,
    release,
    del: useCallback(() => dispatch({ type: 'del' }), [dispatch]),
    clear: useCallback(() => dispatch({ type: 'clear' }), [dispatch]),
    turn: useCallback(
      (which: keyof Rotors, to: number) =>
        dispatch({ type: 'rotors', rotors: { ...store.get().msg.rotors, [which]: mod26(to) } }),
      [dispatch, store],
    ),
  };
}

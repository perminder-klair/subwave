'use client';

// The scope pane: one of the four instruments, live off the shared signal.

import { useRef } from 'react';
import AsciiCanvas from './term/AsciiCanvas';
import type { Grid } from './term/grid';
import { STILL_SIGNAL, type Signal } from './term/signal';
import { createInstrumentState, drawInstrument, type InstrumentId } from './instruments';

export default function Scope({ id, sample, calm, paused }: {
  id: InstrumentId;
  sample: (nowMs: number) => Signal;
  calm: boolean;
  /** Covered by the tune-in screen. */
  paused: boolean;
}) {
  const state = useRef(createInstrumentState());
  const paint = (g: Grid, t: number) =>
    drawInstrument(id, g, calm ? STILL_SIGNAL : sample(performance.now()), t, state.current);
  return (
    <AsciiCanvas
      paint={paint} fontSize={12} fps={30} still={calm} stillAt={4} frame={id} lineHeight={1.15} glow paused={paused}
      className="h-full w-full"
    />
  );
}

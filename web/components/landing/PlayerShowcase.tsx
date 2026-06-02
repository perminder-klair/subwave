'use client';

import { m } from 'motion/react';
import PlayerApp from '../PlayerApp';

// Browser-window mock chrome wrapping the actual V3 player. Same React tree
// as the rest of the page — no iframe — so theme switches and dev reloads
// flow through, and the embed weighs ~nothing extra. The player runs in
// `contained` mode so it pins to the frame, not the viewport, and its
// drawers/dialogs portal into the frame too.
//
// The LIVE chip pulses once on mount — a "broadcast is on right now"
// callout as the showcase appears. The bs-live-dot CSS pulse continues
// independently after the chip settles.

export default function PlayerShowcase() {
  return (
    <div className="bs-frame">
      <div className="bs-frame-bar">
        <div className="bs-frame-dots" aria-hidden="true">
          <span className="bs-frame-dot" data-tone="r" />
          <span className="bs-frame-dot" data-tone="y" />
          <span className="bs-frame-dot" data-tone="g" />
        </div>
        <div className="bs-frame-url">
          <span className="text-muted">https://</span>
          <span>getsubwave.com</span>
          <span className="text-muted">/listen</span>
        </div>
        <m.div
          className="bs-frame-live"
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.6, ease: [0.2, 0.7, 0.2, 1] }}
          aria-hidden="true"
        >
          <span className="bs-live-dot" />
          <span>LIVE</span>
        </m.div>
      </div>

      <div className="bs-frame-screen">
        <PlayerApp contained />
      </div>
    </div>
  );
}

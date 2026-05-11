'use client';

import PlayerApp from '../PlayerApp';

// Browser-window mock chrome wrapping the actual V3 player. Same React tree
// as the rest of the page — no iframe — so theme switches and dev reloads
// flow through, and the embed weighs ~nothing extra. The player runs in
// `contained` mode so it pins to the frame, not the viewport, and its
// drawers/dialogs portal into the frame too.

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
          <span style={{ color: 'var(--muted)' }}>https://</span>
          <span>subwave.zeiq.co</span>
          <span style={{ color: 'var(--muted)' }}>/listen</span>
        </div>
        <div className="bs-frame-live" aria-hidden="true">
          <span className="bs-live-dot" />
          <span>LIVE</span>
        </div>
      </div>

      <div className="bs-frame-screen">
        <PlayerApp contained />
      </div>
    </div>
  );
}

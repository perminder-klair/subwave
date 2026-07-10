import * as React from 'react';
import { Ripple } from 'sub-wave-web';

// Concentric ink rings behind the player's now-playing art / live indicator.
// Absolutely positioned (inset-0) with a top-to-transparent mask, so it needs
// a relative, sized host. The pulse animates; statically it paints the rings.
export const Default = () => (
  <div
    style={{
      position: 'relative',
      width: 320,
      height: 220,
      overflow: 'hidden',
      border: '1px solid var(--separator-strong)',
      background: 'var(--bg)',
    }}
  >
    <Ripple />
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: 'var(--ink)',
      }}
    >
      On air
    </div>
  </div>
);

export const Tight = () => (
  <div
    style={{
      position: 'relative',
      width: 320,
      height: 220,
      overflow: 'hidden',
      border: '1px solid var(--separator-strong)',
      background: 'var(--bg)',
    }}
  >
    <Ripple mainCircleSize={120} numCircles={5} mainCircleOpacity={0.32} />
  </div>
);

export const Inactive = () => (
  <div
    style={{
      position: 'relative',
      width: 320,
      height: 220,
      overflow: 'hidden',
      border: '1px solid var(--separator-strong)',
      background: 'var(--bg)',
    }}
  >
    <Ripple active={false} />
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: 'var(--muted)',
      }}
    >
      Off air
    </div>
  </div>
);

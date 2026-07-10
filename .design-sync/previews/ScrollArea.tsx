import * as React from 'react';
import { ScrollArea } from 'sub-wave-web';

const HISTORY = [
  ['New Order', 'Blue Monday'],
  ['Talking Heads', 'This Must Be the Place'],
  ['Aphex Twin', 'Xtal'],
  ['Kraftwerk', 'Neon Lights'],
  ['Portishead', 'Roads'],
  ['Boards of Canada', 'Roygbiv'],
  ['Massive Attack', 'Teardrop'],
  ['LCD Soundsystem', 'All My Friends'],
  ['Burial', 'Archangel'],
  ['Radiohead', 'Idioteque'],
  ['Four Tet', 'Angel Echoes'],
  ['Caribou', 'Odessa'],
];

// Fixed-height scroll region over an overflowing play-history list. type="always"
// keeps the newsprint thumb visible for static capture; the ScrollBar is
// rendered internally by ScrollArea.
export const PlayHistory = () => (
  <div style={{ maxWidth: 360 }}>
    <ScrollArea type="always" style={{ height: 200, border: '1px solid var(--ink)' }}>
      <div style={{ padding: '4px 0' }}>
        {HISTORY.map(([artist, title], i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: 12,
              padding: '10px 14px',
              borderBottom: i < HISTORY.length - 1 ? '1px solid var(--ink-soft)' : undefined,
            }}
          >
            <span style={{ fontSize: 13 }}>
              <strong style={{ fontWeight: 600 }}>{artist}</strong>
              <span style={{ opacity: 0.6 }}> — {title}</span>
            </span>
            <span style={{ fontSize: 11, opacity: 0.5, whiteSpace: 'nowrap' }}>
              {`${i}m ago`}
            </span>
          </div>
        ))}
      </div>
    </ScrollArea>
  </div>
);

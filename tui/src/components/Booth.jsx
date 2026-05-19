import React from 'react';
import { Box, Text } from 'ink';
import { turnClass, turnText } from '../lib/sessionFeed.js';
import { c, glyph } from '../theme.js';

const COLOR = { voice: c.accent, dj: undefined, track: c.lcdDim };
const MARKER = { voice: glyph.voice, dj: glyph.djDot, track: glyph.track };
// Faux EQ-band lead-ins — the bar height ramps with row index, so the
// newest turn (rendered at the top) reads as the tallest band. Matches
// Winamp's settled EQ curve aesthetic without needing a tick.
const BANDS = ['▕▎', '▕▍', '▕▌', '▕▋', '▕▊', '▕▉', '▕█', '▕█'];

// Booth EQ — the live DJ session, newest first. System turns are
// operator-facing and dropped, matching the web Booth drawer.
export default function Booth({ items = [] }) {
  const turns = items
    .filter(t => turnClass(t) !== 'system')
    .slice(-8)
    .reverse();

  if (!turns.length) {
    return <Text dimColor>The booth is quiet right now.</Text>;
  }
  return (
    <Box flexDirection="column">
      {turns.map((t, i) => {
        const cls = turnClass(t);
        const band = BANDS[Math.min(BANDS.length - 1, BANDS.length - 1 - i)];
        return (
          <Text key={`${t.t || 'x'}-${i}`}>
            <Text color={c.lcdDim}>{band} </Text>
            <Text color={COLOR[cls]}>{MARKER[cls] || glyph.djDot} {turnText(t)}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

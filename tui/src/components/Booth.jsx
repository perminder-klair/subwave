import React from 'react';
import { Box, Text } from 'ink';
import { turnClass, turnText } from '../lib/sessionFeed.js';

const COLOR = { voice: 'magenta', dj: 'white', track: 'gray' };
const MARKER = { voice: '◆ ', dj: '· ', track: '▶ ' };

// The live DJ session, from GET /session — newest first. System turns are
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
        return (
          <Text key={`${t.t || 'x'}-${i}`} color={COLOR[cls] || 'gray'}>
            {MARKER[cls] || '· '}{turnText(t)}
          </Text>
        );
      })}
    </Box>
  );
}

import React from 'react';
import { Box, Text } from 'ink';

// Queue + history, from GET /state. upcoming/history items are flat
// { title, artist, requestedBy } records.
export default function Timeline({ upcoming = [], history = [] }) {
  if (!upcoming.length && !history.length) {
    return <Text dimColor>Nothing played yet — the DJ is on autopilot. Request a track to jump the line.</Text>;
  }
  return (
    <Box flexDirection="column">
      {upcoming.length > 0 && <Text dimColor>UP NEXT</Text>}
      {upcoming.slice(0, 4).map((t, i) => (
        <Text key={`u${i}`}>
          <Text color="cyan">{String(i + 1).padStart(2, '0')} </Text>
          {t.title} <Text dimColor>— {t.artist}</Text>
          {t.requestedBy ? <Text color="yellow"> ✦ {t.requestedBy}</Text> : null}
        </Text>
      ))}
      {history.length > 0 && (
        <Box marginTop={upcoming.length ? 1 : 0}><Text dimColor>RECENTLY PLAYED</Text></Box>
      )}
      {history.slice(0, 4).map((t, i) => (
        <Text key={`h${i}`} dimColor>·  {t.title} — {t.artist}</Text>
      ))}
    </Box>
  );
}

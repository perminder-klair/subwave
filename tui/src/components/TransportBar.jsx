import React from 'react';
import { Box, Text } from 'ink';

const HINTS = 'space tune · ↑↓ vol · m mute · 1 timeline · 2 booth · 3 request · ? help · q quit';

// Bottom strip: playback state, volume, and the keyboard legend.
export default function TransportBar({ player, offline }) {
  const { tunedIn, volume, muted, available, supportsVolume, engine } = player;

  let state;
  if (!available) state = <Text color="yellow">no audio engine — install mpv or ffplay to listen</Text>;
  else if (offline) state = <Text color="red">■ station off air</Text>;
  else if (tunedIn) state = <Text color="green">{`▶ tuned in (${engine})`}</Text>;
  else state = <Text dimColor>■ tuned out</Text>;

  let volStr = null;
  if (available && supportsVolume) volStr = muted ? 'muted' : `vol ${volume}%`;
  else if (available && !supportsVolume) volStr = 'volume needs mpv';

  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text>
        {state}
        {volStr ? <Text dimColor>{`  ·  ${volStr}`}</Text> : null}
      </Text>
      <Text dimColor>{HINTS}</Text>
    </Box>
  );
}

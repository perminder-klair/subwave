import React from 'react';
import { Box, Text } from 'ink';
import { c, glyph } from '../theme.js';

// Fake Winamp window titlebar for the whole app: the wordmark on the left
// (treated as the active titlebar text in amber), DJ + show as a dim
// subtitle, and a right-hand status cluster — on-air LED + listener count
// as a beveled "[ 003 LSTNRS ]" badge.
//
// Weather + day-of-week used to live here; they've moved into the MAIN
// LCD where they read more like a Winamp readout than a chrome detail.
export default function TopBar({ dj, activeShow, listeners, streamOnline }) {
  const onAir = streamOnline !== false;
  const showLabel = activeShow?.name ? `  ${glyph.shimR}  ${activeShow.name}` : '';
  const count = listeners?.current ?? 0;
  const countLabel = String(count).padStart(3, '0');

  return (
    <Box justifyContent="space-between" paddingX={1} flexShrink={0}>
      <Text>
        <Text color={c.lcdDim}>{glyph.shimL} </Text>
        <Text bold color={c.title}>SUB/WAVE</Text>
        <Text color={c.lcdDim}> {glyph.shimR}</Text>
        <Text dimColor>{`  ${dj?.name || 'Frequency'}${showLabel}`}</Text>
      </Text>
      <Text>
        <Text color={onAir ? c.ok : c.danger}>
          {onAir ? `${glyph.led} ON AIR` : `${glyph.ledOff} OFF AIR`}
        </Text>
        <Text color={c.chrome}>  [</Text>
        <Text color={c.bitrate}> {countLabel} LSTNRS </Text>
        <Text color={c.chrome}>]</Text>
      </Text>
    </Box>
  );
}

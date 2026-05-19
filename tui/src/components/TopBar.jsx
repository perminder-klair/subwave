import React from 'react';
import { Box, Text } from 'ink';

// Station identity strip: SUB/WAVE wordmark, DJ / show, the moment's context,
// on-air state, and the live listener count.
export default function TopBar({ dj, activeShow, listeners, context, streamOnline }) {
  const onAir = streamOnline !== false;
  const w = context?.weather;
  const weatherStr = w && w.temp != null ? `${w.temp}° ${w.condition}` : null;

  return (
    <Box justifyContent="space-between" borderStyle="round" borderColor="gray" paddingX={1}>
      <Text>
        <Text bold color="cyan">SUB/WAVE</Text>
        <Text dimColor>  ·  </Text>
        <Text>{dj?.name || 'Frequency'}</Text>
        {activeShow?.name ? <Text dimColor>{`  ·  ${activeShow.name}`}</Text> : null}
      </Text>
      <Text>
        {context?.date?.dayLabel ? <Text dimColor>{context.date.dayLabel}  </Text> : null}
        {weatherStr ? <Text dimColor>{weatherStr}  </Text> : null}
        <Text color={onAir ? 'green' : 'red'}>{onAir ? '● ON AIR' : '○ OFF AIR'}</Text>
        {listeners ? <Text dimColor>{`  ${listeners.current} ♪`}</Text> : null}
      </Text>
    </Box>
  );
}

import React from 'react';
import { Box, Text } from 'ink';
import { fmtClock, progressBar } from '../lib/format.js';
import { turnText } from '../lib/sessionFeed.js';

// Center stage: the current track, an elapsed-driven progress bar, and the
// most recent thing the DJ said on air. Elapsed is derived from
// trackStartedAt on each render — the parent re-renders on the 5s poll and
// that's what advances the bar. We intentionally do NOT run a per-second
// tick: in this terminal, frequent re-renders flash the whole frame visibly.
export default function NowPlaying({ nowPlaying, trackStartedAt, session, offline }) {
  if (offline) {
    return (
      <Box paddingX={1} paddingY={1}>
        <Text color="red">Station is off air — nothing to play right now.</Text>
      </Box>
    );
  }
  if (!nowPlaying) {
    return (
      <Box paddingX={1} paddingY={1}>
        <Text dimColor>Waiting for the station…</Text>
      </Box>
    );
  }

  const dur = nowPlaying.duration || 0;
  const elapsed = trackStartedAt
    ? Math.max(0, Math.floor((Date.now() - trackStartedAt) / 1000))
    : 0;
  const progress = dur > 0 ? Math.min(1, elapsed / dur) : 0;
  const messages = session?.messages || [];
  // Latest on-air voice line, falling back to the DJ's reasoning turn.
  const latest = [...messages].reverse().find(m => m.role === 'segment')
    || [...messages].reverse().find(m => m.role === 'dj');

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>{nowPlaying.title || 'Unknown track'}</Text>
      <Text color="cyan">{nowPlaying.artist || ''}</Text>
      {nowPlaying.requestedBy
        ? <Text color="yellow">✦ requested by {nowPlaying.requestedBy}</Text>
        : null}
      <Box marginTop={1}>
        <Text dimColor>{fmtClock(elapsed)} </Text>
        <Text color="green">{progressBar(progress, 36)}</Text>
        <Text dimColor> {dur ? fmtClock(dur) : '--:--'}</Text>
      </Box>
      {latest
        ? <Box marginTop={1}><Text dimColor italic>“{turnText(latest)}”</Text></Box>
        : null}
    </Box>
  );
}

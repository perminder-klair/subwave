import React from 'react';
import { Box, Text } from 'ink';
import { c, glyph } from '../theme.js';
import { fmtClock } from '../lib/format.js';

// Winamp Playlist Editor — up-next, the now-playing carat row in the
// middle, then recently-played below a separator. /state's upcoming and
// history lists both *exclude* the current track, so we splice a
// synthetic carat row from `nowPlaying` between them.
//
// Track numbers in cyan; requestedBy in Winamp-purple (accent magenta).
// Durations are only shown where the data exists — /state doesn't carry
// durations for upcoming/history items, only for nowPlaying.
export default function Timeline({ upcoming = [], history = [], nowPlaying }) {
  const empty = !upcoming.length && !history.length && !nowPlaying;
  if (empty) {
    return (
      <Box flexDirection="column" alignItems="center" paddingY={1}>
        <Text color={c.title}>* * *  P R E S S   3   T O   R E Q U E S T  * * *</Text>
        <Text dimColor>nothing played yet — the DJ is on autopilot</Text>
      </Box>
    );
  }
  const up = upcoming.slice(0, 4);
  const hist = history.slice(0, 4);
  // Carat row index = number of upcoming rows above it.
  let idx = 0;
  return (
    <Box flexDirection="column">
      {up.length > 0 && <Text color={c.lcdDim}>UP NEXT</Text>}
      {up.map((t, i) => {
        idx += 1;
        return <Row key={`u${i}`} n={idx} track={t} />;
      })}

      {nowPlaying ? (
        <>
          {up.length > 0 ? null : <Text color={c.lcdDim}>NOW PLAYING</Text>}
          <Row
            n={idx + 1}
            track={nowPlaying}
            carat
            duration={nowPlaying.duration ? fmtClock(nowPlaying.duration) : null}
          />
        </>
      ) : null}

      {hist.length > 0 && (
        <Box marginTop={up.length || nowPlaying ? 1 : 0}>
          <Text color={c.lcdDim}>──── RECENTLY PLAYED ────</Text>
        </Box>
      )}
      {hist.map((t, i) => <HistRow key={`h${i}`} track={t} />)}
    </Box>
  );
}

function Row({ n, track, carat = false, duration = null }) {
  return (
    <Text>
      <Text color={carat ? c.title : c.chrome}>{carat ? `${glyph.carat} ` : '  '}</Text>
      <Text color={c.bitrate}>{String(n).padStart(2, '0')}. </Text>
      <Text bold={carat}>{track.title || 'Unknown'}</Text>
      <Text dimColor> — {track.artist || ''}</Text>
      {carat ? <Text color={c.lcdDim}>  {glyph.shimL} now {glyph.shimR}</Text> : null}
      {track.requestedBy
        ? <Text color={c.accent}>  {glyph.request} {track.requestedBy}</Text>
        : null}
      {duration ? <Text color={c.lcdDim}>  {duration}</Text> : null}
    </Text>
  );
}

function HistRow({ track }) {
  return (
    <Text dimColor>
      ·  {track.title} — {track.artist}
      {track.requestedBy ? `  ✦ ${track.requestedBy}` : ''}
    </Text>
  );
}

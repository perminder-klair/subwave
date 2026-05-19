import React from 'react';
import { Box, Text } from 'ink';
import { c, glyph } from '../theme.js';

const HINTS = 'space ⏵⏸ · m mute · ↑↓ vol · 1/2/3 panels · ? q';
const VOL_WIDTH = 12;
const BAL_WIDTH = 8;

// Winamp's button strip + VOL/BAL sliders, plus the keyboard legend.
// Prev/next are rendered dim because there is no /skip endpoint — the
// station picks the next track itself (see CLAUDE.md). They're kept for
// the visual rhythm; the active glyph is play (when tuned in) or stop.
export default function TransportBar({ player, offline }) {
  const { tunedIn, volume, muted, available, supportsVolume } = player;

  const status = !available
    ? <Text color={c.warn}>{`✕ no engine — install mpv or ffplay`}</Text>
    : offline
      ? <Text color={c.danger}>{`${glyph.ledOff} station off air`}</Text>
      : tunedIn
        ? <Text color={c.ok}>{`${glyph.led} tuned in`}</Text>
        : <Text color={c.chrome}>{`${glyph.ledOff} tuned out`}</Text>;

  const active = tunedIn ? 'play' : 'stop';

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1} flexShrink={0}>
      <Box justifyContent="space-between">
        <Text>
          {status}
        </Text>
        <Text color={c.chrome}>{HINTS}</Text>
      </Box>
      <Box marginTop={1}>
        <Btn glyph={glyph.prev} dim />
        <Btn glyph={glyph.play} active={active === 'play' && available && !offline} />
        <Btn glyph={glyph.pause} dim />
        <Btn glyph={glyph.stop} active={active === 'stop'} />
        <Btn glyph={glyph.next} dim />
        <Text>  </Text>
        <Slider label="VOL" value={muted ? 0 : (volume || 0) / 100} width={VOL_WIDTH}
                color={supportsVolume ? c.accent : c.chrome}
                hint={!available
                  ? null
                  : !supportsVolume
                    ? '(needs mpv)'
                    : muted ? 'muted' : `${volume}%`} />
        <Text>  </Text>
        {/* Decorative — the controller is mono-stereo passthrough, the
            slider is cosmetic to keep the Winamp look. */}
        <Slider label="BAL" value={0.5} width={BAL_WIDTH} color={c.chrome} />
      </Box>
    </Box>
  );
}

function Btn({ glyph: g, active, dim }) {
  const color = active ? c.title : dim ? c.chrome : undefined;
  return (
    <Text>
      <Text color={c.chrome}>[ </Text>
      <Text color={color} bold={active}>{g}</Text>
      <Text color={c.chrome}> ] </Text>
    </Text>
  );
}

// 12-cell track ━━━━━●─────, with a label on the left and an optional
// status hint on the right.
function Slider({ label, value, width, color, hint }) {
  const v = Math.max(0, Math.min(1, value));
  const pos = Math.round(v * (width - 1));
  let track = '';
  for (let i = 0; i < width; i++) track += i === pos ? '●' : '━';
  return (
    <Text>
      <Text color={c.chrome}>{label} ▕</Text>
      <Text color={color}>{track}</Text>
      <Text color={c.chrome}>▏</Text>
      {hint ? <Text color={c.chrome}> {hint}</Text> : null}
    </Text>
  );
}

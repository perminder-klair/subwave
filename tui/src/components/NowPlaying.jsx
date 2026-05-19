import React from 'react';
import { Box, Text } from 'ink';
import WindowFrame from './WindowFrame.jsx';
import Spectrum from './Spectrum.jsx';
import { lcdClock, marquee, progressBar } from '../lib/format.js';
import { turnText } from '../lib/sessionFeed.js';
import {
  c, glyph,
  STREAM_BITRATE_LABEL, STREAM_SAMPLERATE_LABEL, STREAM_CHANNELS_LABEL,
} from '../theme.js';

const LCD_WIDTH = 48;       // marquee text width inside the LCD frame
const SPECTRUM_BANDS = 24;  // number of analyser bands (column width = 2 cells/band)
const SPECTRUM_HEIGHT = 8;  // rows of stacked block bars
const PROGRESS_WIDTH = 24;  // elapsed-bar fill width

// MAIN window — the Winamp main player's LCD area. Bitrate LEDs + weather
// on top, marquee track title, an 8-row stacked-block spectrum analyser,
// then the transport state + elapsed bar, then optional request flag +
// booth line.
//
// Elapsed is derived from trackStartedAt on each render. The animated
// spectrum drives the high-frequency redraws via Ink's `useAnimation`,
// and `render(... { incrementalRendering: true })` keeps the rest of the
// frame from being rewritten on every tick.
export default function NowPlaying({
  nowPlaying, trackStartedAt, session, context, offline, tunedIn,
}) {
  const w = context?.weather;
  const weatherStr = w && w.temp != null
    ? `${w.temp}° ${String(w.condition || '').toUpperCase()}`
    : null;
  const dayLabel = context?.date?.dayLabel || null;
  const live = !offline && !!nowPlaying;

  return (
    <WindowFrame title="MAIN" marginTop={1}>
      {/* Bitrate / sample-rate / channels LEDs — left; weather + day — right. */}
      <Box justifyContent="space-between">
        <Text>
          <Text color={c.ok}>{glyph.led} </Text>
          <Text color={c.bitrate}>{STREAM_BITRATE_LABEL}</Text>
          <Text dimColor>  </Text>
          <Text color={c.bitrate}>{STREAM_SAMPLERATE_LABEL}</Text>
          <Text dimColor>  </Text>
          <Text color={c.bitrate}>{STREAM_CHANNELS_LABEL}</Text>
        </Text>
        <Text>
          {weatherStr ? <Text color={c.lcdDim}>{weatherStr}</Text> : null}
          {weatherStr && dayLabel ? <Text dimColor>  </Text> : null}
          {dayLabel ? <Text dimColor>{dayLabel}</Text> : null}
        </Text>
      </Box>

      {offline
        ? <OfflineLcd />
        : !nowPlaying
          ? <WaitingLcd />
          : <LiveLcd nowPlaying={nowPlaying} trackStartedAt={trackStartedAt} session={session} tunedIn={tunedIn} />}

      {/* Spectrum lives outside the LCD-state branch so it keeps animating
          between station-feed polls and across track-end gaps; it pauses
          itself when the station is offline. */}
      <Box marginTop={1}>
        <Spectrum
          width={SPECTRUM_BANDS}
          height={SPECTRUM_HEIGHT}
          active={live}
          seed={nowPlaying?.title || (live ? 'on' : 'off')}
        />
      </Box>
    </WindowFrame>
  );
}

function OfflineLcd() {
  return (
    <Box marginTop={1} flexDirection="column">
      <LcdLine text={marquee('● ● ●  STATION OFF AIR  ● ● ●', LCD_WIDTH)} color={c.danger} />
      <Text dimColor>{glyph.stop}  no signal — nothing to play right now</Text>
    </Box>
  );
}

function WaitingLcd() {
  return (
    <Box marginTop={1} flexDirection="column">
      <LcdLine text={marquee('TUNING IN…', LCD_WIDTH)} />
      <Text dimColor>waiting for the station…</Text>
    </Box>
  );
}

function LiveLcd({ nowPlaying, trackStartedAt, session, tunedIn }) {
  const dur = nowPlaying.duration || 0;
  const elapsed = trackStartedAt
    ? Math.max(0, Math.floor((Date.now() - trackStartedAt) / 1000))
    : 0;
  const progress = dur > 0 ? Math.min(1, elapsed / dur) : 0;
  const title = nowPlaying.title || 'Unknown track';
  const artist = nowPlaying.artist || '';
  const marqueeText = artist ? `${artist} — ${title}` : title;

  const messages = session?.messages || [];
  // Latest on-air voice line, falling back to the DJ's reasoning turn.
  const latest = [...messages].reverse().find(m => m.role === 'segment')
    || [...messages].reverse().find(m => m.role === 'dj');

  return (
    <Box marginTop={1} flexDirection="column">
      <LcdLine text={marquee(marqueeText, LCD_WIDTH)} />
      <Text>
        <Text color={c.title}>{tunedIn ? glyph.play : glyph.stop} </Text>
        <Text color={c.lcdDim}>{lcdClock(elapsed)} </Text>
        <Text color={c.chrome}>[</Text>
        <Text color={c.lcd}>{progressBar(progress, PROGRESS_WIDTH)}</Text>
        <Text color={c.chrome}>] </Text>
        <Text color={c.lcdDim}>{dur ? lcdClock(dur) : '--:--'}</Text>
      </Text>
      {nowPlaying.requestedBy
        ? (
          <Text>
            <Text color={c.accent}>{glyph.request} requested by </Text>
            <Text color={c.accent} bold>{nowPlaying.requestedBy}</Text>
          </Text>
        )
        : null}
      {latest
        ? (
          <Text>
            <Text color={c.lcdDim}>{glyph.shimL} </Text>
            <Text color={c.lcdDim} italic>{turnText(latest)}</Text>
            <Text color={c.lcdDim}> {glyph.shimR}</Text>
          </Text>
        )
        : null}
    </Box>
  );
}

// A boxed LCD line: dim-green brackets around bright-green digits/text.
function LcdLine({ text, color = c.lcd }) {
  return (
    <Text>
      <Text color={c.lcdDim}>│ </Text>
      <Text color={color} bold>{text}</Text>
      <Text color={c.lcdDim}> │</Text>
    </Text>
  );
}

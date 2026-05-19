import React from 'react';
import { Box, Text } from 'ink';
import { c, glyph } from '../theme.js';

// A faux Winamp 2.x window: a double-line frame topped with a beveled
// titlebar that has shimmer chars on the left, the panel title in amber,
// and tiny `_ □ ✕` window-button glyphs on the right.
//
// The titlebar is drawn as a regular Text row above an Ink Box with
// `borderStyle="double"` — Ink doesn't let us style the top border itself,
// so we render the bar separately and rely on the double border below to
// finish the window look.
export default function WindowFrame({ title, children, marginTop = 0, grow = false }) {
  // `grow` lets the frame consume any remaining vertical space — set on
  // the active panel so the layout fills the terminal even on tall
  // terminals with sparse content.
  return (
    <Box
      flexDirection="column"
      marginTop={marginTop}
      flexGrow={grow ? 1 : 0}
      flexShrink={0}
    >
      <Box paddingX={1}>
        <Text>
          <Text color={c.lcdDim}>{glyph.shimL} </Text>
          <Text bold color={c.title}>{title}</Text>
          <Text color={c.lcdDim}> {glyph.shimR}</Text>
        </Text>
      </Box>
      <Box
        borderStyle="double"
        borderColor={c.chrome}
        flexDirection="column"
        paddingX={1}
        flexGrow={grow ? 1 : 0}
      >
        {children}
      </Box>
    </Box>
  );
}

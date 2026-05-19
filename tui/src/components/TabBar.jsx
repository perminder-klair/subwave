import React from 'react';
import { Box, Text } from 'ink';
import { c } from '../theme.js';

// A row of Winamp-style window-toggle "buttons" — the playlist, the
// booth, the add-track dialog, and the about screen. Keyboard shortcut
// sits inside square brackets to the left of the label.
//
// Rendered as a single <Text> node so Ink lays it out as one line (no
// flex children competing on the row direction) and `flexShrink={0}` so
// the row above the panel never collapses when the panel asks to grow.
const TABS = [
  { id: 'timeline', label: 'PL · PLAYLIST',  key: '1' },
  { id: 'booth',    label: 'EQ · BOOTH',     key: '2' },
  { id: 'request',  label: 'AT · ADD TRACK', key: '3' },
  { id: 'help',     label: 'AB · ABOUT',     key: '?' },
];

export default function TabBar({ active }) {
  return (
    <Box paddingX={1} marginTop={1} flexShrink={0}>
      <Text>
        {TABS.map((t, i) => {
          const isActive = t.id === active;
          return (
            <Text key={t.id}>
              <Text color={c.chrome}>[</Text>
              <Text color={isActive ? c.title : c.chrome} bold={isActive}>
                {` ${t.key} `}
              </Text>
              <Text color={c.chrome}>]</Text>
              <Text color={isActive ? c.lcd : c.chrome} bold={isActive}>
                {` ${t.label}`}
              </Text>
              {i < TABS.length - 1 ? <Text color={c.chrome}>   </Text> : null}
            </Text>
          );
        })}
      </Text>
    </Box>
  );
}

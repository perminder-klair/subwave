import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import TopBar from './components/TopBar.jsx';
import NowPlaying from './components/NowPlaying.jsx';
import Timeline from './components/Timeline.jsx';
import Booth from './components/Booth.jsx';
import RequestForm from './components/RequestForm.jsx';
import TransportBar from './components/TransportBar.jsx';
import WindowFrame from './components/WindowFrame.jsx';
import TabBar from './components/TabBar.jsx';
import { useStationFeed } from './hooks/useStationFeed.js';
import { usePlayer } from './hooks/usePlayer.js';
import { c, glyph } from './theme.js';

const PANEL_TITLE = {
  timeline: 'PLAYLIST EDITOR',
  booth:    'BOOTH EQ',
  request:  'ADD TRACK ░ URL/PATH',
  help:     'ABOUT',
};

function About() {
  const rows = [
    ['space',    'tune in / out'],
    ['↑ / ↓',    'volume (mpv only)'],
    ['m',        'mute / unmute'],
    ['1',        'playlist editor'],
    ['2',        'booth eq'],
    ['3 / r',    'request panel'],
    ['?',        'this about screen'],
    ['q',        'quit'],
  ];
  return (
    <Box flexDirection="column">
      <Text color={c.title}>:: SUB/WAVE TERMINAL CLIENT v1.0 ::</Text>
      <Text color={c.lcdDim}>{glyph.shimL} listener side of the radio · keys: {glyph.shimR}</Text>
      <Box marginTop={1} flexDirection="column">
        {rows.map(([k, d]) => (
          <Text key={k}>
            <Text color={c.bitrate}>{k.padEnd(8)}</Text>
            <Text dimColor>{d}</Text>
          </Text>
        ))}
      </Box>
    </Box>
  );
}

// Track the terminal size live so the root Box fills the viewport even
// when the user resizes the window mid-session.
function useTerminalSize() {
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    columns: stdout?.columns || 80,
    rows: stdout?.rows || 24,
  });
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setSize({ columns: stdout.columns, rows: stdout.rows });
    stdout.on('resize', onResize);
    return () => { stdout.off('resize', onResize); };
  }, [stdout]);
  return size;
}

export default function App({ config }) {
  const { exit } = useApp();
  const feed = useStationFeed(config.apiUrl);
  const player = usePlayer(config.streamUrl);
  const [panel, setPanel] = useState('timeline');
  const { columns, rows } = useTerminalSize();

  const offline = feed.streamOnline === false;

  // Tear playback down if the station drops off air while tuned in.
  useEffect(() => {
    if (offline && player.tunedIn) player.stop();
  }, [offline, player.tunedIn, player.stop]);

  // The request form owns the keyboard while its panel is open — only Esc
  // (handled here) gets through, so typing a request never triggers shortcuts.
  const formActive = panel === 'request';

  useInput((input, key) => {
    if (formActive) {
      if (key.escape) setPanel('timeline');
      return;
    }
    if (input === ' ') player.toggle();
    else if (key.upArrow) player.adjustVolume(5);
    else if (key.downArrow) player.adjustVolume(-5);
    else if (input === 'm') player.toggleMute();
    else if (input === '1') setPanel('timeline');
    else if (input === '2') setPanel('booth');
    else if (input === '3' || input === 'r') setPanel('request');
    else if (input === '?') setPanel('help');
    else if (input === 'q') { player.stop(); exit(); }
  });

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <TopBar
        dj={feed.dj}
        activeShow={feed.activeShow}
        listeners={feed.listeners}
        streamOnline={feed.streamOnline}
      />

      <NowPlaying
        nowPlaying={feed.nowPlaying}
        trackStartedAt={feed.trackStartedAt}
        session={feed.session}
        context={feed.context}
        offline={offline}
        tunedIn={player.tunedIn}
      />

      <TabBar active={panel} />

      <WindowFrame title={PANEL_TITLE[panel]} grow>
        {panel === 'timeline' && (
          <Timeline
            upcoming={feed.state.upcoming}
            history={feed.state.history}
            nowPlaying={feed.nowPlaying}
          />
        )}
        {panel === 'booth' && <Booth items={feed.session.messages} />}
        {panel === 'request' && <RequestForm apiUrl={config.apiUrl} />}
        {panel === 'help' && <About />}
      </WindowFrame>

      <TransportBar player={player} offline={offline} />
    </Box>
  );
}

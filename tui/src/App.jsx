import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TopBar from './components/TopBar.jsx';
import NowPlaying from './components/NowPlaying.jsx';
import Timeline from './components/Timeline.jsx';
import Booth from './components/Booth.jsx';
import RequestForm from './components/RequestForm.jsx';
import TransportBar from './components/TransportBar.jsx';
import { useStationFeed } from './hooks/useStationFeed.js';
import { usePlayer } from './hooks/usePlayer.js';

const PANEL_TITLE = {
  timeline: 'TIMELINE',
  booth: 'BOOTH FEED',
  request: 'MAKE A REQUEST',
  help: 'SHORTCUTS',
};

function Help() {
  const rows = [
    ['space', 'tune in / out'],
    ['↑ / ↓', 'volume (mpv only)'],
    ['m', 'mute / unmute'],
    ['1', 'timeline panel'],
    ['2', 'booth feed panel'],
    ['3 / r', 'request panel'],
    ['?', 'this help'],
    ['q', 'quit'],
  ];
  return (
    <Box flexDirection="column">
      {rows.map(([k, d]) => (
        <Text key={k}><Text color="cyan">{k.padEnd(8)}</Text><Text dimColor>{d}</Text></Text>
      ))}
    </Box>
  );
}

export default function App({ config }) {
  const { exit } = useApp();
  const feed = useStationFeed(config.apiUrl);
  const player = usePlayer(config.streamUrl);
  const [panel, setPanel] = useState('timeline');

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
    <Box flexDirection="column">
      <TopBar
        dj={feed.dj}
        activeShow={feed.activeShow}
        listeners={feed.listeners}
        context={feed.context}
        streamOnline={feed.streamOnline}
      />

      <NowPlaying
        nowPlaying={feed.nowPlaying}
        trackStartedAt={feed.trackStartedAt}
        session={feed.session}
        offline={offline}
      />

      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>{PANEL_TITLE[panel]}</Text>
        {panel === 'timeline' && (
          <Timeline upcoming={feed.state.upcoming} history={feed.state.history} />
        )}
        {panel === 'booth' && <Booth items={feed.session.messages} />}
        {panel === 'request' && <RequestForm apiUrl={config.apiUrl} />}
        {panel === 'help' && <Help />}
      </Box>

      <TransportBar player={player} offline={offline} />
    </Box>
  );
}

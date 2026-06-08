// The player composition root — native analog of web PlayerApp. Wires the
// station feed + RNTP player + signal meter + lock-screen metadata + cover-tint
// wash, owns drawer state and the first-paint tune-in gate, and lays everything
// out in a phone column: TopBar / CenterStage (+ Waveform behind) / DotRail /
// TransportBar, with one bottom sheet for the drawers.

import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Sheet } from '@/components/ui/Sheet';
import { useStation } from '@/config/StationContext';
import { useCoverColors } from '@/hooks/useCoverColors';
import { useNowPlayingInfo } from '@/hooks/useNowPlayingInfo';
import { usePlayer } from '@/hooks/usePlayer';
import { useSignal } from '@/hooks/useSignal';
import { useStationFeed } from '@/hooks/useStationFeed';
import { useTheme } from '@/theme/ThemeContext';
import CenterStage from './CenterStage';
import DotRail, { type PlayerDrawer } from './DotRail';
import TopBar from './TopBar';
import TransportBar from './TransportBar';
import TuneInOverlay from './TuneInOverlay';
import Waveform from './Waveform';
import BoothDrawer from './drawers/BoothDrawer';
import RequestDrawer from './drawers/RequestDrawer';
import ScheduleDrawer from './drawers/ScheduleDrawer';
import ThemesDrawer from './drawers/ThemesDrawer';
import TimelineDrawer from './drawers/TimelineDrawer';

type Drawer = PlayerDrawer | 'themes';

const DRAWER_TITLES: Record<Drawer, string> = {
  timeline: 'Timeline',
  booth: 'Booth feed',
  request: 'Make a request',
  schedule: 'Schedule',
  themes: 'Theme',
};

export default function PlayerScreen() {
  const { api } = useStation();
  const { colors } = useTheme();

  const {
    nowPlaying,
    context,
    activeShow,
    dj,
    listeners,
    streamOnline,
    state,
    session,
    elapsed,
    progress,
  } = useStationFeed(api);
  const boothFeed = session.messages;

  const { tunedIn, status, volume, setVolume, tune, stop, toggleMute, muted } = usePlayer(api);

  const offline = streamOnline === false;
  const signal = useSignal({ api, tunedIn, status, offline });

  const listenerCount =
    listeners == null ? null : typeof listeners === 'number' ? listeners : listeners.current ?? null;

  const stationName = typeof dj?.station === 'string' ? dj.station : undefined;
  const djName = typeof dj?.name === 'string' ? dj.name : undefined;

  const coverSrc = useMemo(
    () => (api && nowPlaying?.subsonic_id ? api.cover(nowPlaying.subsonic_id) : null),
    [api, nowPlaying?.subsonic_id],
  );
  const coverColors = useCoverColors(coverSrc);

  // Push lock-screen / CarPlay metadata from the feed.
  useNowPlayingInfo({ api, tunedIn, nowPlaying, boothFeed, activeShow });

  // Tear down playback if the station drops off air mid-listen.
  useEffect(() => {
    if (offline && tunedIn) stop();
  }, [offline, tunedIn, stop]);

  const [drawer, setDrawer] = useState<Drawer | null>(null);
  const [showTuneIn, setShowTuneIn] = useState(true);

  const openDrawer = (d: Drawer | null) => {
    Haptics.selectionAsync().catch(() => {});
    setDrawer(d);
  };

  const tuneInFromOverlay = () => {
    setShowTuneIn(false);
    tune();
  };

  const tint = coverColors.vibrant;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Art-derived ambient wash */}
      {tint ? (
        <LinearGradient
          colors={[tint, 'transparent']}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 0.7 }}
          style={{ position: 'absolute', left: 0, right: 0, top: 0, height: '60%', opacity: 0.16 }}
          pointerEvents="none"
        />
      ) : null}

      <SafeAreaView style={{ flex: 1 }} edges={['left', 'right']}>
        <TopBar
          tunedIn={tunedIn}
          context={context}
          stationName={stationName}
          djName={djName}
          activeShow={activeShow}
          onOpenSchedule={() => openDrawer('schedule')}
          onOpenThemes={() => openDrawer('themes')}
        />

        <View style={{ flex: 1 }}>
          <Waveform tunedIn={tunedIn} progress={progress} />
          <CenterStage
            nowPlaying={nowPlaying}
            coverSrc={coverSrc}
            elapsed={elapsed}
            feed={boothFeed}
            djLineOn
            onOpenBooth={() => openDrawer('booth')}
            onOpenTimeline={() => openDrawer('timeline')}
          />
        </View>

        <View style={{ gap: 12, paddingBottom: 4 }}>
          <DotRail
            upcomingCount={state.upcoming?.length ?? 0}
            active={drawer === 'themes' ? null : (drawer as PlayerDrawer | null)}
            onSelect={(d) => openDrawer(d)}
          />
          <TransportBar
            tunedIn={tunedIn}
            status={status}
            onTune={tune}
            offline={offline}
            volume={volume}
            setVolume={setVolume}
            muted={muted}
            onToggleMute={toggleMute}
            latencyMs={signal.latencyMs}
            signalQuality={signal.quality}
            listeners={listenerCount}
          />
        </View>
      </SafeAreaView>

      <Sheet
        open={drawer != null}
        onClose={() => setDrawer(null)}
        title={drawer ? DRAWER_TITLES[drawer] : ''}
      >
        {drawer === 'timeline' ? (
          <TimelineDrawer upcoming={state.upcoming} history={state.history} />
        ) : null}
        {drawer === 'booth' ? <BoothDrawer items={boothFeed} /> : null}
        {drawer === 'request' && api ? (
          <RequestDrawer api={api} nowPlaying={nowPlaying} context={context} onClose={() => setDrawer(null)} />
        ) : null}
        {drawer === 'schedule' && api ? (
          <ScheduleDrawer api={api} activeShow={activeShow} />
        ) : null}
        {drawer === 'themes' ? <ThemesDrawer /> : null}
      </Sheet>

      {showTuneIn && !offline ? (
        <TuneInOverlay onTune={tuneInFromOverlay} nowPlaying={nowPlaying} />
      ) : null}
    </View>
  );
}

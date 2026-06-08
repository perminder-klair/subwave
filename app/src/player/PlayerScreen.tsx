// The player composition root — native analog of web PlayerApp. Wires the
// station feed + RNTP player + signal meter + lock-screen metadata + cover-tint
// wash, and lays the app out as an FM-dial swipe pager: a persistent TopBar and
// FreqBand tuner above a horizontal pager whose five "stations" are
// Shows / Timeline / LIVE / Booth / Request, with LIVE dead-centre as home.
// Swipe (or tap a band stop) to tune across sections; the needle tracks the
// scroll. Themes open in a bottom sheet from the palette icon, off-band.

import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  ScrollView,
  View,
} from 'react-native';
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
import FreqBand, { type BandStop } from './FreqBand';
import PagePanel from './PagePanel';
import TopBar from './TopBar';
import TransportBar from './TransportBar';
import Waveform from './Waveform';
import BoothDrawer from './drawers/BoothDrawer';
import RequestDrawer from './drawers/RequestDrawer';
import ScheduleDrawer from './drawers/ScheduleDrawer';
import ThemesDrawer from './drawers/ThemesDrawer';
import TimelineDrawer from './drawers/TimelineDrawer';

// FM-dial band: the swipeable pager sections, LIVE in the centre.
const PAGES: readonly BandStop[] = [
  { id: 'schedule', label: 'Shows', abbr: 'SHWS' },
  { id: 'timeline', label: 'Timeline', abbr: 'TML' },
  { id: 'now', label: 'Live', abbr: 'LIVE' },
  { id: 'booth', label: 'Booth', abbr: 'BTH' },
  { id: 'request', label: 'Request', abbr: 'REQ' },
];
const HOME_INDEX = PAGES.findIndex((p) => p.id === 'now');
const indexOf = (id: string) => PAGES.findIndex((p) => p.id === id);

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

  // --- swipe pager -------------------------------------------------------
  const pagerRef = useRef<ScrollView>(null);
  const [pagerW, setPagerW] = useState(0);
  const [active, setActive] = useState(HOME_INDEX);
  const [needle, setNeedle] = useState(HOME_INDEX / (PAGES.length - 1));
  const didInit = useRef(false);

  const onPagerLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (w > 0 && w !== pagerW) setPagerW(w);
  };

  // Land on LIVE without animating the first scroll (belt-and-suspenders for
  // platforms that ignore the ScrollView's initial contentOffset).
  useEffect(() => {
    if (pagerW > 0 && !didInit.current) {
      didInit.current = true;
      requestAnimationFrame(() => pagerRef.current?.scrollTo({ x: HOME_INDEX * pagerW, animated: false }));
    }
  }, [pagerW]);

  const onPagerScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (pagerW <= 0) return;
      const x = e.nativeEvent.contentOffset.x;
      const max = pagerW * (PAGES.length - 1);
      setNeedle(max > 0 ? Math.min(1, Math.max(0, x / max)) : 0);
      setActive(Math.round(x / pagerW));
    },
    [pagerW],
  );

  const goToPage = useCallback(
    (i: number) => {
      if (pagerW <= 0) return;
      Haptics.selectionAsync().catch(() => {});
      pagerRef.current?.scrollTo({ x: i * pagerW, animated: true });
      setActive(i);
    },
    [pagerW],
  );

  const [themesOpen, setThemesOpen] = useState(false);

  const tint = coverColors.vibrant;

  const renderPage = (id: string) => {
    if (id === 'now') {
      return (
        <View style={{ flex: 1 }}>
          <CenterStage
            nowPlaying={nowPlaying}
            coverSrc={coverSrc}
            elapsed={elapsed}
            feed={boothFeed}
            djLineOn
            live={tunedIn}
            onOpenBooth={() => goToPage(indexOf('booth'))}
            onOpenTimeline={() => goToPage(indexOf('timeline'))}
          />
          <Waveform tunedIn={tunedIn} progress={progress} />
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
      );
    }
    if (id === 'schedule') {
      return api ? (
        <PagePanel title="Shows" sub="weekly schedule">
          <ScheduleDrawer api={api} activeShow={activeShow} context={context} />
        </PagePanel>
      ) : null;
    }
    if (id === 'timeline') {
      return (
        <PagePanel title="Timeline" sub="the dial, in order">
          <TimelineDrawer upcoming={state.upcoming} history={state.history} />
        </PagePanel>
      );
    }
    if (id === 'booth') {
      return (
        <PagePanel title="The booth" sub="DJ on the mic">
          <BoothDrawer items={boothFeed} />
        </PagePanel>
      );
    }
    if (id === 'request') {
      return api ? (
        <PagePanel title="Make a request" sub="to the booth">
          <RequestDrawer
            api={api}
            nowPlaying={nowPlaying}
            context={context}
            onClose={() => goToPage(HOME_INDEX)}
          />
        </PagePanel>
      ) : null;
    }
    return null;
  };

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
          onOpenThemes={() => setThemesOpen(true)}
        />

        <FreqBand pages={PAGES} active={active} needle={needle} onPick={goToPage} />

        <View style={{ flex: 1 }} onLayout={onPagerLayout}>
          {pagerW > 0 ? (
            <ScrollView
              ref={pagerRef}
              horizontal
              pagingEnabled
              showsHorizontalScrollIndicator={false}
              scrollEventThrottle={16}
              onScroll={onPagerScroll}
              contentOffset={{ x: HOME_INDEX * pagerW, y: 0 }}
              keyboardShouldPersistTaps="handled"
            >
              {PAGES.map((p) => (
                <View key={p.id} style={{ width: pagerW }}>
                  {renderPage(p.id)}
                </View>
              ))}
            </ScrollView>
          ) : null}
        </View>
      </SafeAreaView>

      <Sheet open={themesOpen} onClose={() => setThemesOpen(false)} title="Theme">
        {themesOpen ? <ThemesDrawer /> : null}
      </Sheet>
    </View>
  );
}

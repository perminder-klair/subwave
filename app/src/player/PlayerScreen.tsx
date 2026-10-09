// The native scroll driver moves the needle without React renders.
// Memoized pages rely on useStationFeed preserving unchanged payload identities.

import { BlurView } from 'expo-blur';
import { router } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  type ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Sheet } from '@/components/ui/Sheet';
import { useStation } from '@/config/StationContext';
import { useCast } from '@/hooks/useCast';
import { useConnectivity } from '@/hooks/useConnectivity';
import { useCoverColors } from '@/hooks/useCoverColors';
import { useLiveActivity } from '@/hooks/useLiveActivity';
import { useNowPlayingInfo } from '@/hooks/useNowPlayingInfo';
import { usePlayer } from '@/hooks/usePlayer';
import { useSignal } from '@/hooks/useSignal';
import { useSleepTimer } from '@/hooks/useSleepTimer';
import { useStationFeed } from '@/hooks/useStationFeed';
import { useStationGate } from '@/hooks/useStationGate';
import { useStreamFormat } from '@/hooks/useStreamFormat';
import { useTrackLike } from '@/hooks/useTrackLike';
import type { StationApi } from '@/lib/api';
import type { StationLocale } from '@/lib/format';
import { formatLabel } from '@/lib/streamFormat';
import type {
  ActiveShow,
  NowPlayingTrack,
  SessionPayload,
  StationContext,
  StationState,
} from '@/lib/types';
import { useTheme } from '@/theme/ThemeContext';
import CenterStage from './CenterStage';
import FreqBand, { type BandStop } from './FreqBand';
import PagePanel from './PagePanel';
import StationGate from './StationGate';
import TopBar from './TopBar';
import TransportBar from './TransportBar';
import Waveform from './Waveform';
import AboutDrawer from './drawers/AboutDrawer';
import BackPanelDrawer from './drawers/BackPanelDrawer';
import BoothDrawer from './drawers/BoothDrawer';
import FormatDrawer from './drawers/FormatDrawer';
import RequestDrawer from './drawers/RequestDrawer';
import ScheduleDrawer from './drawers/ScheduleDrawer';
import SleepDrawer from './drawers/SleepDrawer';
import ThemesDrawer from './drawers/ThemesDrawer';
import TimelineDrawer from './drawers/TimelineDrawer';

// Keep beacon deduplication across remounts and station round-trips.
const beaconedBases = new Set<string>();

const PAGES: readonly BandStop[] = [
  { id: 'schedule', label: 'Shows', abbr: 'SHWS' },
  { id: 'timeline', label: 'Timeline', abbr: 'TML' },
  { id: 'now', label: 'Live', abbr: 'LIVE' },
  { id: 'booth', label: 'Booth', abbr: 'BTH' },
  { id: 'request', label: 'Request', abbr: 'REQ' },
];
const HOME_INDEX = PAGES.findIndex((p) => p.id === 'now');
const BOOTH_INDEX = PAGES.findIndex((p) => p.id === 'booth');
const TIMELINE_INDEX = PAGES.findIndex((p) => p.id === 'timeline');

const SchedulePage = memo(function SchedulePage({
  api,
  activeShow,
  context,
  topInset,
  bottomInset,
}: {
  api: StationApi;
  activeShow: ActiveShow | null;
  context: StationContext | null;
  topInset: number;
  bottomInset: number;
}) {
  return (
    <PagePanel title="Shows" sub="weekly schedule" topInset={topInset} bottomInset={bottomInset}>
      <ScheduleDrawer api={api} activeShow={activeShow} context={context} />
    </PagePanel>
  );
});

const TimelinePage = memo(function TimelinePage({
  upcoming,
  history,
  topInset,
  bottomInset,
}: {
  upcoming: StationState['upcoming'];
  history: StationState['history'];
  topInset: number;
  bottomInset: number;
}) {
  return (
    <PagePanel
      title="Timeline"
      sub="the dial, in order"
      topInset={topInset}
      bottomInset={bottomInset}
    >
      <TimelineDrawer upcoming={upcoming} history={history} />
    </PagePanel>
  );
});

const BoothPage = memo(function BoothPage({
  items,
  timezone,
  locale,
  topInset,
  bottomInset,
}: {
  items: SessionPayload['messages'];
  timezone?: string | null;
  locale?: StationLocale;
  topInset: number;
  bottomInset: number;
}) {
  return (
    <PagePanel title="The booth" sub="DJ on the mic" topInset={topInset} bottomInset={bottomInset}>
      <BoothDrawer items={items} timezone={timezone} locale={locale} />
    </PagePanel>
  );
});

const RequestPage = memo(function RequestPage({
  api,
  nowPlaying,
  context,
  onClose,
  topInset,
  bottomInset,
}: {
  api: StationApi;
  nowPlaying: NowPlayingTrack | null;
  context: StationContext | null;
  onClose: () => void;
  topInset: number;
  bottomInset: number;
}) {
  return (
    <PagePanel
      title="Make a request"
      sub="to the booth"
      topInset={topInset}
      bottomInset={bottomInset}
    >
      <RequestDrawer api={api} nowPlaying={nowPlaying} context={context} onClose={onClose} />
    </PagePanel>
  );
});

export default function PlayerScreen() {
  const {
    api,
    name: savedStationName,
    stationPassword,
    loginPassword,
    rememberStationPassword,
    forgetStationPassword,
  } = useStation();
  const { colors, mode, themes, activeId } = useTheme();

  const { isConnected } = useConnectivity();

  // bgPoll bridges the feed/player cycle: streamInfo validates the player
  // format, while tunedIn enables background feed polling.
  const [bgPoll, setBgPoll] = useState(false);
  const {
    nowPlaying,
    context,
    activeShow,
    dj,
    listeners,
    streamOnline,
    streamInfo,
    llmTokens,
    state,
    session,
    leadMs,
    elapsed,
    progress,
    trackStartedAt,
    timezone,
    locale,
  } = useStationFeed(api, { backgroundPoll: bgPoll });
  const boothFeed = session.messages;

  const streamFormat = useStreamFormat(api?.base ?? null, streamInfo);
  const localPlayer = usePlayer(api, 1, isConnected, streamFormat.format);
  useEffect(() => {
    setBgPoll(localPlayer.tunedIn);
  }, [localPlayer.tunedIn]);

  const stationName = typeof dj?.station === 'string' ? dj.station : undefined;
  const djName = typeof dj?.name === 'string' ? dj.name : undefined;

  const coverSrc = api && nowPlaying?.subsonic_id ? api.cover(nowPlaying.subsonic_id) : null;

  const trackLike = useTrackLike(api, nowPlaying?.subsonic_id ?? null);

  const { player, cast } = useCast(api, localPlayer, {
    stationName,
    djName,
    artworkUrl: coverSrc,
  });
  const { tunedIn, status, volume, setVolume, tune, stop, toggleMute, muted } = player;

  // Private station (#478): the private player hides the whole face until the
  // password is in ('checking' counts as hidden, so a saved password still
  // being verified cannot flash it); stream-only auth prompts over the face.
  const gate = useStationGate({
    api,
    privacy: state.privacy,
    stationPassword,
    loginPassword,
    rememberStationPassword,
    forgetStationPassword,
    tunedIn,
    status,
    stop,
  });
  const hideFace = gate.solid && gate.phase !== 'ok';

  const offline = streamOnline === false;
  const signal = useSignal({ api, tunedIn, status, offline });

  // Disarm on tune-out so the next listening session cannot inherit this timer.
  const sleep = useSleepTimer(stop);
  const cancelSleep = sleep.cancel;
  const prevTunedInRef = useRef(tunedIn);
  useEffect(() => {
    const was = prevTunedInRef.current;
    prevTunedInRef.current = tunedIn;
    if (was && !tunedIn) cancelSleep();
  }, [tunedIn, cancelSleep]);

  useEffect(() => {
    if (!api || beaconedBases.has(api.base)) return;
    beaconedBases.add(api.base);
    void api.postBeacon({ path: '/app', utmSource: `app-${Platform.OS}` });
  }, [api]);

  const listenerCount =
    listeners == null ? null : typeof listeners === 'number' ? listeners : listeners.current ?? null;

  const coverColors = useCoverColors(coverSrc);

  // Cast has no local RNTP media session; update OS metadata only for local playback.
  useNowPlayingInfo({ api, tunedIn: localPlayer.tunedIn, nowPlaying, boothFeed, leadMs, activeShow });

  useLiveActivity({
    api,
    tunedIn: localPlayer.tunedIn,
    nowPlaying,
    activeShow,
    boothFeed,
    leadMs,
    trackStartedAt,
    station: stationName || 'SUB/WAVE',
    accent: colors.accent,
    like: trackLike,
  });

  // Offline is debounced upstream so a transient failure cannot stop playback.
  useEffect(() => {
    if (offline && tunedIn) stop();
  }, [offline, tunedIn, stop]);

  const pagerRef = useRef<ScrollView>(null);
  const [pagerW, setPagerW] = useState(0);
  const [active, setActive] = useState(HOME_INDEX);
  const activeRef = useRef(HOME_INDEX);
  const [scrollX] = useState(() => new Animated.Value(0));
  const didInit = useRef(false);

  const onPagerLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (w > 0 && w !== pagerW) setPagerW(w);
  };

  // Some platforms ignore initial contentOffset; position the pager after layout.
  useEffect(() => {
    if (pagerW > 0 && !didInit.current) {
      didInit.current = true;
      scrollX.setValue(HOME_INDEX * pagerW);
      requestAnimationFrame(() => pagerRef.current?.scrollTo({ x: HOME_INDEX * pagerW, animated: false }));
    }
  }, [pagerW, scrollX]);

  const onPagerScroll = useMemo(
    () =>
      // Animated.event stores the listener; it reads refs only on scroll.
      // eslint-disable-next-line react-hooks/refs
      Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], {
        useNativeDriver: true,
        listener: (e: NativeSyntheticEvent<NativeScrollEvent>) => {
          if (pagerW <= 0) return;
          const idx = Math.max(
            0,
            Math.min(PAGES.length - 1, Math.round(e.nativeEvent.contentOffset.x / pagerW)),
          );
          if (idx !== activeRef.current) {
            activeRef.current = idx;
            setActive(idx);
          }
        },
      }),
    [scrollX, pagerW],
  );

  const goToPage = useCallback(
    (i: number) => {
      if (pagerW <= 0) return;
      Haptics.selectionAsync().catch(() => {});
      pagerRef.current?.scrollTo({ x: i * pagerW, animated: true });
      activeRef.current = i;
      setActive(i);
    },
    [pagerW],
  );

  const openBooth = useCallback(() => goToPage(BOOTH_INDEX), [goToPage]);
  const openTimeline = useCallback(() => goToPage(TIMELINE_INDEX), [goToPage]);
  const goHome = useCallback(() => goToPage(HOME_INDEX), [goToPage]);

  // Share one sheet to avoid competing dismissal callbacks.
  const [activeSheet, setActiveSheet] = useState<'panel' | 'sleep' | 'themes' | 'format' | 'about' | null>(
    null,
  );
  const themeName = useMemo(
    () => themes.find((t) => t.id === activeId)?.name ?? null,
    [themes, activeId],
  );
  const streamFormatLabel =
    streamFormat.options.length > 1 ? formatLabel(streamFormat.format) : null;

  // Pad pages by measured overlay heights so content can scroll clear of both.
  const [barInset, setBarInset] = useState(120);
  const onBarLayout = useCallback((e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    if (h > 0) setBarInset((prev) => (Math.abs(prev - h) > 0.5 ? h : prev));
  }, []);

  const [headerInset, setHeaderInset] = useState(150);
  const onHeaderLayout = useCallback((e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    if (h > 0) setHeaderInset((prev) => (Math.abs(prev - h) > 0.5 ? h : prev));
  }, []);

  // A sheet is a Modal, so it would sit above the prompt and stay usable.
  useEffect(() => {
    if (gate.phase === 'prompt') setActiveSheet(null);
  }, [gate.phase]);

  // The pager unmounts behind a solid gate; bring it back on the home page.
  useEffect(() => {
    if (!hideFace) return;
    activeRef.current = HOME_INDEX;
    setActive(HOME_INDEX);
    if (pagerW > 0) scrollX.setValue(HOME_INDEX * pagerW);
  }, [hideFace, pagerW, scrollX]);

  const glassFilm = mode === 'light' ? 'rgba(255,255,255,0.22)' : `${colors.ink}12`;

  const tint = coverColors.vibrant;
  const gateStationName = stationName || savedStationName;

  if (hideFace) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <StationGate
          checking={gate.phase !== 'prompt'}
          solid
          stationName={gateStationName}
          unlock={gate.unlock}
        />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
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
        <View style={{ flex: 1 }} onLayout={onPagerLayout}>
          {pagerW > 0 ? (
            <Animated.ScrollView
              ref={pagerRef}
              horizontal
              pagingEnabled
              showsHorizontalScrollIndicator={false}
              scrollEventThrottle={16}
              onScroll={onPagerScroll}
              contentOffset={{ x: HOME_INDEX * pagerW, y: 0 }}
              keyboardShouldPersistTaps="handled"
            >
              <View style={{ width: pagerW }}>
                {api ? (
                  <SchedulePage
                    api={api}
                    activeShow={activeShow}
                    context={context}
                    topInset={headerInset}
                    bottomInset={barInset}
                  />
                ) : null}
              </View>
              <View style={{ width: pagerW }}>
                <TimelinePage
                  upcoming={state.upcoming}
                  history={state.history}
                  topInset={headerInset}
                  bottomInset={barInset}
                />
              </View>
              <View style={{ width: pagerW }}>
                <View style={{ flex: 1, paddingTop: headerInset, paddingBottom: barInset }}>
                  <CenterStage
                    nowPlaying={nowPlaying}
                    coverSrc={coverSrc}
                    elapsed={elapsed}
                    llmTokens={llmTokens}
                    trackLike={trackLike}
                    feed={boothFeed}
                    djLineOn
                    live={tunedIn}
                    onOpenBooth={openBooth}
                    onOpenTimeline={openTimeline}
                  />
                  <Waveform tunedIn={tunedIn} progress={progress} visible={active === HOME_INDEX} />
                </View>
              </View>
              <View style={{ width: pagerW }}>
                <BoothPage items={boothFeed} timezone={timezone} locale={locale} topInset={headerInset} bottomInset={barInset} />
              </View>
              <View style={{ width: pagerW }}>
                {api ? (
                  <RequestPage
                    api={api}
                    nowPlaying={nowPlaying}
                    context={context}
                    onClose={goHome}
                    topInset={headerInset}
                    bottomInset={barInset}
                  />
                ) : null}
              </View>
            </Animated.ScrollView>
          ) : null}
        </View>

        <View style={{ position: 'absolute', top: 0, left: 0, right: 0 }} onLayout={onHeaderLayout}>
          <BlurView
            intensity={mode === 'light' ? 40 : 26}
            tint={mode === 'light' ? 'light' : 'dark'}
            blurMethod="dimezisBlurView"
            style={StyleSheet.absoluteFill}
          />
          <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: glassFilm }]} />
          <TopBar
            tunedIn={tunedIn}
            context={context}
            stationName={stationName}
            djName={djName}
            activeShow={activeShow}
            onOpenPanel={() => setActiveSheet('panel')}
            panelActive={sleep.active || cast.connected}
          />
          <FreqBand
            pages={PAGES}
            active={active}
            scrollX={scrollX}
            maxScroll={pagerW * (PAGES.length - 1)}
            onPick={goToPage}
          />
        </View>

        <View
          style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}
          onLayout={onBarLayout}
        >
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
            castingTo={cast.deviceName}
          />
        </View>
      </SafeAreaView>

      {gate.phase === 'prompt' ? (
        <StationGate checking={false} solid={false} stationName={gateStationName} unlock={gate.unlock} />
      ) : null}

      <Sheet
        open={activeSheet !== null}
        onClose={() => setActiveSheet(null)}
        title={
          activeSheet === 'panel'
            ? 'Back panel'
            : activeSheet === 'sleep'
              ? 'Sleep timer'
              : activeSheet === 'format'
                ? 'Stream format'
                : activeSheet === 'about'
                  ? 'About SUB/WAVE'
                  : 'Theme'
        }
      >
        {activeSheet === 'panel' ? (
          <BackPanelDrawer
            castAvailable={cast.available}
            castingTo={cast.deviceName}
            sleepActive={sleep.active}
            sleepRemainingSec={sleep.remainingSec}
            themeName={themeName}
            formatLabel={streamFormatLabel}
            onOpenSleep={() => setActiveSheet('sleep')}
            onOpenThemes={() => setActiveSheet('themes')}
            onOpenFormat={() => setActiveSheet('format')}
            onOpenAbout={() => setActiveSheet('about')}
          />
        ) : null}
        {activeSheet === 'sleep' ? (
          <SleepDrawer
            active={sleep.active}
            armedMinutes={sleep.armedMinutes}
            remainingSec={sleep.remainingSec}
            onStart={sleep.start}
            onCancel={sleep.cancel}
          />
        ) : null}
        {activeSheet === 'format' ? (
          <FormatDrawer
            options={streamFormat.options}
            selected={streamFormat.format}
            onSelect={streamFormat.setFormat}
          />
        ) : null}
        {activeSheet === 'themes' ? <ThemesDrawer /> : null}
        {activeSheet === 'about' ? (
          <AboutDrawer
            onAddStation={() => {
              setActiveSheet(null);
              router.push('/onboarding');
            }}
          />
        ) : null}
      </Sheet>
    </View>
  );
}

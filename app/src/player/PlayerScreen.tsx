// The player composition root — native analog of web PlayerApp. Wires the
// station feed + RNTP player + signal meter + lock-screen metadata + cover-tint
// wash, and lays the app out as an FM-dial swipe pager: a persistent TopBar and
// FreqBand tuner above a horizontal pager whose five "stations" are
// Shows / Timeline / LIVE / Booth / Request, with LIVE dead-centre as home.
// Swipe (or tap a band stop) to tune across sections; the needle tracks the
// scroll. The TransportBar is docked below the pager so the player stays
// visible on every band stop, bottom-nav style. Themes open in a bottom sheet
// from the palette icon, off-band.
//
// Render-path notes: the pager's scroll drives the FreqBand needle through a
// native-driver Animated.Value (no per-frame React state), and the four
// non-LIVE pages are memo'd so the 1s elapsed tick and 5s feed poll only
// re-render the pages whose data actually changed (useStationFeed keeps
// unchanged payloads reference-stable for exactly this reason).

import { BlurView } from 'expo-blur';
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
import { useConnectivity } from '@/hooks/useConnectivity';
import { useCoverColors } from '@/hooks/useCoverColors';
import { useNowPlayingInfo } from '@/hooks/useNowPlayingInfo';
import { usePlayer } from '@/hooks/usePlayer';
import { useSignal } from '@/hooks/useSignal';
import { useSleepTimer } from '@/hooks/useSleepTimer';
import { useStationFeed } from '@/hooks/useStationFeed';
import type { StationApi } from '@/lib/api';
import type { StationLocale } from '@/lib/format';
import type {
  ActiveShow,
  NowPlayingTrack,
  SessionPayload,
  StationContext,
  StationState,
} from '@/lib/types';
import { useTheme } from '@/theme/ThemeContext';
import CenterStage from './CenterStage';
import ConnectionBanner from './ConnectionBanner';
import FreqBand, { type BandStop } from './FreqBand';
import PagePanel from './PagePanel';
import TopBar from './TopBar';
import TransportBar from './TransportBar';
import Waveform from './Waveform';
import BoothDrawer from './drawers/BoothDrawer';
import RequestDrawer from './drawers/RequestDrawer';
import ScheduleDrawer from './drawers/ScheduleDrawer';
import SleepDrawer from './drawers/SleepDrawer';
import ThemesDrawer from './drawers/ThemesDrawer';
import TimelineDrawer from './drawers/TimelineDrawer';

// Stations this app run has already beaconed — remounts/station round-trips
// must not double count (the controller additionally dedupes by IP).
const beaconedBases = new Set<string>();

// FM-dial band: the swipeable pager sections, LIVE in the centre.
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

// Memo'd page bodies — props are reference-stable between polls (see
// useStationFeed), so off-screen pages skip render on feed ticks entirely.

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
  const { api } = useStation();
  const { colors, mode } = useTheme();

  const { isConnected } = useConnectivity();
  const { tunedIn, status, volume, setVolume, tune, stop, toggleMute, muted } = usePlayer(
    api,
    1,
    isConnected,
  );

  const {
    nowPlaying,
    context,
    activeShow,
    dj,
    listeners,
    streamOnline,
    llmTokens,
    state,
    session,
    elapsed,
    progress,
    timezone,
    locale,
    // While tuned in, keep a slow background poll alive so the lock screen
    // (useNowPlayingInfo) tracks the broadcast; idle + backgrounded polls
    // nothing at all.
  } = useStationFeed(api, { backgroundPoll: tunedIn });
  const boothFeed = session.messages;

  const offline = streamOnline === false;
  const signal = useSignal({ api, tunedIn, status, offline });

  // Sleep timer: tune out when it lapses. An explicit tune-out (or a station
  // switch tearing playback down) also disarms it — a timer armed for one
  // listen must not ambush the next one.
  const sleep = useSleepTimer(stop);
  const cancelSleep = sleep.cancel;
  const prevTunedInRef = useRef(tunedIn);
  useEffect(() => {
    const was = prevTunedInRef.current;
    prevTunedInRef.current = tunedIn;
    if (was && !tunedIn) cancelSleep();
  }, [tunedIn, cancelSleep]);

  // One-shot audience beacon per station per app run — the native analog of
  // the web PlayerApp's referrer beacon. An app has no document.referrer or
  // UTM query, so report the platform as the source; that's how native
  // listeners become visible in the admin Stats audience rollup at all.
  useEffect(() => {
    if (!api || beaconedBases.has(api.base)) return;
    beaconedBases.add(api.base);
    void api.postBeacon({ path: '/app', utmSource: `app-${Platform.OS}` });
  }, [api]);

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

  // Tear down playback if the station drops off air mid-listen. `offline` is
  // debounced upstream (useStationFeed needs OFFLINE_CONFIRM_POLLS consecutive
  // offline polls) so a transient controller blip can't kill live audio
  // (#463/#466).
  useEffect(() => {
    if (offline && tunedIn) stop();
  }, [offline, tunedIn, stop]);

  // --- swipe pager -------------------------------------------------------
  // Animated.ScrollView forwards its ref to the inner ScrollView (RN ≥0.62),
  // so scrollTo is available directly.
  const pagerRef = useRef<ScrollView>(null);
  const [pagerW, setPagerW] = useState(0);
  const [active, setActive] = useState(HOME_INDEX);
  const activeRef = useRef(HOME_INDEX);
  const scrollX = useRef(new Animated.Value(0)).current;
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
      scrollX.setValue(HOME_INDEX * pagerW);
      requestAnimationFrame(() => pagerRef.current?.scrollTo({ x: HOME_INDEX * pagerW, animated: false }));
    }
  }, [pagerW, scrollX]);

  // The needle rides scrollX on the native driver; React state only changes
  // when the snapped-to page does (one update per page change, not per frame).
  const onPagerScroll = useMemo(
    () =>
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

  const [themesOpen, setThemesOpen] = useState(false);
  const [sleepOpen, setSleepOpen] = useState(false);

  // Footprints of the two frosted overlays (masthead/dial header at the top,
  // transport bar at the bottom). The pager fills the full height behind both,
  // and each page pads its scroll top/bottom by these so content reads as
  // flowing under the frosted glass yet still scrolls fully clear.
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

  // Frosted-glass film shared by both overlays — soft white in light themes, a
  // faint ink wash in dark — matching the transport bar's glass treatment.
  const glassFilm = mode === 'light' ? 'rgba(255,255,255,0.22)' : `${colors.ink}12`;

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
        {/* The pager fills the full height; the masthead/dial header and the
            transport bar float over it as frosted overlays (below), so content
            scrolls under the glass at both ends. */}
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

        {/* Frosted masthead + FM dial — floated as an absolute overlay at the
            head of every band stop so page content scrolls under the glass,
            mirroring the transport bar. The BlurView picks up the cover-art
            ambient wash + scrolling content behind it; a thin mode-aware film
            keeps the wordmark and dial legible. */}
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
            onOpenThemes={() => setThemesOpen(true)}
            onOpenSleep={() => setSleepOpen(true)}
            sleepActive={sleep.active}
          />
          <ConnectionBanner
            isConnected={isConnected}
            streamOnline={streamOnline}
            tunedIn={tunedIn}
            status={status}
          />
          <FreqBand
            pages={PAGES}
            active={active}
            scrollX={scrollX}
            maxScroll={pagerW * (PAGES.length - 1)}
            onPick={goToPage}
          />
        </View>

        {/* Persistent transport — floated as an absolute overlay at the foot of
            every band stop (bottom-nav style) so the pager fills the full height
            behind it and content scrolls under the frosted glass. */}
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
          />
        </View>
      </SafeAreaView>

      <Sheet open={themesOpen} onClose={() => setThemesOpen(false)} title="Theme">
        {themesOpen ? <ThemesDrawer /> : null}
      </Sheet>

      <Sheet open={sleepOpen} onClose={() => setSleepOpen(false)} title="Sleep timer">
        {sleepOpen ? (
          <SleepDrawer
            active={sleep.active}
            armedMinutes={sleep.armedMinutes}
            remainingSec={sleep.remainingSec}
            onStart={sleep.start}
            onCancel={sleep.cancel}
          />
        ) : null}
      </Sheet>
    </View>
  );
}

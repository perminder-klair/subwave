// What the lyrics button beside the heart opens, the app's
// web/components/skins/LyricsSettings.tsx: this device's switch for lyrics, a
// line on what the track has, and, while synced lyrics show, this device's
// timing nudge (web/components/skins/LyricsTiming.tsx's device half: a slider
// across the whole range, with buttons for the fine steps). The station's
// per-track fix is the operator's, from the web admin console, so it is
// applied here but never offered.

import * as Haptics from 'expo-haptics';
import { Minus, Plus, RotateCcw } from 'lucide-react-native';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { PanResponder, Pressable, Text, View, type GestureResponderEvent } from 'react-native';
import type { TrackLyrics } from '@/hooks/useTrackLyrics';
import {
  LYRIC_OFFSET_MAX_MS,
  LYRIC_OFFSET_MIN_MS,
  LYRIC_OFFSET_NUDGE_MS,
  LYRIC_OFFSET_STEP_MS,
  formatLyricOffset,
  lyricsNote,
  syncedLyricsReady,
} from '@/lib/lyrics';
import { useTheme } from '@/theme/ThemeContext';

export interface LyricsDrawerProps {
  /** This device's choice to show lyrics. */
  shown: boolean;
  onToggle: () => void;
  track: TrackLyrics;
  /** The screen is tall enough for the Live page to show lyrics. */
  fits: boolean;
}

const SLIDER_HEIGHT = 40;
const THUMB = 16;
const TICK = 10;

function tap() {
  Haptics.selectionAsync().catch(() => {});
}

function IconButton({
  label,
  onPress,
  children,
}: {
  label: string;
  onPress: () => void;
  children: ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={() => {
        tap();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={{
        width: 40,
        height: 40,
        borderWidth: 1,
        borderColor: colors.softBorder,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {children}
    </Pressable>
  );
}

/** The device offset across LYRIC_OFFSET_MIN_MS..MAX_MS in LYRIC_OFFSET_STEP_MS
 *  steps: drag the thumb or tap along the track. Each step lands at once, so
 *  the lyrics behind the sheet move as it is dragged. VoiceOver adjusts it a
 *  nudge at a time. */
function OffsetSlider({ value, onChange }: { value: number; onChange: (next: number) => void }) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const span = LYRIC_OFFSET_MAX_MS - LYRIC_OFFSET_MIN_MS;
  const widthRef = useRef(width);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  useLayoutEffect(() => {
    widthRef.current = width;
    valueRef.current = value;
    onChangeRef.current = onChange;
  }, [width, value, onChange]);
  const startXRef = useRef(0);

  // PanResponder stores these callbacks; refs are read only during gestures.
  // eslint-disable-next-line react-hooks/refs
  const [pan] = useState(() => {
    const seek = (x: number) => {
      const w = widthRef.current;
      if (w <= 0) return;
      const ratio = Math.min(1, Math.max(0, x / w));
      const next = Math.round((LYRIC_OFFSET_MIN_MS + ratio * span) / LYRIC_OFFSET_STEP_MS) * LYRIC_OFFSET_STEP_MS;
      if (next !== valueRef.current) {
        valueRef.current = next;
        onChangeRef.current(next);
      }
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // The sheet scrolls vertically; a drag that wanders must stay a drag.
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e: GestureResponderEvent) => {
        startXRef.current = e.nativeEvent.locationX;
        seek(startXRef.current);
      },
      onPanResponderMove: (_, g) => seek(startXRef.current + g.dx),
    });
  });

  const ratio = (value - LYRIC_OFFSET_MIN_MS) / span;
  const centre = width / 2;
  const at = ratio * width;
  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel="Lyrics timing on this device"
      accessibilityValue={{ min: LYRIC_OFFSET_MIN_MS, max: LYRIC_OFFSET_MAX_MS, now: value, text: formatLyricOffset(value) }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => {
        const by = e.nativeEvent.actionName === 'increment' ? LYRIC_OFFSET_NUDGE_MS : -LYRIC_OFFSET_NUDGE_MS;
        onChange(value + by);
      }}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={{ flex: 1, height: SLIDER_HEIGHT, justifyContent: 'center' }}
      {...pan.panHandlers}
    >
      <View pointerEvents="none" style={{ height: 2, backgroundColor: colors.softBorder }} />
      {width > 0 ? (
        <>
          {/* No correction sits at the centre of the range. */}
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: (SLIDER_HEIGHT - TICK) / 2,
              left: centre - 0.5,
              width: 1,
              height: TICK,
              backgroundColor: colors.muted,
            }}
          />
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: SLIDER_HEIGHT / 2 - 1,
              left: Math.min(centre, at),
              width: Math.abs(at - centre),
              height: 2,
              backgroundColor: colors.accent,
            }}
          />
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: (SLIDER_HEIGHT - THUMB) / 2,
              left: at - THUMB / 2,
              width: THUMB,
              height: THUMB,
              borderRadius: THUMB / 2,
              backgroundColor: colors.accent,
            }}
          />
        </>
      ) : null}
    </View>
  );
}

export default function LyricsDrawer({ shown, onToggle, track, fits }: LyricsDrawerProps) {
  const { colors } = useTheme();
  const synced = shown && fits && syncedLyricsReady(track);
  const { deviceOffsetMs, setDeviceOffsetMs } = track;

  return (
    <View>
      <Pressable
        onPress={() => {
          tap();
          onToggle();
        }}
        accessibilityRole="switch"
        accessibilityLabel="Show lyrics"
        accessibilityState={{ checked: shown }}
        className="flex-row items-center justify-between"
        style={{ paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.softBorder }}
      >
        <View style={{ flex: 1, paddingRight: 16 }}>
          <Text className="font-body-medium text-ink" style={{ fontSize: 15 }}>
            Show lyrics
          </Text>
          <Text
            className="font-body text-muted"
            style={{ fontSize: 12, marginTop: 4, lineHeight: 17 }}
            accessibilityLiveRegion="polite"
          >
            {lyricsNote(track, shown)}
            {shown && !fits ? ' This screen is too short to show them on the Live page.' : ''}
          </Text>
        </View>
        <View
          style={{
            width: 40,
            height: 22,
            borderRadius: 11,
            borderWidth: 1,
            borderColor: shown ? colors.accent : colors.softBorder,
            backgroundColor: shown ? colors.accent : 'transparent',
            justifyContent: 'center',
            paddingHorizontal: 2,
          }}
        >
          <View
            style={{
              width: 16,
              height: 16,
              borderRadius: 8,
              backgroundColor: shown ? colors.bg : colors.muted,
              alignSelf: shown ? 'flex-end' : 'flex-start',
            }}
          />
        </View>
      </Pressable>

      {synced ? (
        <View style={{ marginTop: 18 }}>
          <View className="flex-row items-center justify-between" style={{ marginBottom: 8 }}>
            <Text className="font-mono" style={{ fontSize: 9, letterSpacing: 3, color: colors.muted }}>
              TIMING · THIS DEVICE
            </Text>
            <Text className="font-mono text-ink" style={{ fontSize: 12, letterSpacing: 1 }}>
              {formatLyricOffset(deviceOffsetMs)}
            </Text>
          </View>
          <View className="flex-row items-center" style={{ gap: 10 }}>
            <IconButton
              label="Delay lyrics on this device"
              onPress={() => setDeviceOffsetMs(deviceOffsetMs - LYRIC_OFFSET_NUDGE_MS)}
            >
              <Minus size={16} color={colors.ink} strokeWidth={1.8} />
            </IconButton>
            <OffsetSlider value={deviceOffsetMs} onChange={setDeviceOffsetMs} />
            <IconButton
              label="Advance lyrics on this device"
              onPress={() => setDeviceOffsetMs(deviceOffsetMs + LYRIC_OFFSET_NUDGE_MS)}
            >
              <Plus size={16} color={colors.ink} strokeWidth={1.8} />
            </IconButton>
            <IconButton label="Reset lyrics timing on this device" onPress={() => setDeviceOffsetMs(0)}>
              <RotateCcw size={16} color={colors.muted} strokeWidth={1.8} />
            </IconButton>
          </View>
          <Text className="font-body text-muted" style={{ fontSize: 12, marginTop: 10, lineHeight: 17 }}>
            For a speaker or car stereo that runs late. Advance if the words come after the
            singing, delay if they come before. Kept on this device, for every song.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

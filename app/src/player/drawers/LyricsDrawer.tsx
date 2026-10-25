// What the lyrics button beside the heart opens, the app's
// web/components/skins/LyricsSettings.tsx: this device's switch for lyrics, a
// line on what the track has, and, while synced lyrics show, this device's
// timing nudge. The station's per-track fix is the operator's, from the web
// admin console, so it is applied here but never offered.

import * as Haptics from 'expo-haptics';
import { Minus, Plus, RotateCcw } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { TrackLyrics } from '@/hooks/useTrackLyrics';
import { LYRIC_OFFSET_NUDGE_MS, formatLyricOffset, lyricsNote, syncedLyricsReady } from '@/lib/lyrics';
import { useTheme } from '@/theme/ThemeContext';

export interface LyricsDrawerProps {
  /** This device's choice to show lyrics. */
  shown: boolean;
  onToggle: () => void;
  track: TrackLyrics;
}

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

export default function LyricsDrawer({ shown, onToggle, track }: LyricsDrawerProps) {
  const { colors } = useTheme();
  const synced = shown && syncedLyricsReady(track);
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

// Full-bleed first-paint gate. The player shows live track info but isn't
// playing until the listener taps — and the tap is also the gesture that lets
// audio start. Ported from web TuneInOverlay.

import { Play } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';
import type { NowPlayingTrack } from '@/lib/types';
import { useTheme } from '@/theme/ThemeContext';

export interface TuneInOverlayProps {
  onTune: () => void;
  nowPlaying: NowPlayingTrack | null;
}

export default function TuneInOverlay({ onTune, nowPlaying }: TuneInOverlayProps) {
  const { colors } = useTheme();
  const track = nowPlaying?.title
    ? `${nowPlaying.title}${nowPlaying.artist ? ` — ${nowPlaying.artist}` : ''}`
    : null;

  return (
    <Pressable
      onPress={onTune}
      accessibilityRole="button"
      accessibilityLabel="Tune in to the live stream"
      style={{ backgroundColor: `${colors.bg}f2` }}
      className="absolute inset-0 z-50 items-center justify-center px-6"
    >
      <View className="flex-row items-center mb-7" style={{ gap: 8 }}>
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent }} />
        <Text className="font-mono text-accent" style={{ fontSize: 11, letterSpacing: 3 }}>
          ON AIR NOW
        </Text>
      </View>

      <View
        className="items-center justify-center rounded-full"
        style={{ width: 92, height: 92, backgroundColor: colors.ink }}
      >
        <Play size={34} color={colors.bg} fill={colors.bg} style={{ marginLeft: 4 }} />
      </View>

      <Text className="font-display text-ink mt-7" style={{ fontSize: 28 }}>
        Tap to tune in
      </Text>
      <Text className="font-body text-muted mt-2 text-center" style={{ fontSize: 13 }}>
        audio is paused — tap anywhere to start listening
      </Text>
      {track ? (
        <Text className="font-body text-muted mt-3 text-center" style={{ fontSize: 13 }}>
          now playing · <Text style={{ color: colors.ink }}>{track}</Text>
        </Text>
      ) : null}
    </Pressable>
  );
}

// The control deck: Power (tune in/out), the analog signal meter + listener
// count, and Volume + mute. Ported from web TransportBar for phone width. On
// native, RNTP volume works on both platforms, so the iOS hardware-only hint is
// dropped — the slider attenuates everywhere.

import Slider from '@react-native-community/slider';
import * as Haptics from 'expo-haptics';
import { Power, Volume2, VolumeX } from 'lucide-react-native';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SCALE_MAX, type SignalQuality } from '@/hooks/useSignal';
import type { PlayerStatus } from '@/hooks/usePlayer';
import { useTheme } from '@/theme/ThemeContext';

export interface TransportBarProps {
  tunedIn: boolean;
  status: PlayerStatus;
  onTune: () => void;
  offline: boolean;
  volume: number;
  setVolume: (v: number) => void;
  muted: boolean;
  onToggleMute: () => void;
  latencyMs: number | null;
  signalQuality: SignalQuality;
  listeners: number | null;
}

const QUALITY_LABEL: Record<SignalQuality, string> = {
  offline: 'Offline',
  idle: 'Standby',
  acquiring: 'Acquiring',
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
};

export default function TransportBar({
  tunedIn,
  status,
  onTune,
  offline,
  volume,
  setVolume,
  muted,
  onToggleMute,
  latencyMs,
  signalQuality,
  listeners,
}: TransportBarProps) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const connecting = status === 'connecting';

  const needlePct =
    latencyMs != null
      ? Math.min(100, (Math.min(latencyMs, SCALE_MAX) / SCALE_MAX) * 100)
      : signalQuality === 'poor'
        ? 100
        : 0;
  const qualityLabel = QUALITY_LABEL[signalQuality];
  const latencyText = latencyMs != null ? `${latencyMs} ms` : '—';
  const qualityActive = signalQuality !== 'idle' && signalQuality !== 'offline';

  const handleTune = () => {
    if (offline) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    onTune();
  };

  const handleMute = () => {
    Haptics.selectionAsync().catch(() => {});
    onToggleMute();
  };

  return (
    <View
      style={{
        paddingBottom: insets.bottom + 12,
        paddingTop: 14,
        borderTopWidth: 1,
        borderTopColor: colors.softBorder,
        backgroundColor: colors.bg,
      }}
      className="flex-row items-center px-5"
    >
      {/* Power */}
      <Pressable
        onPress={handleTune}
        disabled={offline}
        className="items-center justify-center rounded-full"
        style={{
          width: 52,
          height: 52,
          borderWidth: 2,
          borderColor: offline ? colors.muted : tunedIn ? colors.accent : colors.ink,
          opacity: offline ? 0.4 : 1,
        }}
      >
        {connecting ? (
          <ActivityIndicator size="small" color={colors.accent} />
        ) : (
          <Power size={22} color={tunedIn ? colors.accent : colors.ink} strokeWidth={2} />
        )}
      </Pressable>

      {/* Signal meter */}
      <View className="flex-1 px-4">
        <View className="flex-row items-baseline justify-between" style={{ marginBottom: 6 }}>
          <Text className="font-mono text-ink" style={{ fontSize: 11 }}>
            Signal ·{' '}
            <Text style={{ color: qualityActive ? colors.accent : colors.muted, fontWeight: '700' }}>
              {qualityLabel}
            </Text>
          </Text>
          <Text className="font-mono text-muted" style={{ fontSize: 11 }}>
            {listeners != null ? `${listeners} ♪ · ${latencyText}` : latencyText}
          </Text>
        </View>
        <View style={{ height: 4, borderRadius: 2, backgroundColor: colors.field, overflow: 'hidden' }}>
          <View
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: `${needlePct}%`,
              backgroundColor: qualityActive ? colors.accent : colors.muted,
            }}
          />
        </View>
      </View>

      {/* Volume */}
      <View className="items-center" style={{ width: 110 }}>
        <Slider
          style={{ width: 90, height: 28 }}
          minimumValue={0}
          maximumValue={1}
          step={0.01}
          value={volume}
          onValueChange={setVolume}
          minimumTrackTintColor={colors.accent}
          maximumTrackTintColor={colors.softBorder}
          thumbTintColor={colors.ink}
        />
        <Pressable onPress={handleMute} hitSlop={8} className="mt-1">
          {muted ? (
            <VolumeX size={16} color={colors.muted} />
          ) : (
            <Volume2 size={16} color={colors.muted} />
          )}
        </Pressable>
      </View>
    </View>
  );
}

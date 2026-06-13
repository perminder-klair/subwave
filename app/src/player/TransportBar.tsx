// The control deck, rebuilt to match the web player's console: a bordered
// three-cell box — Power (hollow ring that lights accent on air), the analog
// Signal meter (label + listener/latency read, a 26-tick scale with a vermilion
// grip, and a 0–250 latency ruler), and Volume (rotary knob + dot-grille mute).
// Docked below the FM-dial pager, so it stays at the foot of every band stop.

import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import RotaryKnob from './RotaryKnob';
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

const RULER = [0, 50, 100, 150, 200, 250];
const TICKS = 26;

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
  const { colors, mode } = useTheme();
  const connecting = status === 'connecting';

  const gripPct =
    latencyMs != null
      ? Math.min(100, (Math.min(latencyMs, SCALE_MAX) / SCALE_MAX) * 100)
      : signalQuality === 'poor'
        ? 100
        : 2;
  const qualityLabel = QUALITY_LABEL[signalQuality];
  const latencyText = latencyMs != null ? `${latencyMs} ms` : '—';
  const qualityActive = signalQuality !== 'idle' && signalQuality !== 'offline';
  const readout = tunedIn
    ? listeners != null
      ? `${listeners} ♪ · ${latencyText}`
      : latencyText
    : '—';

  const handleTune = () => {
    if (offline) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    onTune();
  };
  const handleMute = () => {
    Haptics.selectionAsync().catch(() => {});
    onToggleMute();
  };

  const powerColor = offline ? colors.muted : tunedIn ? colors.accent : colors.ink;

  return (
    <View style={{ marginHorizontal: 16, marginBottom: insets.bottom + 12 }}>
      {/* Frosted-glass console: a real backdrop blur picks up the cover-art
          ambient wash behind the bar, with a thin translucent film over it and
          a softened glass edge — so the deck reads as transparent glass rather
          than a flat panel. The controls render on top, unblurred. */}
      <View style={{ borderWidth: 1, borderColor: `${colors.ink}59`, overflow: 'hidden' }}>
        <BlurView
          intensity={mode === 'light' ? 40 : 26}
          tint={mode === 'light' ? 'light' : 'dark'}
          blurMethod="dimezisBlurView"
          style={StyleSheet.absoluteFill}
        />
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: mode === 'light' ? 'rgba(255,255,255,0.22)' : `${colors.ink}12` },
          ]}
        />
        <View className="flex-row">
        {/* Power */}
        <View style={{ alignItems: 'center', justifyContent: 'center', paddingHorizontal: 11, paddingVertical: 13 }}>
          <Pressable
            onPress={handleTune}
            disabled={offline}
            accessibilityRole="button"
            accessibilityLabel={offline ? 'Stream offline' : tunedIn ? 'Tune out' : 'Tune in'}
            accessibilityState={{ disabled: offline, selected: tunedIn }}
            style={{
              width: 50,
              height: 50,
              borderRadius: 25,
              borderWidth: 1.5,
              borderColor: powerColor,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: offline ? 0.4 : 1,
              shadowColor: colors.accent,
              shadowOpacity: tunedIn ? 0.5 : 0,
              shadowRadius: 8,
              shadowOffset: { width: 0, height: 0 },
            }}
          >
            {connecting ? (
              <ActivityIndicator size="small" color={colors.accent} />
            ) : (
              <View style={{ width: 22, height: 22, alignItems: 'center', justifyContent: 'center' }}>
                <View style={{ width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: powerColor }} />
                <View
                  style={{ position: 'absolute', top: 0, left: '50%', marginLeft: -1, width: 2, height: 8, backgroundColor: powerColor }}
                />
              </View>
            )}
          </Pressable>
        </View>

        {/* Signal */}
        <View
          style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 10, borderLeftWidth: 1, borderRightWidth: 1, borderColor: colors.softBorder }}
        >
          <View className="flex-row items-baseline justify-between" style={{ gap: 6 }}>
            <Text className="font-mono text-ink" style={{ fontSize: 10 }} numberOfLines={1}>
              Signal ·{' '}
              <Text style={{ color: qualityActive ? colors.accent : colors.muted, fontWeight: '700' }}>
                {qualityLabel}
              </Text>
            </Text>
            <Text className="font-mono text-muted" style={{ fontSize: 10 }} numberOfLines={1}>
              {readout}
            </Text>
          </View>

          {/* 26-tick scale + grip */}
          <View style={{ height: 20, marginTop: 7 }}>
            <View style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, flexDirection: 'row', justifyContent: 'space-between' }}>
              {Array.from({ length: TICKS }).map((_, i) => (
                <View
                  key={i}
                  style={{ width: 1, backgroundColor: i % 2 === 0 ? colors.muted : colors.softBorder, opacity: i % 2 === 0 ? 0.5 : 1 }}
                />
              ))}
            </View>
            <View style={{ position: 'absolute', top: -2, bottom: -2, left: `${gripPct}%`, width: 10, marginLeft: -5, alignItems: 'center' }}>
              <View style={{ position: 'absolute', top: 0, bottom: 0, width: 3, backgroundColor: colors.accent }} />
              <View
                style={{
                  position: 'absolute',
                  top: '50%',
                  marginTop: -6.5,
                  width: 10,
                  height: 13,
                  borderRadius: 1,
                  backgroundColor: colors.accent,
                  shadowColor: colors.accent,
                  shadowOpacity: 0.5,
                  shadowRadius: 4,
                  shadowOffset: { width: 0, height: 0 },
                }}
              />
            </View>
          </View>

          {/* 0–250 ruler */}
          <View className="flex-row justify-between" style={{ marginTop: 4 }}>
            {RULER.map((n) => (
              <Text key={n} className="font-mono text-muted" style={{ fontSize: 8.5 }}>
                {n}
              </Text>
            ))}
          </View>
        </View>

        {/* Volume */}
        <View className="flex-row items-center" style={{ gap: 9, paddingHorizontal: 11, paddingVertical: 13 }}>
          <RotaryKnob value={muted ? 0 : volume} onChange={(v) => { setVolume(v); if (muted) handleMute(); }} />
          <Pressable
            onPress={handleMute}
            accessibilityRole="button"
            accessibilityLabel={muted ? 'Unmute' : 'Mute'}
            accessibilityState={{ selected: muted }}
            style={{
              width: 36,
              height: 36,
              borderWidth: 1,
              borderColor: muted ? colors.accent : colors.muted,
              backgroundColor: muted ? `${colors.accent}1a` : 'transparent',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <DotGrille color={muted ? colors.accent : colors.muted} />
          </Pressable>
        </View>
        </View>
      </View>
    </View>
  );
}

// Speaker-grille: a 4×4 grid of evenly-spaced dots filling the square, matching
// the web player's radial-dot grille.
function DotGrille({ color }: { color: string }) {
  return (
    <View style={{ width: 26, height: 26, justifyContent: 'space-between' }}>
      {[0, 1, 2, 3].map((r) => (
        <View key={r} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          {[0, 1, 2, 3].map((c) => (
            <View key={c} style={{ width: 2.5, height: 2.5, borderRadius: 1.25, backgroundColor: color }} />
          ))}
        </View>
      ))}
    </View>
  );
}

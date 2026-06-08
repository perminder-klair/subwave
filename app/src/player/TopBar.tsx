// Masthead: wordmark + station name, the on-air show + host (taps open the
// schedule), the context tagline, and controls for theme + station switching.
// Adapted from web TopBar for a phone-width single column.

import { router } from 'expo-router';
import { Palette, Radio } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { buildTagline } from '@/lib/tagline';
import type { ActiveShow, StationContext } from '@/lib/types';
import { useTheme } from '@/theme/ThemeContext';

export interface TopBarProps {
  tunedIn: boolean;
  context: StationContext | null;
  stationName?: string;
  djName?: string;
  activeShow: ActiveShow | null;
  onOpenSchedule: () => void;
  onOpenThemes: () => void;
}

export default function TopBar({
  context,
  stationName,
  djName,
  activeShow,
  onOpenSchedule,
  onOpenThemes,
}: TopBarProps) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const tagline = buildTagline(context);
  const showName = activeShow?.name || null;
  const onAirName = activeShow?.persona?.name || djName;

  return (
    <View
      style={{ paddingTop: insets.top + 8, borderBottomWidth: 1, borderBottomColor: colors.softBorder }}
      className="px-5 pb-3"
    >
      <View className="flex-row items-center justify-between">
        <Text
          className="font-mono text-ink"
          style={{ fontSize: 12, letterSpacing: 3 }}
          numberOfLines={1}
        >
          {(stationName?.trim() || 'SUB/WAVE').toUpperCase()}
        </Text>
        <View className="flex-row items-center" style={{ gap: 18 }}>
          <Pressable onPress={onOpenThemes} hitSlop={10} accessibilityRole="button" accessibilityLabel="Theme">
            <Palette size={18} color={colors.muted} />
          </Pressable>
          <Pressable onPress={() => router.push('/stations')} hitSlop={10} accessibilityRole="button" accessibilityLabel="Switch station">
            <Radio size={18} color={colors.muted} />
          </Pressable>
        </View>
      </View>

      {(showName || onAirName) && (
        <Pressable onPress={onOpenSchedule} accessibilityRole="button" accessibilityLabel="Open schedule" className="flex-row flex-wrap items-baseline mt-2" style={{ gap: 8 }}>
          {showName ? (
            <Text className="font-body-medium text-ink" style={{ fontSize: 13 }} numberOfLines={1}>
              ▸ {showName}
            </Text>
          ) : null}
          {onAirName ? (
            <Text className="font-body-medium text-accent" style={{ fontSize: 13 }} numberOfLines={1}>
              with {onAirName}
            </Text>
          ) : null}
        </Pressable>
      )}

      {tagline ? (
        <Text className="font-mono text-muted mt-1.5" style={{ fontSize: 11 }} numberOfLines={1}>
          {tagline}
        </Text>
      ) : null}
    </View>
  );
}

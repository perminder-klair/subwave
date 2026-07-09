// Masthead: a single marks row — spinning disc, wordmark/station name, caret, and
// the on-air show + host all inline (tap to switch station) — with the theme
// palette on the right and the context tagline beneath. Adapted from the web
// TopBar for a phone-width single column.

import { router } from 'expo-router';
import { MoonStar, Palette } from 'lucide-react-native';
import { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { CastButton } from 'react-native-google-cast';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AirplayButton from '../../modules/airplay-route-picker';
import DiscMark from '@/components/DiscMark';
import { buildTagline } from '@/lib/tagline';
import type { ActiveShow, StationContext } from '@/lib/types';
import { useTheme } from '@/theme/ThemeContext';

export interface TopBarProps {
  tunedIn: boolean;
  context: StationContext | null;
  stationName?: string;
  djName?: string;
  activeShow: ActiveShow | null;
  onOpenThemes: () => void;
  onOpenSleep: () => void;
  /** Accent-tints the moon while a sleep timer is armed. */
  sleepActive: boolean;
  /** Render the Google Cast button — false for stations that can't cast
   *  (basic-auth streams) and devices without the Cast framework. */
  castAvailable: boolean;
}

export default function TopBar({
  tunedIn,
  context,
  stationName,
  djName,
  activeShow,
  onOpenThemes,
  onOpenSleep,
  sleepActive,
  castAvailable,
}: TopBarProps) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  // context is reference-stable between polls (useStationFeed), so this only
  // recomputes when the tagline inputs actually change.
  const tagline = useMemo(() => buildTagline(context), [context]);
  const showName = activeShow?.name || null;
  const onAirName = activeShow?.persona?.name || djName;

  return (
    <View
      style={{ paddingTop: insets.top + 8, borderBottomWidth: 1, borderBottomColor: colors.softBorder }}
      className="px-5 pb-3"
    >
      <View className="flex-row items-center justify-between">
        <Pressable
          onPress={() => router.push('/stations')}
          accessibilityRole="button"
          accessibilityLabel="Switch station"
          className="flex-row items-center"
          style={{ gap: 8, flex: 1 }}
        >
          <DiscMark size={18} spinning={tunedIn} />
          <Text className="font-mono text-ink" style={{ fontSize: 12, letterSpacing: 2 }} numberOfLines={1}>
            {(stationName?.trim() || 'SUB/WAVE').toUpperCase()}
          </Text>
          <Text className="font-mono text-muted" style={{ fontSize: 12 }}>⌄</Text>
          {showName ? (
            <Text className="font-mono text-ink" style={{ fontSize: 10, letterSpacing: 1.4, flexShrink: 1, marginLeft: 2, opacity: 0.9 }} numberOfLines={1}>
              ▸ {showName.toUpperCase()}
            </Text>
          ) : null}
          {onAirName ? (
            <Text className="font-mono text-accent" style={{ fontSize: 10, letterSpacing: 1.4 }} numberOfLines={1}>
              WITH {onAirName.toUpperCase()}
            </Text>
          ) : null}
        </Pressable>
        <View className="flex-row items-center" style={{ gap: 14, paddingLeft: 12 }}>
          {/* Output routing: AirPlay (iOS, renders nothing on Android) and
              Google Cast. Both are the platform-native pickers — tapping opens
              the system route/device dialog. */}
          <AirplayButton
            tint={colors.muted}
            activeTint={colors.accent}
            style={{ width: 20, height: 20 }}
          />
          {castAvailable ? (
            <CastButton style={{ width: 20, height: 20, tintColor: colors.muted }} />
          ) : null}
          <Pressable
            onPress={onOpenSleep}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={sleepActive ? 'Sleep timer (armed)' : 'Sleep timer'}
            accessibilityState={{ selected: sleepActive }}
          >
            <MoonStar size={18} color={sleepActive ? colors.accent : colors.muted} />
          </Pressable>
          <Pressable onPress={onOpenThemes} hitSlop={10} accessibilityRole="button" accessibilityLabel="Theme">
            <Palette size={18} color={colors.muted} />
          </Pressable>
        </View>
      </View>

      {tagline ? (
        <Text className="font-mono text-muted mt-1.5" style={{ fontSize: 11 }} numberOfLines={1}>
          {tagline}
        </Text>
      ) : null}
    </View>
  );
}

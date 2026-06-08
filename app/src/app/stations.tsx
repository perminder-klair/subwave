// Station switcher: featured (pinned) + recents (MRU). Switching tears down the
// current playback before re-pointing the app at the new station.

import { router } from 'expo-router';
import { Plus, Radio, X } from 'lucide-react-native';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { teardown } from '@/audio/player';
import { useStation } from '@/config/StationContext';
import { normalizeBase } from '@/lib/api';
import type { StationRef } from '@/lib/station';
import { useTheme } from '@/theme/ThemeContext';

export default function Stations() {
  const { recents, featured, base, selectStation, forgetStation } = useStation();
  const { colors } = useTheme();

  const switchTo = async (ref: StationRef) => {
    if (normalizeBase(ref.url) !== base) {
      await teardown();
      await selectStation(ref);
    }
    router.replace('/');
  };

  const rows: StationRef[] = [
    featured,
    ...recents.filter((r) => normalizeBase(r.url) !== normalizeBase(featured.url)),
  ];

  return (
    <SafeAreaView className="flex-1 bg-bg">
      <View className="flex-row items-center justify-between px-6 pt-4 pb-2">
        <Text className="font-display text-ink" style={{ fontSize: 24 }}>
          Stations
        </Text>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <X size={22} color={colors.ink} />
        </Pressable>
      </View>

      <ScrollView className="flex-1 px-4" contentContainerStyle={{ paddingVertical: 8 }}>
        {rows.map((station) => {
          const active = normalizeBase(station.url) === base;
          const isFeatured = normalizeBase(station.url) === normalizeBase(featured.url);
          return (
            <Pressable
              key={station.url}
              onPress={() => switchTo(station)}
              className="flex-row items-center rounded-xl px-4 py-4 mb-2"
              style={{
                backgroundColor: colors.field,
                borderWidth: 1,
                borderColor: active ? colors.accent : colors.softBorder,
              }}
            >
              <Radio size={20} color={active ? colors.accent : colors.muted} />
              <View className="flex-1 ml-3">
                <Text className="font-body-semibold text-ink" style={{ fontSize: 15 }}>
                  {station.name}
                  {isFeatured ? '  ·  featured' : ''}
                </Text>
                <Text className="font-mono text-muted mt-0.5" style={{ fontSize: 12 }}>
                  {station.url.replace(/^https?:\/\//, '')}
                </Text>
              </View>
              {!isFeatured ? (
                <Pressable onPress={() => forgetStation(station.url)} hitSlop={10} className="pl-3">
                  <X size={16} color={colors.muted} />
                </Pressable>
              ) : null}
            </Pressable>
          );
        })}

        <Pressable
          onPress={() => router.push('/onboarding')}
          className="flex-row items-center rounded-xl px-4 py-4 mt-1"
          style={{ borderWidth: 1, borderColor: colors.softBorder, borderStyle: 'dashed' }}
        >
          <Plus size={20} color={colors.muted} />
          <Text className="font-body text-muted ml-3" style={{ fontSize: 15 }}>
            Add a station
          </Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

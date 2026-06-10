// Station switcher, styled after the web mock: the tuned-in station as an accent
// card, recents as live-dot rows, and a dashed "Add a station". Switching goes
// through selectStation (which tears down playback before re-pointing the app);
// navigation returns to the EXISTING root player via dismissTo — replace() here
// would stack a second player screen on top of the modal (overlapping screens,
// duplicate polling). Long-press a recent to forget it.

import { router } from 'expo-router';
import { ChevronRight, X } from 'lucide-react-native';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import LiveDot from '@/components/LiveDot';
import { useStation } from '@/config/StationContext';
import { normalizeBase } from '@/lib/api';
import type { StationRef } from '@/lib/station';
import { useTheme } from '@/theme/ThemeContext';

const stripProto = (u: string) => u.replace(/^https?:\/\//, '');

function Divider({ children }: { children: string }) {
  const { colors } = useTheme();
  return (
    <View className="flex-row items-center" style={{ gap: 10, paddingTop: 18, paddingBottom: 4 }}>
      <Text className="font-mono text-muted" style={{ fontSize: 10, letterSpacing: 2.2, textTransform: 'uppercase', fontWeight: '700' }}>
        {children}
      </Text>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.softBorder }} />
    </View>
  );
}

export default function Stations() {
  const { recents, featured, base, name, selectStation, forgetStation } = useStation();
  const { colors } = useTheme();

  const switchTo = async (ref: StationRef) => {
    if (normalizeBase(ref.url) !== base) {
      await selectStation(ref);
    }
    router.dismissTo('/');
  };

  const currentUrl = base;
  // `name` comes from the recents lookup; if the active station was forgotten
  // (long-press) fall back to its host, not the featured station's name.
  const currentName =
    name || (currentUrl === featured.url ? featured.name : stripProto(currentUrl ?? ''));
  const others: StationRef[] = [featured, ...recents].filter(
    (r) => normalizeBase(r.url) !== currentUrl,
  );
  // de-dupe by url
  const seen = new Set<string>();
  const recentRows = others.filter((r) => {
    const k = normalizeBase(r.url);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return (
    <SafeAreaView className="flex-1 bg-bg">
      <View className="flex-row items-center justify-between px-5 pt-4 pb-1">
        <Text className="font-display text-ink" style={{ fontSize: 24 }}>
          Stations
        </Text>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
          <X size={20} color={colors.ink} />
        </Pressable>
      </View>

      <ScrollView className="flex-1 px-5" contentContainerStyle={{ paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
        {currentUrl ? (
          <>
            <Divider>Tuned in</Divider>
            <View style={{ borderWidth: 1, borderColor: colors.accent, backgroundColor: `${colors.accent}17`, padding: 14, gap: 6 }}>
              <View className="flex-row items-center justify-between" style={{ gap: 10 }}>
                <Text className="font-body-semibold text-ink" style={{ fontSize: 16 }} numberOfLines={1}>
                  {currentName}
                </Text>
                <View className="flex-row items-center" style={{ gap: 6 }}>
                  <LiveDot size={6} />
                  <Text className="font-mono text-accent" style={{ fontSize: 9, letterSpacing: 2, textTransform: 'uppercase', fontWeight: '700' }}>
                    on air
                  </Text>
                </View>
              </View>
              <Text className="font-mono text-ink" style={{ fontSize: 11, opacity: 0.8 }} numberOfLines={1}>
                {stripProto(currentUrl)}
              </Text>
            </View>
          </>
        ) : null}

        {recentRows.length ? <Divider>Recent</Divider> : null}
        {recentRows.map((st) => (
          <Pressable
            key={st.url}
            onPress={() => switchTo(st)}
            onLongPress={() => forgetStation(st.url)}
            accessibilityRole="button"
            accessibilityLabel={`Tune in to ${st.name}`}
            accessibilityHint="Long-press to forget"
            className="flex-row items-center"
            style={{ gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.softBorder }}
          >
            <LiveDot />
            <View className="flex-1">
              <Text className="font-body-semibold text-ink" style={{ fontSize: 14 }} numberOfLines={1}>
                {st.name}
              </Text>
              <Text className="font-mono text-muted" style={{ fontSize: 11 }} numberOfLines={1}>
                {stripProto(st.url)}
              </Text>
            </View>
            <ChevronRight size={15} color={colors.muted} />
          </Pressable>
        ))}

        <Pressable
          onPress={() => router.push('/onboarding')}
          accessibilityRole="button"
          accessibilityLabel="Add a station"
          className="flex-row items-center justify-center"
          style={{ gap: 8, marginTop: 14, paddingVertical: 14, borderWidth: 1, borderColor: colors.muted, borderStyle: 'dashed' }}
        >
          <Text className="text-accent" style={{ fontSize: 18, fontWeight: '700', lineHeight: 18 }}>
            +
          </Text>
          <Text className="font-mono text-ink" style={{ fontSize: 11, letterSpacing: 1.6, textTransform: 'uppercase', fontWeight: '700' }}>
            Add a station
          </Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

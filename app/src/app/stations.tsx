// Station switcher, styled after the web mock: the tuned-in station as an accent
// card, recents as live-dot rows, and a dashed "Add a station". Switching goes
// through selectStation (which tears down playback before re-pointing the app);
// navigation returns to the EXISTING root player via dismissTo — replace() here
// would stack a second player screen on top of the modal (overlapping screens,
// duplicate polling). Saved stations carry a trash button (long-press works
// too); both confirm before forgetting. The featured station is config-seeded
// and would silently reappear, so it never offers removal.

import { router } from 'expo-router';
import { ChevronRight, Trash2, X } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import LiveDot from '@/components/LiveDot';
import StationLiveStatus from '@/components/StationLiveStatus';
import { useStation } from '@/config/StationContext';
import { normalizeBase } from '@/lib/api';
import { fetchDirectory, type DirectoryStation } from '@/lib/directory';
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
  const [directory, setDirectory] = useState<DirectoryStation[]>([]);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchDirectory(ctrl.signal).then((list) => setDirectory(list));
    return () => ctrl.abort();
  }, []);

  const switchTo = async (ref: StationRef) => {
    if (normalizeBase(ref.url) !== base) {
      await selectStation(ref);
    }
    router.dismissTo('/');
  };

  const confirmForget = (st: StationRef) => {
    Alert.alert('Remove station?', `${st.name} will be removed from your stations.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => forgetStation(st.url) },
    ]);
  };

  // Tapping a directory station deep-links into onboarding's health-check so a
  // dead/asleep station fails gracefully before we tune in (see onboarding.tsx).
  const discover = (st: DirectoryStation) =>
    router.push({ pathname: '/onboarding', params: { url: st.url, name: st.name } });

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

  // Discover = the community directory minus anything already shown above
  // (tuned-in, featured, or a recent) and minus directory dupes.
  if (currentUrl) seen.add(normalizeBase(currentUrl));
  const discoverRows = directory.filter((st) => {
    const k = normalizeBase(st.url);
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
        {recentRows.map((st) => {
          const removable = normalizeBase(st.url) !== normalizeBase(featured.url);
          return (
            <Pressable
              key={st.url}
              onPress={() => switchTo(st)}
              onLongPress={removable ? () => confirmForget(st) : undefined}
              accessibilityRole="button"
              accessibilityLabel={`Tune in to ${st.name}`}
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
              {removable ? (
                <Pressable
                  onPress={() => confirmForget(st)}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${st.name}`}
                  style={{ padding: 4 }}
                >
                  <Trash2 size={15} color={colors.muted} />
                </Pressable>
              ) : null}
              <ChevronRight size={15} color={colors.muted} />
            </Pressable>
          );
        })}

        {discoverRows.length ? <Divider>Discover</Divider> : null}
        {discoverRows.map((st) => {
          const sub = [st.location, st.genre].filter(Boolean).join(' · ');
          return (
            <Pressable
              key={st.slug || st.url}
              onPress={() => discover(st)}
              accessibilityRole="button"
              accessibilityLabel={`Tune in to ${st.name}`}
              className="flex-row items-center"
              style={{ gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.softBorder }}
            >
              <View className="flex-1">
                <Text className="font-body-semibold text-ink" style={{ fontSize: 14 }} numberOfLines={1}>
                  {st.name}
                </Text>
                <Text className="font-mono text-muted" style={{ fontSize: 11 }} numberOfLines={1}>
                  {sub || stripProto(st.url)}
                </Text>
                <View style={{ marginTop: 4 }}>
                  <StationLiveStatus url={st.url} />
                </View>
              </View>
              <ChevronRight size={15} color={colors.muted} />
            </Pressable>
          );
        })}

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

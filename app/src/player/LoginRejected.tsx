// The station refused the saved Station login (#1873, useLoginCheck). Like
// the private-station prompt it sits over a dimmed player, so the listener
// cannot tune back into a stream that will only be refused, and offers the
// way out: edit the login, check again, or leave for another station.

import { BlurView } from 'expo-blur';
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/theme/ThemeContext';

export interface LoginRejectedProps {
  /** The active station's saved base URL, for the edit screen. */
  base: string;
  stationName: string | null;
  recheck: () => Promise<void>;
}

export default function LoginRejected({ base, stationName, recheck }: LoginRejectedProps) {
  const { colors, mode } = useTheme();
  const [busy, setBusy] = useState(false);

  const tryAgain = async () => {
    if (busy) return;
    setBusy(true);
    await recheck();
    setBusy(false);
  };

  return (
    <View style={[StyleSheet.absoluteFill, { zIndex: 41 }]} accessibilityViewIsModal>
      <BlurView
        intensity={30}
        tint={mode === 'light' ? 'light' : 'dark'}
        blurMethod="dimezisBlurView"
        style={StyleSheet.absoluteFill}
      />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg, opacity: 0.8 }]} />
      <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 24 }}>
        <View style={{ borderWidth: 1, borderColor: colors.ink, backgroundColor: colors.bg, padding: 22 }}>
          <Text className="font-mono text-muted" style={{ fontSize: 10, letterSpacing: 2.2, textTransform: 'uppercase' }}>
            station login
          </Text>
          <Text accessibilityRole="alert" className="font-display text-ink" style={{ fontSize: 24, lineHeight: 28, marginTop: 8 }}>
            Station login rejected
          </Text>
          <Text className="font-body text-muted" style={{ fontSize: 13, lineHeight: 20, marginTop: 10 }}>
            {stationName || 'This station'} did not accept the saved login, so the stream can&apos;t
            start. Update the username and password to keep listening.
          </Text>
          <Pressable
            onPress={() => router.push({ pathname: '/station-login', params: { url: base, name: stationName ?? '' } })}
            accessibilityRole="button"
            accessibilityLabel="Edit station login"
            className="items-center justify-center"
            style={{ marginTop: 16, backgroundColor: colors.accent, paddingVertical: 14 }}
          >
            <Text className="font-body-semibold" style={{ color: '#fff', fontSize: 14, letterSpacing: 0.3 }}>
              Edit station login
            </Text>
          </Pressable>
          <Pressable
            onPress={tryAgain}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Check the login again"
            accessibilityState={{ disabled: busy, busy }}
            className="flex-row items-center justify-center"
            style={{ gap: 8, marginTop: 10, borderWidth: 1, borderColor: colors.accent, paddingVertical: 13 }}
          >
            {busy ? <ActivityIndicator size="small" color={colors.accent} /> : null}
            <Text className="font-body text-accent" style={{ fontSize: 13 }}>
              {busy ? 'Checking…' : 'Try again'}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => router.push('/stations')}
            accessibilityRole="button"
            accessibilityLabel="Choose another station"
            className="items-center"
            style={{ marginTop: 12, paddingVertical: 8 }}
          >
            <Text className="font-mono text-muted" style={{ fontSize: 10.5, letterSpacing: 1.6, textTransform: 'uppercase' }}>
              Choose another station
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

// The private-station password prompt (#478). With the private player on it
// stands in for the whole player (`solid`); with only the stream password on,
// it sits over a dimmed player. Either way the listener can leave for another
// station — unlike the web player, this app is not tied to one.

import { BlurView } from 'expo-blur';
import { router } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { StationAuthResult } from '@/lib/station-password';
import { useTheme } from '@/theme/ThemeContext';

const FAILURE_COPY: Record<Exclude<StationAuthResult, 'ok'>, string> = {
  denied: 'That password was not accepted.',
  'rate-limited': 'Too many attempts. Wait a few minutes, then try again.',
  unavailable: 'Could not reach the station. Check your connection and try again.',
};

export interface StationGateProps {
  /** Checking a saved password: show a spinner, not the form. */
  checking: boolean;
  solid: boolean;
  stationName: string | null;
  unlock: (password: string) => Promise<StationAuthResult>;
}

export default function StationGate({ checking, solid, stationName, unlock }: StationGateProps) {
  const { colors, mode } = useTheme();
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const password = input.trim();
    if (!password || busy) return;
    setBusy(true);
    setError('');
    const result = await unlock(password);
    setBusy(false);
    if (result !== 'ok') setError(FAILURE_COPY[result]);
  };

  return (
    <View
      style={[StyleSheet.absoluteFill, { zIndex: 40, backgroundColor: solid ? colors.bg : 'transparent' }]}
      accessibilityViewIsModal
    >
      {solid ? null : (
        // Opacity rather than an alpha suffix: a theme colour may be rgb().
        <>
          <BlurView
            intensity={30}
            tint={mode === 'light' ? 'light' : 'dark'}
            blurMethod="dimezisBlurView"
            style={StyleSheet.absoluteFill}
          />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg, opacity: 0.8 }]} />
        </>
      )}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 24 }}
      >
        {checking ? (
          <ActivityIndicator color={colors.accent} accessibilityLabel="Checking the station password" />
        ) : (
          <View style={{ borderWidth: 1, borderColor: colors.ink, backgroundColor: colors.bg, padding: 22 }}>
            <Text className="font-mono text-muted" style={{ fontSize: 10, letterSpacing: 2.2, textTransform: 'uppercase' }}>
              members only
            </Text>
            <Text className="font-display text-ink" style={{ fontSize: 24, lineHeight: 28, marginTop: 8 }}>
              {stationName ? `${stationName} is private.` : 'This station is private.'}
            </Text>
            <Text className="font-body text-muted" style={{ fontSize: 13, lineHeight: 20, marginTop: 10 }}>
              Ask the operator for the station password to tune in.
            </Text>
            <TextInput
              value={input}
              onChangeText={setInput}
              placeholder="station password"
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              autoComplete="password"
              textContentType="password"
              secureTextEntry
              returnKeyType="go"
              onSubmitEditing={submit}
              editable={!busy}
              accessibilityLabel="Station password"
              className="font-mono"
              style={{
                marginTop: 16,
                color: colors.ink,
                backgroundColor: colors.field,
                borderWidth: 1,
                borderColor: colors.muted,
                fontSize: 14,
                paddingVertical: 12,
                paddingHorizontal: 13,
              }}
            />
            {error ? (
              <Text
                accessibilityRole="alert"
                className="font-body"
                style={{ color: colors.accent, fontSize: 13, lineHeight: 19, marginTop: 10 }}
              >
                {error}
              </Text>
            ) : null}
            <Pressable
              onPress={submit}
              disabled={busy || !input.trim()}
              accessibilityRole="button"
              accessibilityLabel="Tune in"
              accessibilityState={{ disabled: busy || !input.trim(), busy }}
              className="items-center justify-center"
              style={{
                marginTop: 16,
                backgroundColor: colors.accent,
                paddingVertical: 14,
                opacity: busy || !input.trim() ? 0.45 : 1,
              }}
            >
              <Text className="font-body-semibold" style={{ color: '#fff', fontSize: 14, letterSpacing: 0.3 }}>
                {busy ? 'Checking…' : 'Tune in'}
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
        )}
      </KeyboardAvoidingView>
    </View>
  );
}

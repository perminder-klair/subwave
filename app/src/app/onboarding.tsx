// First-launch (or "add station") screen: enter a SUB/WAVE station URL, health-
// check it before saving, fetch its name, then tune in. Prefilled with the
// featured station from app.json.

import { router } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { createApi, normalizeBase } from '@/lib/api';
import { useStation } from '@/config/StationContext';
import { useTheme } from '@/theme/ThemeContext';

const PROBE_TIMEOUT_MS = 4500;

export default function Onboarding() {
  const { featured, selectStation, base } = useStation();
  const { colors } = useTheme();
  const [url, setUrl] = useState(featured.url);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    const normalized = normalizeBase(url);
    if (!normalized) {
      setError('Enter a station URL.');
      return;
    }
    setBusy(true);
    setError(null);
    const api = createApi(normalized);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    try {
      const ok = await api.health(ctrl.signal);
      if (!ok) throw new Error('unreachable');
      let name = featured.url === normalized ? featured.name : normalized.replace(/^https?:\/\//, '');
      try {
        const dj = await api.dj(ctrl.signal);
        if (dj?.station || dj?.name) name = dj.station || dj.name || name;
      } catch {
        /* name is best-effort */
      }
      await selectStation({ url: normalized, name });
      router.replace('/');
    } catch {
      setError("Couldn't reach that station — check the URL and that it's online.");
    } finally {
      clearTimeout(timer);
      setBusy(false);
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-bg">
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View className="flex-1 justify-center px-7">
          <Text className="font-mono text-ink/60 uppercase" style={{ letterSpacing: 3, fontSize: 11 }}>
            SUB/WAVE
          </Text>
          <Text className="font-display text-ink mt-3" style={{ fontSize: 34, lineHeight: 38 }}>
            Tune to a station
          </Text>
          <Text className="font-body text-muted mt-3" style={{ fontSize: 15, lineHeight: 22 }}>
            SUB/WAVE stations are self-hosted. Enter the web address of the one you want to
            listen to.
          </Text>

          <View className="mt-8">
            <TextInput
              value={url}
              onChangeText={(t) => { setUrl(t); setError(null); }}
              placeholder="https://radio.example.com"
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              inputMode="url"
              returnKeyType="go"
              onSubmitEditing={connect}
              editable={!busy}
              className="font-mono text-ink bg-field rounded-xl px-4 py-4"
              style={{ fontSize: 15, borderWidth: 1, borderColor: colors.softBorder }}
            />
            {error ? (
              <Text className="font-body text-accent mt-3" style={{ fontSize: 13 }}>
                {error}
              </Text>
            ) : null}
          </View>

          <Pressable
            onPress={connect}
            disabled={busy}
            className="mt-6 rounded-xl items-center justify-center"
            style={{ backgroundColor: colors.accent, paddingVertical: 16, opacity: busy ? 0.7 : 1 }}
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text className="font-body-semibold" style={{ color: '#fff', fontSize: 15 }}>
                Connect
              </Text>
            )}
          </Pressable>

          {base ? (
            <Pressable onPress={() => router.back()} className="mt-5 items-center">
              <Text className="font-body text-muted" style={{ fontSize: 14 }}>
                Cancel
              </Text>
            </Pressable>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

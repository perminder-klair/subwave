// Last-resort crash screen for the root ErrorBoundary (src/app/_layout.tsx).
//
// Deliberately self-contained: hardcoded palette, no useTheme / SafeAreaContext
// / NativeWind class tokens — any of those providers could be the thing that
// just crashed, and expo-router renders the boundary OUTSIDE the layout's
// provider tree. Pure inline styles + the (already-loaded) mono font keep it
// rendering no matter what fell over upstream.

import { Pressable, Text, View } from 'react-native';

const BG = '#100e0c';
const INK = '#ece6dc';
const MUTED = '#8a847b';
const ACCENT = '#d94b2a';
const MONO = 'JetBrainsMono_400Regular';

export interface ErrorScreenProps {
  error: Error;
  retry: () => void;
}

export default function ErrorScreen({ error, retry }: ErrorScreenProps) {
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: BG,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 32,
      }}
    >
      <Text
        style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 3, color: ACCENT, marginBottom: 14 }}
      >
        SIGNAL LOST
      </Text>
      <Text
        style={{ fontFamily: MONO, fontSize: 16, color: INK, textAlign: 'center', lineHeight: 24 }}
      >
        The app hit an unexpected error.
      </Text>
      {error?.message ? (
        <Text
          style={{
            fontFamily: MONO,
            fontSize: 11,
            color: MUTED,
            textAlign: 'center',
            marginTop: 12,
            lineHeight: 17,
          }}
          numberOfLines={4}
        >
          {error.message}
        </Text>
      ) : null}
      <Pressable
        onPress={retry}
        accessibilityRole="button"
        accessibilityLabel="Retry"
        style={{
          marginTop: 28,
          borderWidth: 1,
          borderColor: ACCENT,
          paddingVertical: 11,
          paddingHorizontal: 26,
        }}
      >
        <Text style={{ fontFamily: MONO, fontSize: 12, letterSpacing: 2, color: ACCENT }}>
          RETRY
        </Text>
      </Pressable>
    </View>
  );
}

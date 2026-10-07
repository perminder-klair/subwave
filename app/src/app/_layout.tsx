import '../../global.css';

import {
  Fraunces_400Regular,
  Fraunces_600SemiBold,
} from '@expo-google-fonts/fraunces';
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
} from '@expo-google-fonts/jetbrains-mono';
import {
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
} from '@expo-google-fonts/plus-jakarta-sans';
import { useFonts } from 'expo-font';
import { Stack, type ErrorBoundaryProps } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View } from 'react-native';
// Gesture-handler root interceptors block Android taps under New Architecture (#458).
// Use core Modal sheets.
import { SafeAreaProvider } from 'react-native-safe-area-context';
import ErrorScreen from '@/components/ErrorScreen';
import { StationProvider, useStation } from '@/config/StationContext';
import { ThemeProvider } from '@/theme/ThemeContext';

SplashScreen.preventAutoHideAsync().catch(() => {});

// Hide the splash here too: a SplashGate render failure would otherwise
// leave it covering the error screen. RootLayout errors use Expo Router's default boundary.
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  useEffect(() => {
    SplashScreen.hideAsync().catch(() => {});
  }, []);
  return <ErrorScreen error={error} retry={retry} />;
}

function SplashGate({ children }: { children: React.ReactNode }) {
  const { ready } = useStation();
  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => {});
  }, [ready]);
  if (!ready) return null;
  return <>{children}</>;
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Fraunces_400Regular,
    Fraunces_600SemiBold,
    PlusJakartaSans_400Regular,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
  });

  if (!fontsLoaded) return null;

  return (
    <View style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StationProvider>
          <ThemeProvider>
            <SplashGate>
              <StatusBar style="auto" />
              <Stack
                screenOptions={{
                  headerShown: false,
                  animation: 'fade',
                  contentStyle: { backgroundColor: 'transparent' },
                }}
              >
                <Stack.Screen name="index" />
                <Stack.Screen name="onboarding" />
                <Stack.Screen name="stations" options={{ presentation: 'modal' }} />
              </Stack>
            </SplashGate>
          </ThemeProvider>
        </StationProvider>
      </SafeAreaProvider>
    </View>
  );
}

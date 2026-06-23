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
// No GestureHandlerRootView / BottomSheetModalProvider: that gesture-handler +
// bottom-sheet stack installed a root touch interceptor that swallowed every tap
// across the app on the New Architecture on some Android devices (issue #458).
// It existed only for the Themes sheet, which is now a core <Modal> (see
// components/ui/Sheet.tsx). Bisection confirmed on-device: removing this stack
// is what restores touch.
import { SafeAreaProvider } from 'react-native-safe-area-context';
import ErrorScreen from '@/components/ErrorScreen';
import { StationProvider, useStation } from '@/config/StationContext';
import { ThemeProvider } from '@/theme/ThemeContext';

SplashScreen.preventAutoHideAsync().catch(() => {});

// expo-router renders this in place of the route tree when any descendant
// throws during render. Hide the splash here too — a crash inside SplashGate
// (before `ready`) would otherwise strand the native splash over a frozen app.
// A throw from RootLayout itself still falls through to expo-router's default
// handler; that's an accepted gap (see docs/PRODUCTION-READINESS.md A2).
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

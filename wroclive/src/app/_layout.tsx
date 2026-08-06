import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform, useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { hydratePreferences } from '@/lib/preferences';
import { hydrateSelection } from '@/lib/selection';

SplashScreen.preventAutoHideAsync();

/**
 * Lines, alerts and settings are popups over the map, not places you navigate
 * to: the map is the app, and everything else is something you open, read and
 * dismiss. iOS gets a real sheet with detents; the others get a plain modal.
 */
const MODAL_OPTIONS = Platform.select({
  ios: {
    presentation: 'formSheet' as const,
    sheetGrabberVisible: true,
    sheetAllowedDetents: [0.65, 1],
    sheetCornerRadius: 28,
  },
  default: { presentation: 'modal' as const },
});

export default function RootLayout() {
  const colorScheme = useColorScheme();

  useEffect(() => {
    // Read the saved filter and settings before the map draws, so it does not
    // render the whole fleet and then visibly drop most of it a frame later.
    Promise.all([hydrateSelection(), hydratePreferences()]).finally(() => SplashScreen.hideAsync());
  }, []);

  return (
    // The sheet's drag gesture needs this at the root.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        {/* The map runs edge to edge, so the status bar sits over it. */}
        <StatusBar style="auto" />
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="lines" options={MODAL_OPTIONS} />
          <Stack.Screen name="alerts" options={MODAL_OPTIONS} />
          <Stack.Screen name="settings" options={MODAL_OPTIONS} />
        </Stack>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

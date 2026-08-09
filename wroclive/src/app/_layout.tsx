import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform, useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { getLines } from '@/lib/api';
import { hydratePreferences, usePreferences } from '@/lib/preferences';
import { THEMES } from '@/constants/themes';
import { hydrateRecentStops } from '@/lib/recent-stops';
import { hydrateSelection, selectionStore } from '@/lib/selection';

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
  const preferences = usePreferences();
  const dark = colorScheme === 'dark';
  const accent = THEMES[preferences.theme].accent[dark ? 'dark' : 'light'];
  const base = dark ? DarkTheme : DefaultTheme;
  const navigationTheme = {
    ...base,
    colors: {
      ...base.colors,
      primary: accent,
      background: dark ? '#000000' : '#ffffff',
      card: dark ? '#151619' : '#ffffff',
      text: dark ? '#ffffff' : '#000000',
      border: dark ? 'rgba(84,84,88,0.5)' : 'rgba(60,60,67,0.16)',
    },
  };

  useEffect(() => {
    const init = async () => {
      try {
        const hasStoredSelection = await hydrateSelection();
        await Promise.all([hydratePreferences(), hydrateRecentStops()]);

        // On the very first launch there is no saved filter — defaulting to the
        // whole fleet can lag the first paint on a phone. Start with trams only;
        // the fetch uses retryWhileLoading: false so a still-booting server
        // (503) simply skips the default and shows everything instead. Nothing
        // is persisted on failure, so next launch will try again.
        if (!hasStoredSelection) {
          try {
            const lines = await getLines({ retryWhileLoading: false });
            selectionStore.set(lines.allTrams);
          } catch {
            // Server not ready — leave the selection empty (everything).
          }
        }
      } finally {
        SplashScreen.hideAsync();
      }
    };
    init();
  }, []);

  return (
    // The sheet's drag gesture needs this at the root.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={navigationTheme}>
        {/* The map runs edge to edge, so the status bar sits over it. */}
        <StatusBar style="auto" />
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="lines" options={MODAL_OPTIONS} />
          <Stack.Screen name="alerts" options={MODAL_OPTIONS} />
          <Stack.Screen name="settings" options={MODAL_OPTIONS} />
          <Stack.Screen name="search" options={MODAL_OPTIONS} />
        </Stack>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

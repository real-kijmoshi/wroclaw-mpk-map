import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { ErrorScreen } from '@/components/error-screen';
import { getLines } from '@/lib/api';
import { hydratePreferences, usePreferences } from '@/lib/preferences';
import { ACCENT } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { hydrateRecentStops } from '@/lib/recent-stops';
import { hydrateSelection, selectionStore } from '@/lib/selection';
import { syncUpdates, watchForUpdatesOnResume } from '@/lib/updates';

SplashScreen.preventAutoHideAsync();

/**
 * expo-router renders this instead of the route when a render throws.
 *
 * Without it a release build shows a white screen with no way out but force
 * quitting. The name is the contract — expo-router looks for an exported
 * `ErrorBoundary` on a route or layout file.
 */
export function ErrorBoundary({ error, retry }: { error: Error; retry: () => Promise<void> }) {
  return <ErrorScreen error={error} retry={retry} />;
}

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

/**
 * Search opens at full height and stays there.
 *
 * It is the one modal with a keyboard in it: a sheet that stops at a detent
 * leaves the results squeezed between the field and the keyboard, and dragging
 * it while typing dismisses the keyboard instead of the sheet.
 */
const SEARCH_MODAL_OPTIONS = Platform.select({
  ios: {
    presentation: 'formSheet' as const,
    sheetGrabberVisible: true,
    sheetAllowedDetents: [1],
    sheetCornerRadius: 28,
  },
  default: { presentation: 'modal' as const },
});

const LINE_MODAL_OPTIONS = Platform.select({
  ios: {
    presentation: 'formSheet' as const,
    sheetGrabberVisible: true,
    sheetAllowedDetents: [0.78, 1],
    sheetCornerRadius: 24,
  },
  default: { presentation: 'modal' as const },
});

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const preferences = usePreferences();
  const dark = colorScheme === 'dark';
  const imagery =
    Platform.OS === 'ios' &&
    preferences.mapProvider === 'auto' &&
    (preferences.appleMapType === 'satellite' || preferences.appleMapType === 'hybrid');
  const statusBarStyle = imagery ? 'light' : 'auto';
  const accent = ACCENT[dark ? 'dark' : 'light'];
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

  /**
   * Updates run beside the app, never in front of it: the boot check is fired
   * and forgotten so it cannot delay the first paint, and a downloaded bundle
   * only takes over after the user has been away long enough for a reload to
   * cost them nothing. Inert outside release builds — see `@/lib/updates`.
   */
  useEffect(() => {
    syncUpdates();
    return watchForUpdatesOnResume();
  }, []);

  return (
    // The sheet's drag gesture needs this at the root.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={navigationTheme}>
        {/*
         * The map runs edge to edge, so the status bar sits over it — and
         * `style="auto"` follows the phone's colour scheme, which is the wrong
         * input. Satellite and hybrid tiles are a dark photograph in either
         * scheme, and a light-scheme phone was drawing a black clock onto them.
         * What the map is showing decides.
         */}
        <StatusBar style={statusBarStyle} />
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="lines" options={LINE_MODAL_OPTIONS} />
          <Stack.Screen name="alerts" options={MODAL_OPTIONS} />
          <Stack.Screen name="settings" options={MODAL_OPTIONS} />
          <Stack.Screen name="search" options={SEARCH_MODAL_OPTIONS} />
        </Stack>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

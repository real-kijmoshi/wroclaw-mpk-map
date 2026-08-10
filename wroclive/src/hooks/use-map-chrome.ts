import { Platform } from 'react-native';

import { MapChrome, type MapChromeTokens } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { usePreferences } from '@/lib/preferences';

export type MapChromeScheme = 'light' | 'dark';

/**
 * What the chrome floating over the map should be drawn as.
 *
 * The deciding factor is what the map is *showing*, not what the phone is set
 * to. Satellite and hybrid tiles are a dark photograph in both colour schemes,
 * so a light-scheme phone on hybrid was painting black icons and grey secondary
 * text onto near-black imagery. Anything sitting on the map asks here; anything
 * inside a sheet or a modal uses `useTheme()` as before, because it has an
 * opaque background of its own.
 */
export function useMapChrome(): { scheme: MapChromeScheme; tokens: MapChromeTokens } {
  const preferences = usePreferences();
  const colorScheme = useColorScheme();

  // `appleMapType` is only consulted by the MapKit surface: Android's system
  // map is Google's standard base and the web build is a vector tile layer, so
  // neither can be showing imagery no matter what this preference says.
  const imagery =
    Platform.OS === 'ios' &&
    preferences.mapProvider === 'auto' &&
    (preferences.appleMapType === 'satellite' || preferences.appleMapType === 'hybrid');

  const scheme: MapChromeScheme = imagery || colorScheme === 'dark' ? 'dark' : 'light';

  return { scheme, tokens: MapChrome[scheme] };
}

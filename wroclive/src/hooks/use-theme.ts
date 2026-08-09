/**
 * Learn more about light and dark modes:
 * https://docs.expo.dev/guides/color-schemes/
 */

import { Colors } from '@/constants/theme';
import { THEMES, DEFAULT_THEME } from '@/constants/themes';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { usePreferences } from '@/lib/preferences';

export function useTheme() {
  const scheme = useColorScheme();
  const surface = scheme === 'unspecified' ? 'light' : scheme;
  const preferences = usePreferences();
  const themeDef = THEMES[preferences.theme] ?? THEMES[DEFAULT_THEME];

  return { ...Colors[surface], accent: themeDef.accent[surface] };
}

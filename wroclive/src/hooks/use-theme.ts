/**
 * Learn more about light and dark modes:
 * https://docs.expo.dev/guides/color-schemes/
 */

import { Colors, ACCENT } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

/**
 * The full theme object: the light or dark colour palette, plus the fixed
 * accent. `useColorScheme()` resolves the rider's `colorScheme` preference
 * (light, dark, or system), so the surface always matches.
 */
export function useTheme() {
  const scheme = useColorScheme();
  return { ...Colors[scheme], accent: ACCENT[scheme] };
}

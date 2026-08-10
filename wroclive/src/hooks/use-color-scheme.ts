import { useColorScheme as useRNColorScheme } from 'react-native';

import { usePreferences } from '@/lib/preferences';

/**
 * The colour scheme the app should draw in.
 *
 * Follows the rider's `colorScheme` preference: `'light'` and `'dark'` force
 * that scheme, `'system'` defers to the OS. The OS value `'unspecified'`
 * resolves to light, so every caller receives a concrete `'light' | 'dark'`.
 */
export function useColorScheme(): 'light' | 'dark' {
  const { colorScheme } = usePreferences();
  const osScheme = useRNColorScheme();

  if (colorScheme === 'system') {
    return osScheme === 'dark' ? 'dark' : 'light';
  }
  return colorScheme;
}

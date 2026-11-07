import { Colors, ACCENT } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

/** Return the active colour palette and accent. */
export function useTheme() {
  const scheme = useColorScheme();
  return { ...Colors[scheme], accent: ACCENT[scheme] };
}

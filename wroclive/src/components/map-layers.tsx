import Ionicons from '@expo/vector-icons/Ionicons';
import { Platform, Pressable, StyleSheet } from 'react-native';

import { Glass } from './glass';
import { ThemedText } from './themed-text';
import { Elevation, Radius, Space } from '@/constants/design';
import { useMapChrome } from '@/hooks/use-map-chrome';
import { useTheme } from '@/hooks/use-theme';
import { preferencesStore, usePreferences, type AppleMapType } from '@/lib/preferences';

type Option = { id: AppleMapType | 'osm'; label: string; icon: keyof typeof Ionicons.glyphMap };

/**
 * The base map choices this platform actually has.
 *
 * `appleMapType` is only read by the MapKit surface, so offering satellite on
 * Android would be a control that does nothing. Everywhere else the real choice
 * is between the platform's own map and the OpenStreetMap tiles.
 */
const OPTIONS: Option[] = Platform.select({
  ios: [
    { id: 'standard', label: 'Mapa', icon: 'map-outline' },
    { id: 'hybrid', label: 'Hybrydowa', icon: 'earth-outline' },
    { id: 'satellite', label: 'Satelita', icon: 'globe-outline' },
    { id: 'osm', label: 'OSM', icon: 'layers-outline' },
  ],
  default: [
    { id: 'standard', label: 'Mapa', icon: 'map-outline' },
    { id: 'osm', label: 'OSM', icon: 'layers-outline' },
  ],
});

/**
 * The base map picker, anchored to the map controls.
 *
 * Changing the base map used to mean opening Settings, scrolling to the second
 * group and coming back — for the one setting a rider changes while looking at
 * the map, because the imagery is unreadable in the dark or the vector map is
 * missing the building they are looking for. Same store, same persistence
 * (`preferencesStore`); this is only a faster way to reach it.
 */
export function MapLayers({ onClose }: { onClose: () => void }) {
  const preferences = usePreferences();
  const { scheme, tokens } = useMapChrome();
  const theme = useTheme();

  const current: Option['id'] = preferences.mapProvider === 'osm' ? 'osm' : preferences.appleMapType;

  const choose = (id: Option['id']) => {
    if (id === 'osm') {
      preferencesStore.set('mapProvider', 'osm');
    } else {
      preferencesStore.set('mapProvider', 'auto');
      preferencesStore.set('appleMapType', id);
    }
    onClose();
  };

  return (
    <Glass variant="chrome" scheme={scheme} style={styles.card}>
      {OPTIONS.map((option) => {
        const selected = option.id === current;
        return (
          <Pressable
            key={option.id}
            onPress={() => choose(option.id)}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={option.label}
            style={({ pressed }) => [
              styles.option,
              selected && { backgroundColor: tokens.fill },
              pressed && { backgroundColor: tokens.fill },
            ]}>
            <Ionicons
              name={option.icon}
              size={18}
              color={selected ? theme.accent : tokens.text}
            />
            <ThemedText
              type="footnote"
              weight={selected ? 'semibold' : 'medium'}
              color={selected ? theme.accent : tokens.text}
              numberOfLines={1}
              style={styles.label}>
              {option.label}
            </ThemedText>
          </Pressable>
        );
      })}
    </Glass>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: Radius.md, padding: Space.xs, gap: 2, minWidth: 148, ...Elevation.floating },
  option: {
    minHeight: 38,
    borderRadius: Radius.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    paddingHorizontal: Space.sm,
  },
  label: { flex: 1 },
});

import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, StyleSheet, View } from 'react-native';

import { Glass } from './glass';
import { Elevation, Motion, Radius } from '@/constants/design';
import { useMapChrome } from '@/hooks/use-map-chrome';

export type MapControl = {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  disabled?: boolean;
};

/**
 * The controls that belong to the map itself.
 *
 * Only two things qualify: where am I, and what am I looking at. Lines and
 * alerts used to sit here as well, which made a four-button tower down the
 * right edge of a map that already had a HUD card on it; they are rows in the
 * sheet now.
 *
 * They are drawn as one column on a single stack of glass, the way the
 * platform's own map controls are, so they read as one instrument rather than
 * as buttons someone scattered over the imagery.
 */
export function MapControls({ controls }: { controls: MapControl[] }) {
  const { scheme, tokens } = useMapChrome();

  return (
    <Glass variant="control" scheme={scheme} style={styles.stack}>
      {controls.map((control, index) => (
        <View key={control.label}>
          {index > 0 && <View style={[styles.divider, { backgroundColor: tokens.border }]} />}
          <Pressable
            onPress={control.onPress}
            disabled={control.disabled}
            accessibilityRole="button"
            accessibilityLabel={control.label}
            accessibilityState={{ disabled: Boolean(control.disabled) }}
            style={({ pressed }) => [
              styles.button,
              control.disabled && styles.disabled,
              pressed && { backgroundColor: tokens.fill },
            ]}>
            <Ionicons name={control.icon} size={20} color={tokens.text} />
          </Pressable>
        </View>
      ))}
    </Glass>
  );
}

const styles = StyleSheet.create({
  // 44pt wide, full stop: at the 36pt this used to be, a glass circle over
  // satellite imagery reads as a smudge rather than as a control.
  stack: { borderRadius: Radius.md, ...Elevation.floating },
  button: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  divider: { height: StyleSheet.hairlineWidth },
  disabled: { opacity: Motion.pressedOpacity },
});

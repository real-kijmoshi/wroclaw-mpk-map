import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, StyleSheet, View } from 'react-native';

import { Glass } from './glass';
import { LineBadge } from './line-badge';
import { CHROME_MAX_SCALE, ThemedText } from './themed-text';
import { Elevation, HitTarget, Motion, Radius, Space } from '@/constants/design';
import { useMapChrome } from '@/hooks/use-map-chrome';
import type { ArrivalAlert } from '@/lib/arrival-alerts';
import type { LineType } from '@/lib/api';
import { plural } from '@/lib/format';

export type TripBannerProps = {
  alert: ArrivalAlert;
  vehicleType?: LineType;
  onOpen: () => void;
  onEnd: () => void;
};

/** The onboard trip, kept visible while its vehicle sheet is put away. */
export function TripBanner({ alert, vehicleType, onOpen, onEnd }: TripBannerProps) {
  const { scheme, tokens } = useMapChrome();
  const progress =
    alert.stopsAway === 0
      ? 'To Twój przystanek'
      : alert.stopsAway === 1
        ? 'Następny przystanek'
        : typeof alert.stopsAway === 'number'
          ? `Jeszcze ${alert.stopsAway} ${plural(alert.stopsAway, ['przystanek', 'przystanki', 'przystanków'])}`
          : 'Śledzenie przejazdu';

  return (
    <Glass variant="chrome" scheme={scheme} style={styles.surface}>
      <Pressable
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={`Linia ${alert.line}. Wysiadasz: ${alert.stopName}. ${progress}`}
        accessibilityHint="Otwiera śledzony pojazd"
        style={({ pressed }) => [styles.open, pressed && styles.pressed]}>
        <LineBadge line={alert.line} type={vehicleType} size="small" />
        <View style={styles.copy}>
          <ThemedText
            type="callout"
            weight="semibold"
            color={tokens.text}
            numberOfLines={1}
            maxFontSizeMultiplier={CHROME_MAX_SCALE}>
            Wysiadasz: {alert.stopName}
          </ThemedText>
          <ThemedText
            type="footnote"
            color={tokens.textSecondary}
            numberOfLines={1}
            maxFontSizeMultiplier={CHROME_MAX_SCALE}>
            {progress}
          </ThemedText>
        </View>
        <Ionicons name="chevron-forward" size={16} color={tokens.textSecondary} />
      </Pressable>

      <View style={[styles.divider, { backgroundColor: tokens.border }]} />
      <Pressable
        onPress={onEnd}
        accessibilityRole="button"
        accessibilityLabel="Zakończ śledzenie przejazdu"
        hitSlop={4}
        style={({ pressed }) => [styles.end, pressed && styles.pressed]}>
        <Ionicons name="close" size={20} color={tokens.text} />
      </Pressable>
    </Glass>
  );
}

const styles = StyleSheet.create({
  surface: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'stretch',
    borderRadius: Radius.lg,
    ...Elevation.floating,
  },
  open: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    paddingLeft: Space.md,
    paddingVertical: Space.sm,
  },
  copy: { flex: 1, minWidth: 0 },
  divider: { width: StyleSheet.hairlineWidth, marginVertical: Space.sm },
  end: {
    width: HitTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: Motion.pressedOpacity },
});

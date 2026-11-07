import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, StyleSheet, View } from 'react-native';

import { Glass } from './glass';
import { LineBadge } from './line-badge';
import { CHROME_MAX_SCALE, ThemedText } from './themed-text';
import { Elevation, HitTarget, Motion, Radius, Space } from '@/constants/design';
import { Colors } from '@/constants/theme';
import { useMapChrome } from '@/hooks/use-map-chrome';
import type { ArrivalAlert } from '@/lib/arrival-alerts';
import type { LineType } from '@/lib/api';
import { etaParts, plural } from '@/lib/format';

export type TripDisruption = {
  title: string;
  severity: 'minor' | 'moderate' | 'major' | 'unknown';
};

export type TripBannerProps = {
  alert: ArrivalAlert;
  vehicleType?: LineType;
  now: number;
  disruption?: TripDisruption | null;
  onOpen: () => void;
  onOpenDisruption?: () => void;
  onEnd: () => void;
};

/** The onboard trip, kept visible while its vehicle sheet is put away. */
export function TripBanner({
  alert,
  vehicleType,
  now,
  disruption,
  onOpen,
  onOpenDisruption,
  onEnd,
}: TripBannerProps) {
  const { scheme, tokens } = useMapChrome();
  const completed = alert.phase === 'completed';
  const done = alert.phase === 'arrived' || alert.phase === 'completed';
  const seconds =
    completed || alert.arrivesAt === null || alert.arrivesAt === undefined
      ? null
      : Math.max(0, Math.round((alert.arrivesAt - now) / 1_000));
  const eta = etaParts(seconds);
  const headline = done
    ? `${alert.stopName} — wysiądź tutaj`
    : alert.stopsAway === 1
      ? `Następny: ${alert.stopName}`
      : `Wysiadasz: ${alert.stopName}`;
  const progress = done
    ? alert.phase === 'completed'
      ? 'Przejazd zakończony'
      : 'Jesteś na przystanku'
    : alert.stopsAway === 1
      ? 'Przygotuj się do wyjścia'
      : typeof alert.stopsAway === 'number'
        ? `${alert.nextStop ? `Następny: ${alert.nextStop} · ` : ''}jeszcze ${alert.stopsAway} ${plural(alert.stopsAway, ['przystanek', 'przystanki', 'przystanków'])}`
        : 'Śledzenie przejazdu';

  return (
    <Glass variant="chrome" scheme={scheme} style={styles.surface}>
      <View style={styles.mainRow}>
        <Pressable
          onPress={onOpen}
          disabled={completed}
          accessibilityRole={completed ? 'text' : 'button'}
          accessibilityLabel={`Linia ${alert.line}. ${headline}. ${progress}${eta.value !== '—' ? `. ${eta.value} ${eta.unit}` : ''}`}
          accessibilityHint={completed ? undefined : 'Otwiera śledzony pojazd'}
          style={({ pressed }) => [styles.open, pressed && styles.pressed]}>
          <LineBadge line={alert.line} type={vehicleType} size="small" />
          <View style={styles.copy}>
            <ThemedText
              type="callout"
              weight="semibold"
              color={tokens.text}
              numberOfLines={1}
              maxFontSizeMultiplier={CHROME_MAX_SCALE}>
              {headline}
            </ThemedText>
            <ThemedText
              type="footnote"
              color={tokens.textSecondary}
              numberOfLines={1}
              maxFontSizeMultiplier={CHROME_MAX_SCALE}>
              {progress}
            </ThemedText>
          </View>
          {eta.value !== '—' && (
            <View style={styles.eta}>
              <ThemedText
                type="callout"
                weight="bold"
                color={Colors[scheme].amber}
                numberOfLines={1}
                maxFontSizeMultiplier={CHROME_MAX_SCALE}>
                {eta.value}
              </ThemedText>
              {eta.unit && (
                <ThemedText
                  type="caption"
                  color={tokens.textSecondary}
                  maxFontSizeMultiplier={CHROME_MAX_SCALE}>
                  {eta.unit}
                </ThemedText>
              )}
            </View>
          )}
          {!completed && <Ionicons name="chevron-forward" size={16} color={tokens.textSecondary} />}
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
      </View>

      {disruption && onOpenDisruption && (
        <Pressable
          onPress={onOpenDisruption}
          accessibilityRole="button"
          accessibilityLabel={`Utrudnienie na linii ${alert.line}: ${disruption.title}`}
          style={({ pressed }) => [
            styles.disruption,
            { borderTopColor: tokens.border },
            pressed && styles.pressed,
          ]}>
          <Ionicons
            name={disruption.severity === 'major' ? 'warning' : 'warning-outline'}
            size={15}
            color={tokens.text}
          />
          <ThemedText
            type="footnote"
            weight="semibold"
            color={tokens.text}
            numberOfLines={1}
            maxFontSizeMultiplier={CHROME_MAX_SCALE}
            style={styles.disruptionText}>
            Utrudnienie: {disruption.title}
          </ThemedText>
          <Ionicons name="chevron-forward" size={14} color={tokens.textSecondary} />
        </Pressable>
      )}
    </Glass>
  );
}

const styles = StyleSheet.create({
  surface: { borderRadius: Radius.lg, overflow: 'hidden', ...Elevation.floating },
  mainRow: { minHeight: 58, flexDirection: 'row', alignItems: 'stretch' },
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
  eta: { alignItems: 'flex-end', minWidth: 34 },
  divider: { width: StyleSheet.hairlineWidth, marginVertical: Space.sm },
  end: { width: HitTarget, alignItems: 'center', justifyContent: 'center' },
  disruption: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs,
    paddingHorizontal: Space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  disruptionText: { flex: 1, minWidth: 0 },
  pressed: { opacity: Motion.pressedOpacity },
});

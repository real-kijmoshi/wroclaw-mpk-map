import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { LineBadge } from './line-badge';
import { ThemedText } from './themed-text';
import { Motion, Radius, Space } from '@/constants/design';
import { useTheme } from '@/hooks/use-theme';
import { plural } from '@/lib/format';
import type { StopArea } from '@/lib/stops-api';

/** Badges past this are counted rather than wrapped onto a second line. */
const MAX_BADGES = 5;

export type StopAreaRowProps = {
  area: StopArea;
  /** The trailing edge: a distance in the sheet, a chevron in search. */
  trailing?: ReactNode;
  onPress: () => void;
};

/**
 * One stop, wherever a list of stops appears.
 *
 * The sheet's "Blisko Ciebie" and the search results are the same idea — a
 * place, the lines that call there, how many boarding points it has — and used
 * to be two components that drifted: different subtitles, different badge
 * limits, one showing lines and the other not.
 *
 * The lines matter more than they look: Wrocław has two "Rynek" areas 250m
 * apart on opposite sides of the square, and the numbers are the only thing on
 * screen that tells a rider which one they want. They appear as soon as the
 * source carries them, and the row falls back to the boarding-point count when
 * it does not.
 */
export function StopAreaRow({ area, trailing, onPress }: StopAreaRowProps) {
  const theme = useTheme();
  const shown = area.lines.slice(0, MAX_BADGES);
  const rest = area.lines.length - shown.length;

  const platforms =
    area.platforms.length > 1
      ? `${area.platforms.length} ${plural(area.platforms.length, ['stanowisko', 'stanowiska', 'stanowisk'])}`
      : null;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={[`Przystanek ${area.name}`, platforms].filter(Boolean).join(', ')}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      <View style={[styles.mark, { borderColor: theme.accent }]} />

      <View style={styles.text}>
        <ThemedText type="body" numberOfLines={1}>
          {area.name}
        </ThemedText>

        {shown.length > 0 ? (
          <View style={styles.lines}>
            {shown.map((line) => (
              <LineBadge key={line} line={line} size="xs" />
            ))}
            {rest > 0 && (
              <ThemedText type="footnote" themeColor="textSecondary">
                +{rest}
              </ThemedText>
            )}
          </View>
        ) : (
          !!platforms && (
            <ThemedText type="footnote" themeColor="textSecondary" numberOfLines={1}>
              {platforms} · wybierz kierunek
            </ThemedText>
          )
        )}
      </View>

      <View style={styles.trailing}>
        {trailing}
        {shown.length > 0 && !!platforms && (
          <ThemedText type="caption" themeColor="textTertiary">
            {platforms}
          </ThemedText>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.md,
    minHeight: 56,
  },
  mark: { width: 12, height: 12, borderRadius: Radius.pill, borderWidth: 3.5 },
  text: { flex: 1, gap: Space.xs, minWidth: 0 },
  // Left-aligned: a partial last row centred leaves a margin that reads as a
  // layout bug.
  lines: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: Space.xs },
  trailing: { alignItems: 'flex-end', gap: 1 },
  pressed: { opacity: Motion.pressedOpacity },
});

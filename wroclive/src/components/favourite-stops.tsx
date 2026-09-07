import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, StyleSheet, View } from 'react-native';

import { LineBadge } from './line-badge';
import { Divider, Section } from './list';
import { ThemedText } from './themed-text';
import { Motion, Space } from '@/constants/design';
import { useTheme } from '@/hooks/use-theme';
import type { Departure } from '@/lib/api';
import type { FavouriteStop } from '@/lib/favourites';
import { etaParts } from '@/lib/format';

/**
 * The stops a rider pinned, with the minutes they came to read.
 *
 * This sits above "Blisko Ciebie" because it answers a narrower question than
 * proximity does: the nearest stop is a fact about where you are standing, and
 * a favourite is a fact about where you go. For a commuter the second is the
 * one that is true twice a day.
 *
 * The countdown is the only place amber appears in the app (invariant 10), and
 * it earns it here for the same reason it does on the departures sheet: it is
 * the number the rider is deciding on.
 */
export function FavouriteStopsSection({
  stops,
  boards,
  onStop,
}: {
  stops: FavouriteStop[];
  /** Stop id → its next departures. Missing means "not fetched", not "none". */
  boards: Map<string, Departure[]>;
  onStop: (stop: FavouriteStop) => void;
}) {
  const theme = useTheme();
  if (!stops.length) return null;

  return (
    <Section title="Ulubione">
      {stops.map((stop, index) => {
        const departures = boards.get(stop.id);
        return (
          <View key={stop.id}>
            {index > 0 && <Divider />}
            <Pressable
              onPress={() => onStop(stop)}
              accessibilityRole="button"
              accessibilityLabel={stop.name}
              accessibilityHint="Otwiera odjazdy z tego przystanku"
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
              <Ionicons name="star" size={17} color={theme.amber} />

              <View style={styles.text}>
                <ThemedText type="body" numberOfLines={1}>
                  {stop.name}
                </ThemedText>
                {/*
                  * Three states, and they are not the same thing: no board yet
                  * (below the fetch limit, or still loading), a board with
                  * nothing on it (last tram has gone), and departures.
                  */}
                {departures === undefined ? null : departures.length === 0 ? (
                  <ThemedText type="footnote" themeColor="textTertiary" numberOfLines={1}>
                    Brak odjazdów w najbliższej godzinie
                  </ThemedText>
                ) : (
                  <View style={styles.departures}>
                    {departures.slice(0, 2).map((departure) => {
                      const eta = etaParts(
                        departure.realtime && departure.predictedInSeconds !== null
                          ? departure.predictedInSeconds
                          : departure.inSeconds,
                      );
                      return (
                        <View
                          key={`${departure.tripId}-${departure.departure}`}
                          style={styles.departure}>
                          <LineBadge line={departure.line} type={departure.type} size="xs" />
                          <ThemedText type="footnote" weight="semibold" color={theme.amber}>
                            {eta.value}
                          </ThemedText>
                          {!!eta.unit && (
                            <ThemedText type="caption" themeColor="textTertiary">
                              {eta.unit}
                            </ThemedText>
                          )}
                        </View>
                      );
                    })}
                  </View>
                )}
              </View>

              <Ionicons name="chevron-forward" size={16} color={theme.textTertiary} />
            </Pressable>
          </View>
        );
      })}
    </Section>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    minHeight: 52,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.sm,
  },
  text: { flex: 1, gap: 3, minWidth: 0 },
  departures: { flexDirection: 'row', alignItems: 'center', gap: Space.md, flexWrap: 'wrap' },
  departure: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  pressed: { opacity: Motion.pressedOpacity },
});

import Ionicons from '@expo/vector-icons/Ionicons';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { LineBadge } from './line-badge';
import { ThemedText } from './themed-text';
import { Motion, Radius, Space } from '@/constants/design';
import { useTheme } from '@/hooks/use-theme';
import { plural } from '@/lib/format';
import type { StopHub } from '@/lib/stop-hubs';

const MAX_BADGES = 6;

/**
 * A whole interchange, offered above its separate stops (`findHubs()`).
 *
 * Set apart on purpose — a card, not a list row — because it is a different
 * kind of answer: the rows under it are the platforms, this is "all of them",
 * and a rider choosing a trip end or a board for "Galeria Dominikańska" should
 * see that choice before eleven numbered ones.
 */
export function StopHubRow({ hub, trailing, onPress }: { hub: StopHub; trailing?: ReactNode; onPress: () => void }) {
  const theme = useTheme();
  const shown = hub.lines.slice(0, MAX_BADGES);
  const rest = hub.lines.length - shown.length;
  const count = `${hub.stops} ${plural(hub.stops, ['przystanek', 'przystanki', 'przystanków'])}`;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${hub.name}, cały węzeł, ${count}`}
      style={({ pressed }) => [styles.card, { backgroundColor: theme.backgroundElement }, pressed && styles.pressed]}>
      <View style={[styles.icon, { backgroundColor: theme.accent }]}>
        <Ionicons name="git-network-outline" size={17} color="#ffffff" />
      </View>
      <View style={styles.text}>
        <ThemedText type="body" weight="semibold" numberOfLines={1}>
          {hub.name}
        </ThemedText>
        <ThemedText type="footnote" themeColor="textSecondary" numberOfLines={1}>
          Cały węzeł · {count} razem
        </ThemedText>
        {shown.length > 0 && (
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
        )}
      </View>
      {trailing}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    marginHorizontal: Space.md,
    marginVertical: Space.xs,
    paddingHorizontal: Space.md,
    paddingVertical: Space.md,
    borderRadius: Radius.lg,
  },
  icon: { width: 32, height: 32, borderRadius: Radius.pill, alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1, gap: 2, minWidth: 0 },
  lines: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: Space.xs, marginTop: 2 },
  pressed: { opacity: Motion.pressedOpacity },
});

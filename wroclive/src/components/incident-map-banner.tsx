import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, StyleSheet, View } from 'react-native';

import { Glass } from './glass';
import { ThemedText } from './themed-text';
import { Motion, Radius, Space } from '@/constants/design';
import { Colors } from '@/constants/theme';
import { useMapChrome } from '@/hooks/use-map-chrome';
import { plural } from '@/lib/format';

export function IncidentMapBanner({
  title,
  stopCount,
  onOpen,
  onClose,
}: {
  title: string;
  stopCount: number;
  onOpen: () => void;
  onClose: () => void;
}) {
  const { scheme, tokens } = useMapChrome();
  return (
    <Glass variant="chrome" scheme={scheme} style={styles.banner}>
      <Pressable
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={`${title}. ${stopCount} wyróżnionych przystanków`}
        style={({ pressed }) => [styles.main, pressed && styles.pressed]}>
        <View style={[styles.icon, { backgroundColor: Colors[scheme].danger }]}>
          <Ionicons name="warning" size={16} color="#ffffff" />
        </View>
        <View style={styles.copy}>
          <ThemedText type="callout" weight="semibold" color={tokens.text} numberOfLines={1}>
            {title}
          </ThemedText>
          <ThemedText type="caption" color={tokens.textSecondary} numberOfLines={1}>
            {stopCount} {plural(stopCount, ['wyróżniony przystanek', 'wyróżnione przystanki', 'wyróżnionych przystanków'])}
          </ThemedText>
        </View>
      </Pressable>
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Zamknij lokalizację utrudnienia"
        hitSlop={8}
        style={({ pressed }) => [styles.close, pressed && styles.pressed]}>
        <Ionicons name="close" size={18} color={tokens.textSecondary} />
      </Pressable>
    </Glass>
  );
}

const styles = StyleSheet.create({
  banner: {
    minHeight: 60,
    borderRadius: Radius.xl,
    flexDirection: 'row',
    alignItems: 'center',
  },
  main: {
    flex: 1,
    minWidth: 0,
    minHeight: 60,
    paddingHorizontal: Space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
  },
  icon: { width: 32, height: 32, borderRadius: Radius.md, alignItems: 'center', justifyContent: 'center' },
  copy: { flex: 1, minWidth: 0 },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginRight: Space.xs },
  pressed: { opacity: Motion.pressedOpacity },
});

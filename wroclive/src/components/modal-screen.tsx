import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from './themed-text';
import { ThemedView } from './themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type ModalScreenProps = {
  title: string;
  subtitle?: string | null;
  children?: ReactNode;
  /** Rendered next to the title — a "clear filter" action, say. */
  action?: ReactNode;
};

/**
 * The frame every popup shares: a title, whatever action belongs to it, and a
 * way out.
 *
 * The native presentation already gives iOS a grabber and a swipe-down, but a
 * visible close button is the only affordance that works on all three
 * platforms, so it is always there.
 */
export function ModalScreen({ title, subtitle, children, action }: ModalScreenProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const theme = useTheme();

  // At the sheet's smaller detent this is ~0 — the rounded top already
  // clears the status bar. Focusing the search field auto-expands an iOS
  // form sheet to its full detent, which pulls the sheet up over the
  // status bar/notch; `insets.top` picks up the real inset once that
  // happens, so the header stops rendering underneath it.
  const topInset = insets.top + Spacing.two;

  return (
    <ThemedView style={styles.container}>
      <View style={[styles.header, { paddingTop: topInset, borderBottomColor: theme.separator }]}>
        <View style={styles.titleBlock}>
          <ThemedText type="subtitle" numberOfLines={1} style={styles.title}>
            {title}
          </ThemedText>
          {!!subtitle && (
            <ThemedText type="small" themeColor="textSecondary">
              {subtitle}
            </ThemedText>
          )}
        </View>

        {action}

        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Zamknij"
          hitSlop={10}
          style={({ pressed }) => [
            styles.close,
            { backgroundColor: theme.backgroundElement },
            pressed && styles.pressed,
          ]}>
          <Ionicons name="close" size={18} color={theme.textSecondary} />
        </Pressable>
      </View>

      <View style={styles.content}>{children}</View>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.two,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  titleBlock: { flex: 1, gap: 1 },
  title: { fontSize: 26, lineHeight: 34 },
  close: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.6 },
  content: { flex: 1 },
});

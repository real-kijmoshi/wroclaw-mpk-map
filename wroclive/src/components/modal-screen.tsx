import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
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

  // An iOS form sheet is a card inset from the top of the screen: it never
  // reaches the notch, at either detent, so the safe-area inset here is dead
  // space — ~59pt of it on a notched phone, which read as a bug above the
  // title. UIKit already keeps the sheet clear of the status bar; all this
  // needs is enough room for the grabber. Android and web draw the modal
  // full-bleed and do need the real inset.
  const topInset = Platform.OS === 'ios' ? Spacing.four : insets.top + Spacing.two;

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
  /**
   * `minHeight: 0` lets this shrink to the space left over instead of being
   * sized by its content, and `overflow: 'hidden'` clips whatever is inside.
   *
   * Without them a `ScrollView` in here that forgets `flex: 1` takes its full
   * content height, overflows the sheet, and — RN views do not clip on iOS —
   * paints straight over the title. That is what put "MAPA" on top of
   * "Ustawienia" and the line grid on top of the category tabs. The clip is
   * the backstop; every screen below still owns `styles.scroll`.
   */
  content: { flex: 1, minHeight: 0, overflow: 'hidden' },
});

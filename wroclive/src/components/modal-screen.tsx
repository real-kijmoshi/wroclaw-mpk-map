import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  interpolate,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from './themed-text';
import { Motion, Radius, Space } from '@/constants/design';
import { useTheme } from '@/hooks/use-theme';

/** How far the content scrolls before the large title has fully collapsed. */
const COLLAPSE_DISTANCE = 32;

export type ModalScreenProps = {
  title: string;
  subtitle?: string | null;
  /**
   * The screen's content, given the scroll handler that drives the title.
   *
   * A screen with no scroller can ignore it; one with a `ScrollView` or a list
   * spreads it onto the scroller, which is what makes the title collapse.
   */
  children?: ReactNode | ((scroll: ScrollBinding) => ReactNode);
  /** Rendered next to the close button — a "clear filter" action, say. */
  action?: ReactNode;
};

export type ScrollBinding = {
  onScroll: ReturnType<typeof useAnimatedScrollHandler>;
  scrollEventThrottle: number;
  offset: SharedValue<number>;
};

/**
 * The frame every popup shares.
 *
 * A toolbar that always carries the way out, and a large title that lives in
 * the content and hands its job over to the toolbar as the screen scrolls —
 * the platform's own navigation behaviour, which the fixed 26pt header this
 * replaced only approximated.
 *
 * The native presentation already gives iOS a grabber and a swipe-down, but a
 * visible close button is the only affordance that works on all three
 * platforms, so it is always there.
 */
export function ModalScreen({ title, subtitle, children, action }: ModalScreenProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const theme = useTheme();

  const offset = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((event) => {
    offset.value = event.contentOffset.y;
  });

  /**
   * The large title's natural height.
   *
   * It is needed because the block gives its height back as it fades — without
   * that, the collapsed state leaves a dead band under the toolbar that the
   * content scrolls beneath but never fills.
   *
   * It is measured on an *inner* view that never carries the animated height,
   * so the number is always the content's own. Measuring the animated box
   * instead measures the animation's own output, and taking only the first
   * reading to dodge that froze the height before a subtitle that arrives with
   * the data — "Sprawdzono 4 min temu" on the alerts screen — had rendered,
   * which clipped the title in half.
   */
  const [titleHeight, setTitleHeight] = useState(0);

  const compactTitleStyle = useAnimatedStyle(() => ({
    opacity: interpolate(offset.value, [COLLAPSE_DISTANCE * 0.6, COLLAPSE_DISTANCE], [0, 1], 'clamp'),
  }));
  const largeTitleStyle = useAnimatedStyle(() => {
    const progress = interpolate(offset.value, [0, COLLAPSE_DISTANCE], [1, 0], 'clamp');
    return {
      opacity: progress,
      // Before the first measurement the block is left to size itself, so the
      // title is never briefly collapsed to nothing on the first frame.
      ...(titleHeight > 0 ? { height: titleHeight * progress } : null),
    };
  });
  const separatorStyle = useAnimatedStyle(() => ({
    opacity: interpolate(offset.value, [0, COLLAPSE_DISTANCE], [0, 1], 'clamp'),
  }));

  // An iOS form sheet is a card inset from the top of the screen: it never
  // reaches the notch, at either detent, so the safe-area inset here is dead
  // space — ~59pt of it on a notched phone, which read as a bug above the
  // title. UIKit already keeps the sheet clear of the status bar; all this
  // needs is enough room for the grabber. Android and web draw the modal
  // full-bleed and do need the real inset.
  const topInset = Platform.OS === 'ios' ? Space.lg : insets.top + Space.sm;

  return (
    <View style={[styles.container, { backgroundColor: theme.backgroundGrouped }]}>
      <View style={[styles.toolbar, { paddingTop: topInset }]}>
        <Animated.View style={[styles.compactTitle, compactTitleStyle]} pointerEvents="none">
          <ThemedText type="headline" numberOfLines={1}>
            {title}
          </ThemedText>
        </Animated.View>

        <View style={styles.toolbarActions}>
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

        <Animated.View
          pointerEvents="none"
          style={[styles.toolbarSeparator, { backgroundColor: theme.separator }, separatorStyle]}
        />
      </View>

      <Animated.View style={[styles.largeTitle, largeTitleStyle]} pointerEvents="none">
        <View
          onLayout={(event) => {
            const next = Math.round(event.nativeEvent.layout.height);
            if (next > 0) setTitleHeight((current) => (current === next ? current : next));
          }}
          style={styles.largeTitleContent}>
          <ThemedText type="display" numberOfLines={1}>
            {title}
          </ThemedText>
          {!!subtitle && (
            <ThemedText type="footnote" themeColor="textSecondary" numberOfLines={1}>
              {subtitle}
            </ThemedText>
          )}
        </View>
      </Animated.View>

      <View style={styles.content}>
        {typeof children === 'function'
          ? children({ onScroll, scrollEventThrottle: 16, offset })
          : children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  toolbar: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: Space.sm,
    paddingHorizontal: Space.lg,
    paddingBottom: Space.sm,
  },
  /* Centred behind the actions so the title lands where the platform puts it,
     and truncates against the toolbar's own padding rather than the button. */
  compactTitle: {
    position: 'absolute',
    left: 56,
    right: 56,
    bottom: Space.sm,
    alignItems: 'center',
  },
  toolbarActions: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  toolbarSeparator: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
  },
  largeTitle: { overflow: 'hidden' },
  largeTitleContent: { paddingHorizontal: Space.lg, paddingBottom: Space.sm, gap: 1 },
  close: {
    width: 32,
    height: 32,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: Motion.pressedOpacity },
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

import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Platform, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Glass } from './glass';
import { BottomTabInset, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

const SPRING = { damping: 22, stiffness: 220, mass: 0.7 } as const;

/**
 * How much of the screen the sheet covers when fully open.
 *
 * Expressed as a fraction *and* as the constant style below, because the box
 * is sized by the style and the drag maths has to agree with it exactly. It is
 * deliberately not a computed pixel height passed through `style`: an inline
 * `{ height }` object built per render was not re-applied to the element when
 * the measured viewport changed, leaving the sheet stuck at whatever height
 * the very first render produced. A percentage needs no recomputation at all.
 */
const SHEET_FRACTION = 0.86;

export type SheetProps = {
  visible: boolean;
  onClose: () => void;
  children?: ReactNode;
  /** How much of the sheet shows before it is dragged up. */
  peekHeight?: number;
};

/**
 * A draggable sheet over the map.
 *
 * No backdrop on purpose: the map behind it stays visible and usable, which is
 * the point of a map app. It snaps between a peek and (near) full height, and
 * a drag past the peek dismisses it.
 */
export function Sheet({ visible, onClose, children, peekHeight = 300 }: SheetProps) {
  // Not named `window`: shadowing the global inside a component that also runs
  // in a browser is a trap waiting for the next person to edit this file.
  const viewport = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const theme = useTheme();

  /**
   * The height of the area the sheet actually lives in, measured rather than
   * taken from `Dimensions`.
   *
   * On web the two disagree — a zoomed or resized viewport left `Dimensions`
   * reporting 1160 against a real 682, and the sheet was sized from the stale
   * number and hung off the top of the screen. `onLayout` is the size this
   * component was really given, on every platform.
   */
  const [measured, setMeasured] = useState(0);
  const height = measured > 0 ? measured : viewport.height;

  // The native tab bars sit below the screen the sheet lives in; the web one
  // floats over it, so only there does the sheet have to leave room.
  const dockInset = Platform.OS === 'web' ? BottomTabInset : 0;
  // The same fraction the style below uses, so the drag maths and the drawn
  // box cannot disagree.
  const sheetHeight = height * SHEET_FRACTION;
  const peek = Math.min(peekHeight, sheetHeight);
  const collapsedY = sheetHeight - peek;
  const hiddenY = sheetHeight + insets.bottom + Spacing.five;

  const translateY = useSharedValue(hiddenY);
  const startY = useSharedValue(0);

  const close = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
    translateY.value = visible
      ? withSpring(collapsedY, SPRING)
      : withTiming(hiddenY, { duration: 180 });
    // `translateY` is deliberately not a dependency: a shared value is a
    // stable handle, and listing one that the gesture callbacks also write to
    // is what the immutability rule objects to.
  }, [visible, collapsedY, hiddenY]); // eslint-disable-line react-hooks/exhaustive-deps

  /* The immutability rule does not model Reanimated: writing `.value` is the
     whole API of a shared value, and it objects only because the effect above
     drives the same value. Both are correct and intended — the effect places
     the sheet, the gesture takes over while a finger is down. */
  /* eslint-disable react-hooks/immutability */
  const pan = Gesture.Pan()
    .onStart(() => {
      startY.value = translateY.value;
    })
    .onUpdate((event) => {
      const next = startY.value + event.translationY;
      // Resists past the top rather than stopping dead, so the sheet feels
      // attached to the finger.
      translateY.value = next < 0 ? next / 3 : next;
    })
    .onEnd((event) => {
      const projected = translateY.value + event.velocityY * 0.12;

      if (projected > collapsedY + peek * 0.4) {
        translateY.value = withTiming(hiddenY, { duration: 200 }, (finished) => {
          if (finished) runOnJS(close)();
        });
        return;
      }

      const target = projected < collapsedY / 2 ? 0 : collapsedY;
      translateY.value = withSpring(target, SPRING);
    });
  /* eslint-enable react-hooks/immutability */

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  return (
    // Full-bleed and non-interactive: it exists to measure the space the sheet
    // is allowed to use, and to let taps through to the map behind it.
    <View
      pointerEvents="box-none"
      style={styles.measure}
      onLayout={(event) => {
        const next = Math.round(event.nativeEvent.layout.height);
        if (next > 0) setMeasured((current) => (current === next ? current : next));
      }}>
      <Animated.View
        pointerEvents={visible ? 'box-none' : 'none'}
        style={[styles.container, sheetStyle]}>
        <View style={styles.fill}>
          <Glass
            variant="regular"
            style={[styles.sheet, { paddingBottom: insets.bottom + dockInset }]}>
            <GestureDetector gesture={pan}>
              <View style={styles.grabberArea}>
                <View style={[styles.grabber, { backgroundColor: theme.textSecondary }]} />
              </View>
            </GestureDetector>
            <View style={styles.content}>{children}</View>
          </Glass>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  measure: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  container: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    // Part of the static style, not a computed pixel value passed alongside
    // the animated transform: the animated node keeps what it flattens from
    // here, and drops a separate `{ height }` object handed to it per render.
    height: `${SHEET_FRACTION * 100}%`,
  },
  fill: {
    flex: 1,
  },
  sheet: {
    flex: 1,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
  },
  grabberArea: {
    paddingTop: Spacing.two,
    paddingBottom: Spacing.two,
    alignItems: 'center',
  },
  grabber: {
    width: 40,
    height: 5,
    borderRadius: 3,
    opacity: 0.4,
  },
  content: {
    flex: 1,
  },
});

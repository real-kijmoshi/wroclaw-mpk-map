import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Platform, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Glass, liquidGlass } from './glass';
import { Elevation, Motion, Radius, Space } from '@/constants/design';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { useTheme } from '@/hooks/use-theme';
import { settled } from '@/lib/haptics';

export type Detent = 'collapsed' | 'medium' | 'full';

/**
 * How much of the screen the sheet box occupies.
 *
 * Expressed as a fraction *and* as the constant style below, because the box is
 * sized by the style and the drag maths has to agree with it exactly. It is
 * deliberately not a computed pixel height passed through `style`: an inline
 * `{ height }` object built per render was not re-applied to the element when
 * the measured viewport changed, leaving the sheet stuck at whatever height the
 * very first render produced. A percentage needs no recomputation at all.
 */
const SHEET_FRACTION = 0.92;

/** How much of the screen the middle detent shows. */
export const MEDIUM_FRACTION = 0.48;

/**
 * What the collapsed detent shows before the header has been measured.
 *
 * Only the first frame uses it. The real peek is the header's own height, so a
 * rider on a large Dynamic Type size gets a taller collapsed sheet rather than
 * a clipped one — and so a selection header with a two-line direction is not
 * cut off either.
 */
const COLLAPSED_FALLBACK = 112;

export type MapSheetProps = {
  detent: Detent;
  onDetentChange: (detent: Detent) => void;
  /**
   * Called when the sheet is dragged down below its collapsed detent.
   *
   * The sheet itself never leaves the screen — this is how a rider puts a
   * selected vehicle or stop away and gets the home content back.
   */
  onDismiss?: () => void;
  /**
   * Whether the sheet is on screen at all.
   *
   * `true` for the sheet layout, always — that layout's whole point is a
   * surface the map is never left without. The classic layout passes `false`
   * while nothing is selected, because there it is the selection's sheet and
   * the top bar carries what the header would. It slides off rather than
   * unmounting, so a vehicle tapped straight after one was put away travels
   * back up instead of appearing mid-screen.
   */
  presented?: boolean;
  /** Always on screen: the search field and status, or a selection's summary. */
  header: ReactNode;
  /** Revealed from the middle detent up. */
  children?: ReactNode;
  /**
   * How much of the sheet is currently on screen, in points.
   *
   * The map controls ride on this so they sit just above the sheet's top edge
   * at every detent and through every drag, instead of being positioned with
   * the hardcoded per-selection offsets this replaced.
   */
  visibleHeight: SharedValue<number>;
};

/**
 * The sheet that is the app.
 *
 * The map used to carry a HUD card at the top, a stack of floating buttons on
 * the right, and a separate sheet that only appeared once something was
 * selected — three surfaces competing for the same map. This is one: search and
 * live status at rest, the home list a drag away, and the selected vehicle or
 * stop in the same box. It is never dismissed, so the map is never a bare
 * screen with chrome scattered over it.
 *
 * No backdrop, on purpose: the map behind it stays visible and usable, which is
 * the point of a map app.
 */
export function MapSheet({
  detent,
  onDetentChange,
  onDismiss,
  presented = true,
  header,
  children,
  visibleHeight,
}: MapSheetProps) {
  // Not named `window`: shadowing the global inside a component that also runs
  // in a browser is a trap waiting for the next person to edit this file.
  const viewport = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const reducedMotion = useReducedMotion();

  /**
   * The height this component was really given, measured rather than taken
   * from `Dimensions`.
   *
   * On web the two disagree — a zoomed or resized viewport left `Dimensions`
   * reporting 1160 against a real 682, and the sheet was sized from the stale
   * number and hung off the top of the screen.
   */
  const [measured, setMeasured] = useState(0);
  const height = measured > 0 ? measured : viewport.height;

  /** The header's real height, so the collapsed detent always fits its content. */
  const [headerHeight, setHeaderHeight] = useState(0);

  const sheetHeight = height * SHEET_FRACTION;
  const peek = Math.min(
    (headerHeight > 0 ? headerHeight : COLLAPSED_FALLBACK) + insets.bottom,
    sheetHeight,
  );
  const mediumPeek = Math.min(Math.max(height * MEDIUM_FRACTION, peek), sheetHeight);

  // Offsets from the top of the sheet box: 0 is fully open, `sheetHeight` is
  // entirely below the screen.
  const offsets = {
    full: 0,
    medium: sheetHeight - mediumPeek,
    collapsed: sheetHeight - peek,
  };
  const resting = presented ? offsets[detent] : sheetHeight;

  const translateY = useSharedValue(resting);
  const startY = useSharedValue(0);

  const settle = useCallback(
    (next: Detent) => {
      settled();
      onDetentChange(next);
    },
    [onDetentChange],
  );
  const dismiss = useCallback(() => onDismiss?.(), [onDismiss]);

  /**
   * How the sheet travels.
   *
   * A spring overshoots its target and settles back, which is exactly the
   * motion Reduce Motion exists to remove — so that setting gets a short linear
   * slide instead. Both are worklets, so the gesture handlers can call this
   * from the UI thread.
   */
  const glide = (to: number) => {
    'worklet';
    return reducedMotion ? withTiming(to, Motion.reduced) : withSpring(to, Motion.spring);
  };

  useEffect(() => {
    translateY.value = glide(resting);
    // `translateY` is deliberately not a dependency: a shared value is a stable
    // handle, and listing one that the gesture callbacks also write to is what
    // the immutability rule objects to.
  }, [resting, reducedMotion]); // eslint-disable-line react-hooks/exhaustive-deps

  /* The immutability rule does not model Reanimated: writing `.value` is the
     whole API of a shared value, and it objects only because the effect above
     drives the same one. Both are correct and intended — the effect places the
     sheet, the gesture takes over while a finger is down. */
  /* eslint-disable react-hooks/immutability */

  /**
   * Publish how much of the sheet is on screen, every frame.
   *
   * Derived rather than written at the end of a gesture: the detent also
   * changes programmatically — selecting a vehicle snaps the sheet to its
   * middle detent — and a value only written by the pan handler stayed at the
   * collapsed height through that spring, which left the map controls anchored
   * where the sheet used to be and then covered by it.
   */
  useDerivedValue(() => {
    visibleHeight.value = sheetHeight - translateY.value;
  }, [sheetHeight]);

  const pan = Gesture.Pan()
    // A sheet that is off screen has nothing to drag, and the classic layout
    // leaves it there for most of a session.
    .enabled(presented)
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

      // Dragged down past the collapsed detent: put whatever is open away and
      // stay put. The sheet has no dismissed state to fall into.
      if (projected > offsets.collapsed + peek * 0.35) {
        translateY.value = glide(offsets.collapsed);
        runOnJS(dismiss)();
        runOnJS(settle)('collapsed');
        return;
      }

      const nearest = (['full', 'medium', 'collapsed'] as const).reduce((best, name) =>
        Math.abs(offsets[name] - projected) < Math.abs(offsets[best] - projected) ? name : best,
      );

      translateY.value = glide(offsets[nearest]);
      runOnJS(settle)(nearest);
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
      {/* A sheet parked below the screen is still in the tree, and a screen
          reader would happily read the departure board on it. Hidden from the
          accessibility tree as well as from touch, or the classic layout has an
          invisible sheet VoiceOver can walk into. */}
      <Animated.View
        pointerEvents={presented ? 'box-none' : 'none'}
        accessibilityElementsHidden={!presented}
        importantForAccessibility={presented ? 'auto' : 'no-hide-descendants'}
        style={[styles.container, sheetStyle]}>
        <SheetSurface>
          <GestureDetector gesture={pan}>
            <View
              style={styles.headerArea}
              onLayout={(event) => {
                const next = Math.round(event.nativeEvent.layout.height);
                if (next > 0) setHeaderHeight((current) => (current === next ? current : next));
              }}>
              <View style={[styles.grabber, { backgroundColor: theme.textTertiary }]} />
              {header}
            </View>
          </GestureDetector>

          <View style={[styles.body, { paddingBottom: insets.bottom }]}>{children}</View>
        </SheetSurface>
      </Animated.View>
    </View>
  );
}

/**
 * The sheet's material.
 *
 * iOS gets the real translucent surface — it is what the platform's own sheets
 * are made of, and on iOS 26 that is liquid glass. Android and the web get an
 * opaque panel instead: blurring a moving map underneath a full-height scroller
 * costs more there than the effect is worth.
 */
function SheetSurface({ children }: { children: ReactNode }) {
  const theme = useTheme();

  if (Platform.OS === 'ios' || liquidGlass) {
    return (
      <Glass variant="panel" style={styles.surface}>
        {children}
      </Glass>
    );
  }

  return (
    <View
      style={[
        styles.surface,
        { backgroundColor: theme.backgroundGrouped, borderColor: theme.separator },
      ]}>
      {children}
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
    // Part of the static style, not a computed pixel value passed alongside the
    // animated transform: the animated node keeps what it flattens from here,
    // and drops a separate `{ height }` object handed to it per render.
    height: `${SHEET_FRACTION * 100}%`,
  },
  surface: {
    flex: 1,
    borderTopLeftRadius: Radius.xxl,
    borderTopRightRadius: Radius.xxl,
    borderWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: 0,
    overflow: 'hidden',
    ...Elevation.sheet,
  },
  headerArea: { paddingTop: Space.sm, paddingHorizontal: Space.lg },
  grabber: {
    width: 36,
    height: 5,
    borderRadius: Radius.pill,
    opacity: 0.4,
    alignSelf: 'center',
    marginBottom: Space.sm,
  },
  body: { flex: 1, minHeight: 0 },
});

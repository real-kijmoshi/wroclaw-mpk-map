import { useEffect, useRef } from "react";
import {
  Animated,
  Modal,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import {
  GestureHandlerRootView,
  PanGestureHandler,
  State,
} from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { color, radius, space } from "../theme";

const DISMISS_DISTANCE = 100;
const DISMISS_VELOCITY = 1000;

/**
 * Note on `PanGestureHandler`: it is deprecated in favour of `Gesture.Pan()`,
 * but the replacement only runs on the UI thread with react-native-reanimated
 * installed, which this app does not have. Moving over now would turn a
 * natively driven drag into a JS-driven one — a downgrade. Migrate together
 * with reanimated, not before.
 */
export default function SwipeableModal({
  visible,
  onClose,
  children,
  modalHeight,
  closeOnBackdropPress = true,
}) {
  // Read live rather than once at import: the module-scope `Dimensions.get()`
  // this used to use is captured before the window is laid out, and never
  // updates.
  const { height: screenHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  // Never taller than the screen minus the notch, whatever a caller asks for.
  const sheetHeight = Math.min(
    modalHeight ?? screenHeight * 0.75,
    screenHeight - insets.top - space.xl,
  );

  // sheetY is the open/close animation; dragY tracks the finger. Keeping them
  // separate means a drag can be clamped without fighting the open animation.
  const sheetY = useRef(new Animated.Value(screenHeight)).current;
  const dragY = useRef(new Animated.Value(0)).current;
  const backdrop = useRef(new Animated.Value(0)).current;

  // Downward drags move the sheet; upward drags are ignored so it cannot be
  // pulled off the top of the screen.
  const clampedDrag = dragY.interpolate({
    inputRange: [-1, 0, 1],
    outputRange: [0, 0, 1],
  });
  const translateY = Animated.add(sheetY, clampedDrag);

  useEffect(() => {
    if (!visible) return;
    dragY.setValue(0);
    sheetY.setValue(screenHeight);
    backdrop.setValue(0);
    Animated.parallel([
      Animated.spring(sheetY, {
        toValue: 0,
        useNativeDriver: true,
        damping: 20,
        stiffness: 180,
        mass: 0.6,
      }),
      // The backdrop used to snap to full black on the frame the modal
      // mounted, ahead of the sheet it belongs to.
      Animated.timing(backdrop, { toValue: 1, duration: 180, useNativeDriver: true }),
    ]).start();
  }, [visible, screenHeight, sheetY, dragY, backdrop]);

  const dismiss = () => {
    Animated.parallel([
      Animated.timing(sheetY, {
        toValue: screenHeight,
        duration: 200,
        useNativeDriver: true,
      }),
      Animated.timing(backdrop, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start(({ finished }) => {
      if (!finished) return;
      dragY.setValue(0);
      onClose?.();
    });
  };

  const onGestureEvent = Animated.event([{ nativeEvent: { translationY: dragY } }], {
    useNativeDriver: true,
  });

  const onHandlerStateChange = ({ nativeEvent }) => {
    if (nativeEvent.state !== State.END && nativeEvent.state !== State.CANCELLED) return;

    const { translationY, velocityY } = nativeEvent;
    if (translationY > DISMISS_DISTANCE || velocityY > DISMISS_VELOCITY) {
      // Fold the drag into the sheet position so the close animation starts
      // from where the finger left it instead of jumping.
      dragY.setValue(0);
      sheetY.setValue(Math.max(0, translationY));
      dismiss();
      return;
    }

    Animated.spring(dragY, {
      toValue: 0,
      useNativeDriver: true,
      damping: 20,
      stiffness: 200,
    }).start();
  };

  if (!visible) return null;

  return (
    <Modal
      transparent
      visible={visible}
      animationType="none"
      onRequestClose={dismiss}
      statusBarTranslucent
    >
      <GestureHandlerRootView style={styles.root}>
        <View style={styles.overlay}>
          <Animated.View style={[styles.scrim, { opacity: backdrop }]} pointerEvents="none" />
          <Pressable
            style={styles.backdrop}
            onPress={closeOnBackdropPress ? dismiss : undefined}
            accessibilityLabel="Zamknij"
          />

          <PanGestureHandler
            onGestureEvent={onGestureEvent}
            onHandlerStateChange={onHandlerStateChange}
            activeOffsetY={10}
          >
            <Animated.View
              style={[
                styles.sheet,
                {
                  height: sheetHeight,
                  // The home indicator ate the last row of every list; this was
                  // a flat 30/20pt guess by platform.
                  paddingBottom: Math.max(insets.bottom, space.lg),
                  transform: [{ translateY }],
                },
              ]}
            >
              <View style={styles.handleArea}>
                <View style={styles.handle} />
              </View>
              {children}
            </Animated.View>
          </PanGestureHandler>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  overlay: { flex: 1, justifyContent: "flex-end" },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0, 0, 0, 0.5)" },
  backdrop: { ...StyleSheet.absoluteFillObject },
  sheet: {
    backgroundColor: color.paper,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: space.lg,
  },
  handleArea: { alignItems: "center", paddingVertical: space.sm + 2 },
  handle: {
    width: 44,
    height: 5,
    backgroundColor: color.paperLine,
    borderRadius: 2.5,
  },
});

import { useEffect, useRef } from "react";
import {
  Animated,
  Dimensions,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import {
  GestureHandlerRootView,
  PanGestureHandler,
  State,
} from "react-native-gesture-handler";

import { COLORS } from "../theme";

const { height: SCREEN_HEIGHT } = Dimensions.get("window");
const DEFAULT_MODAL_HEIGHT = SCREEN_HEIGHT * 0.75;
const DISMISS_DISTANCE = 100;
const DISMISS_VELOCITY = 1000;

export default function SwipeableModal({
  visible,
  onClose,
  children,
  modalHeight = DEFAULT_MODAL_HEIGHT,
  closeOnBackdropPress = true,
}) {
  // sheetY is the open/close animation; dragY tracks the finger. Keeping them
  // separate means a drag can be clamped without fighting the open animation.
  const sheetY = useRef(new Animated.Value(SCREEN_HEIGHT)).current;
  const dragY = useRef(new Animated.Value(0)).current;

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
    sheetY.setValue(SCREEN_HEIGHT);
    Animated.spring(sheetY, {
      toValue: 0,
      useNativeDriver: true,
      damping: 20,
      stiffness: 180,
      mass: 0.6,
    }).start();
  }, [visible, sheetY, dragY]);

  const dismiss = () => {
    Animated.timing(sheetY, {
      toValue: SCREEN_HEIGHT,
      duration: 200,
      useNativeDriver: true,
    }).start(({ finished }) => {
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
              style={[styles.sheet, { height: modalHeight, transform: [{ translateY }] }]}
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
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    justifyContent: "flex-end",
  },
  backdrop: { ...StyleSheet.absoluteFillObject },
  sheet: {
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 20,
    paddingBottom: Platform.OS === "ios" ? 30 : 20,
  },
  handleArea: { alignItems: "center", paddingVertical: 10 },
  handle: {
    width: 44,
    height: 5,
    backgroundColor: "rgba(255,255,255,0.35)",
    borderRadius: 2.5,
  },
});

import { useEffect, useRef } from "react";
import {
  Animated,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  GestureHandlerRootView,
  PanGestureHandler,
  State,
} from "react-native-gesture-handler";

import PressableScale from "./PressableScale";
import { color, hairline, layout, radius, shadow, space, spring, type } from "../theme";

const DISMISS_DISTANCE = 100;
const DISMISS_VELOCITY = 1000;

/**
 * The iOS sheet.
 *
 * Two things it does that the previous version did not:
 *
 * The size comes from `useWindowDimensions`, not from a `Dimensions.get` read
 * at import time. That read happens once, so the sheet kept the height of
 * whatever the window was when the bundle loaded — wrong after a rotation, and
 * wrong for the entire session in a resized browser window.
 *
 * The drag lives on the grabber and the header, not on the whole sheet. When
 * the pan handler wrapped everything, a flick inside the list either scrolled
 * or dismissed depending on which handler won, so scrolling a long line list
 * would sometimes throw the sheet off the screen instead. Owning the header
 * here is also what keeps the three sheets looking like the same object.
 */
export default function SwipeableModal({
  visible,
  onClose,
  children,
  title,
  subtitle,
  actionLabel = "Gotowe",
  onAction,
  secondaryAction,
  background = "paper",
  detent = 0.9,
  closeOnBackdropPress = true,
}) {
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  // iOS never lets a sheet reach the top edge; the gap is what says there is a
  // screen behind it.
  const topGap = Math.max(insets.top, space.xl) + space.md;
  const sheetHeight = Math.min(windowHeight * detent, windowHeight - topGap);

  // sheetY is the open/close animation; dragY tracks the finger. Keeping them
  // separate means a drag can be clamped without fighting the open animation.
  const sheetY = useRef(new Animated.Value(windowHeight)).current;
  const dragY = useRef(new Animated.Value(0)).current;

  // Downward drags move the sheet; upward drags are ignored so it cannot be
  // pulled off the top of the screen.
  const clampedDrag = dragY.interpolate({
    inputRange: [-1, 0, 1],
    outputRange: [0, 0, 1],
  });
  const translateY = Animated.add(sheetY, clampedDrag);

  // The backdrop tracks the sheet, so a drag that is released halfway does not
  // leave a fully dark screen behind a half-open sheet.
  const backdropOpacity = translateY.interpolate({
    inputRange: [0, Math.max(sheetHeight, 1)],
    outputRange: [1, 0],
    extrapolate: "clamp",
  });

  useEffect(() => {
    if (!visible) return;
    dragY.setValue(0);
    sheetY.setValue(sheetHeight);
    Animated.spring(sheetY, {
      toValue: 0,
      useNativeDriver: true,
      ...spring.sheet,
    }).start();
  }, [visible, sheetY, dragY, sheetHeight]);

  const dismiss = () => {
    Animated.timing(sheetY, {
      toValue: sheetHeight,
      duration: 220,
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

    Animated.spring(dragY, { toValue: 0, useNativeDriver: true, ...spring.settle }).start();
  };

  if (!visible) return null;

  const wide = windowWidth > layout.maxContentWidth + 2 * space.lg;

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
          <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]}>
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={closeOnBackdropPress ? dismiss : undefined}
              accessibilityLabel="Zamknij"
            />
          </Animated.View>

          <KeyboardAvoidingView
            style={styles.keyboard}
            behavior={Platform.OS === "ios" ? "padding" : undefined}
            pointerEvents="box-none"
          >
            <Animated.View
              style={[
                styles.sheet,
                wide && styles.sheetWide,
                {
                  height: sheetHeight,
                  backgroundColor: background === "grouped" ? color.paperMuted : color.paper,
                  paddingBottom: Math.max(insets.bottom, space.lg),
                  transform: [{ translateY }],
                },
              ]}
            >
              <PanGestureHandler
                onGestureEvent={onGestureEvent}
                onHandlerStateChange={onHandlerStateChange}
                activeOffsetY={10}
              >
                <View style={styles.grabArea}>
                  <View style={styles.grabber} />
                  {(title || onAction || secondaryAction) && (
                    <View style={styles.header}>
                      <View style={styles.headerText}>
                        {title ? (
                          <Text style={styles.title} numberOfLines={1}>
                            {title}
                          </Text>
                        ) : null}
                        {subtitle ? (
                          <Text style={styles.subtitle} numberOfLines={1}>
                            {subtitle}
                          </Text>
                        ) : null}
                      </View>

                      <View style={styles.headerActions}>
                        {secondaryAction && (
                          <PressableScale
                            style={styles.headerButton}
                            onPress={secondaryAction.onPress}
                            accessibilityRole="button"
                          >
                            <Text
                              style={[
                                styles.headerButtonText,
                                secondaryAction.destructive && styles.headerButtonDestructive,
                              ]}
                            >
                              {secondaryAction.label}
                            </Text>
                          </PressableScale>
                        )}
                        <PressableScale
                          style={styles.headerButton}
                          onPress={onAction ?? dismiss}
                          accessibilityRole="button"
                        >
                          <Text style={[styles.headerButtonText, styles.headerButtonPrimary]}>
                            {actionLabel}
                          </Text>
                        </PressableScale>
                      </View>
                    </View>
                  )}
                </View>
              </PanGestureHandler>

              <View style={styles.content}>{children}</View>
            </Animated.View>
          </KeyboardAvoidingView>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  overlay: { flex: 1, justifyContent: "flex-end" },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: color.scrim },
  keyboard: { flex: 1, justifyContent: "flex-end" },
  sheet: {
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    overflow: "hidden",
    ...shadow.sheet,
  },
  // On a desktop-sized window the sheet stops being full-bleed and becomes a
  // centred card, which is what iPadOS does with the same component.
  sheetWide: {
    width: layout.maxContentWidth,
    alignSelf: "center",
    borderBottomLeftRadius: radius.sheet,
    borderBottomRightRadius: radius.sheet,
    marginBottom: space.lg,
  },
  grabArea: { paddingBottom: space.sm },
  grabber: {
    width: 36,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: color.fillStrong,
    alignSelf: "center",
    marginTop: space.sm,
    marginBottom: space.sm,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
  },
  headerText: { flex: 1 },
  title: { ...type.title, color: color.text },
  subtitle: { ...type.footnote, color: color.textMuted, marginTop: 1 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: space.xs },
  headerButton: {
    minHeight: 36,
    justifyContent: "center",
    paddingHorizontal: space.sm,
    borderRadius: radius.control,
  },
  headerButtonText: { ...type.headline, color: color.textMuted },
  headerButtonPrimary: { color: color.rail },
  headerButtonDestructive: { color: color.destructive },
  content: { flex: 1, borderTopWidth: hairline, borderTopColor: color.separator },
});

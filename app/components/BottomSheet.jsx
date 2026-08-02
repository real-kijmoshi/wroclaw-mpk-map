import { useEffect, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { PanGestureHandler, State } from "react-native-gesture-handler";

import { color, hairline, layout, radius, shadow, space, spring } from "../theme";

const HIDDEN_OFFSET = 480;
const DISMISS_DISTANCE = 80;
const DISMISS_VELOCITY = 800;

/**
 * The dark board that slides up over the map.
 *
 * Two of these exist now — the departures at a stop and the stops ahead of a
 * vehicle — and they are the same object seen from either end of the same
 * question, so they share one presentation: the grabber, the spring, the
 * drag-down-to-dismiss, and the clearance above the floating tab bar
 * (`bottomOffset`, never a hardcoded number).
 *
 * Only the header is draggable. The content below it scrolls, and a pan
 * handler wrapped around both would eat the scroll.
 */
export default function BottomSheet({
  header,
  children,
  onClose,
  bottomOffset = 0,
  maxHeight = 360,
}) {
  const slide = useRef(new Animated.Value(1)).current;
  const drag = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(slide, { toValue: 0, useNativeDriver: true, ...spring.settle }).start();
  }, [slide]);

  const onGestureEvent = Animated.event([{ nativeEvent: { translationY: drag } }], {
    useNativeDriver: true,
  });

  const onHandlerStateChange = ({ nativeEvent }) => {
    if (nativeEvent.state !== State.END && nativeEvent.state !== State.CANCELLED) return;

    const { translationY, velocityY } = nativeEvent;
    if (translationY > DISMISS_DISTANCE || velocityY > DISMISS_VELOCITY) {
      drag.setValue(0);
      onClose?.();
      return;
    }
    Animated.spring(drag, { toValue: 0, useNativeDriver: true, ...spring.settle }).start();
  };

  // Downward drags follow the finger; upward ones are ignored so the board
  // cannot be dragged up over the map.
  const clampedDrag = drag.interpolate({ inputRange: [-1, 0, 1], outputRange: [0, 0, 1] });
  const translateY = Animated.add(
    slide.interpolate({ inputRange: [0, 1], outputRange: [0, HIDDEN_OFFSET] }),
    clampedDrag,
  );

  return (
    <View style={[styles.wrapper, { bottom: bottomOffset }]} pointerEvents="box-none">
      <Animated.View style={[styles.sheet, { maxHeight, transform: [{ translateY }] }]}>
        <PanGestureHandler
          onGestureEvent={onGestureEvent}
          onHandlerStateChange={onHandlerStateChange}
          activeOffsetY={10}
        >
          <View>
            <View style={styles.grabber} />
            {header}
          </View>
        </PanGestureHandler>

        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: "absolute",
    left: space.md,
    right: space.md,
    alignItems: "center",
  },
  sheet: {
    width: "100%",
    maxWidth: layout.maxContentWidth,
    backgroundColor: color.ink,
    borderRadius: radius.sheet - space.sm,
    paddingBottom: space.sm,
    overflow: "hidden",
    borderWidth: hairline,
    borderColor: color.hairlineOnDark,
    ...shadow.float,
  },
  grabber: {
    width: 36,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: "rgba(255, 255, 255, 0.22)",
    alignSelf: "center",
    marginTop: space.sm,
  },
});

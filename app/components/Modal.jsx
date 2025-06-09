import React, { useEffect, useRef } from "react";
import {
  Modal,
  StyleSheet,
  View,
  TouchableOpacity,
  Dimensions,
  Platform,
  Animated,
} from "react-native";
import {
  PanGestureHandler,
  GestureHandlerRootView,
  State,
} from "react-native-gesture-handler";

const { height } = Dimensions.get("window");
const DEFAULT_MODAL_HEIGHT = height * 0.75;

export default function SwipeableModal({
  visible,
  onClose,
  children,
  modalHeight = DEFAULT_MODAL_HEIGHT,
  closeOnBackdropPress = true,
}) {
  const translateY = useRef(new Animated.Value(height)).current;

  useEffect(() => {
    if (visible) {
      Animated.timing(translateY, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }).start();
    } else {
      Animated.timing(translateY, {
        toValue: height,
        duration: 300,
        useNativeDriver: true,
      }).start();
    }
  }, [visible]);

  const onGestureEvent = Animated.event(
    [{ nativeEvent: { translationY: translateY } }],
    { useNativeDriver: true }
  );

  const onHandlerStateChange = (event) => {
    if (event.nativeEvent.state === State.END) {
      const { translationY, velocityY } = event.nativeEvent;
      if (translationY > 100 || velocityY > 1000) {
        Animated.timing(translateY, {
          toValue: height,
          duration: 200,
          useNativeDriver: true,
        }).start(() => {
          onClose();
          translateY.setValue(height);
        });
      } else {
        Animated.timing(translateY, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }).start();
      }
    }
  };

  if (!visible) return null;

  return (
    <Modal transparent visible={visible} animationType="none">
      <View style={styles.overlay}>
        {closeOnBackdropPress && (
          <TouchableOpacity
            style={styles.overlayTouchable}
            activeOpacity={1}
            onPress={() => {
              Animated.timing(translateY, {
                toValue: height,
                duration: 200,
                useNativeDriver: true,
              }).start(() => {
                onClose();
                translateY.setValue(height);
              });
            }}
          />
        )}
        <GestureHandlerRootView style={{ flex: 1, justifyContent: "flex-end" }}>
          <PanGestureHandler
            onGestureEvent={onGestureEvent}
            onHandlerStateChange={onHandlerStateChange}
          >
            <Animated.View
              style={[
                styles.container,
                { height: modalHeight, transform: [{ translateY }] },
              ]}
            >
              {/* Handle bar */}
              <View style={styles.handleContainer}>
                <View style={styles.handle} />
              </View>

              {/* Modal content */}
              {children}
            </Animated.View>
          </PanGestureHandler>
        </GestureHandlerRootView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    justifyContent: "flex-end",
  },
  overlayTouchable: {
    flex: 1,
  },
  container: {
    backgroundColor: "#121212",
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    paddingHorizontal: 20,
    paddingBottom: Platform.OS === "ios" ? 30 : 20,
  },
  handleContainer: {
    alignItems: "center",
    paddingVertical: 8,
  },
  handle: {
    width: 40,
    height: 5,
    backgroundColor: "#ccc",
    borderRadius: 2.5,
  },
});

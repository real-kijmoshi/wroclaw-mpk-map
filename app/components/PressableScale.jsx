import { useRef } from "react";
import { Animated, Pressable } from "react-native";
import * as Haptics from "expo-haptics";

import { spring } from "../theme";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const FEEDBACK = {
  selection: () => Haptics.selectionAsync(),
  light: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
  medium: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium),
};

/**
 * Fires a haptic and swallows anything the platform has to say about it.
 *
 * expo-haptics ships a web implementation too (Vibration API, and a hidden
 * switch element on iOS Safari, which has no vibrate), so this is not
 * native-only — on a phone the browser build gets the same tick as the app.
 * Where there is no hardware for it, it quietly does nothing.
 */
export function haptic(kind = "selection") {
  try {
    FEEDBACK[kind]?.()?.catch?.(() => {});
  } catch {
    // Feedback is a nicety; never let it take a tap down with it.
  }
}

/**
 * The touch response iOS uses for anything that is not a list row: the control
 * shrinks under the finger and springs back. Opacity alone reads as a web
 * button, and `TouchableOpacity`'s linear fade reads as an Android one.
 */
export default function PressableScale({
  children,
  style,
  scale = 0.96,
  feedback = "selection",
  onPress,
  disabled,
  ...rest
}) {
  const value = useRef(new Animated.Value(1)).current;

  const animate = (toValue) =>
    Animated.spring(value, { toValue, useNativeDriver: true, ...spring.press }).start();

  return (
    <AnimatedPressable
      {...rest}
      disabled={disabled}
      onPressIn={() => !disabled && animate(scale)}
      onPressOut={() => animate(1)}
      onPress={(event) => {
        if (disabled) return;
        if (feedback) haptic(feedback);
        onPress?.(event);
      }}
      style={[style, { transform: [{ scale: value }] }]}
    >
      {children}
    </AnimatedPressable>
  );
}

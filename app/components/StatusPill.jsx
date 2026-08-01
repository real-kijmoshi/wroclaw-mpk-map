import { useEffect, useRef, useState } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { ChevronDown } from "lucide-react-native";

import Material from "./Material";
import PressableScale from "./PressableScale";
import { color, font, radius, shadow, space, type } from "../theme";

/**
 * Replaces the old info box, which showed a wall clock and the raw feed
 * timestamp — both things the phone already tells you, neither of which
 * answers a question you would actually ask.
 *
 * This says the one thing worth knowing: is what you are looking at live, and
 * how much of the city is on screen. It is a translucent capsule rather than a
 * solid card because it sits on top of a moving map and should read as glass
 * over it, not as a hole punched in it.
 */
export default function StatusPill({ lastUpdated, vehicleCount, lineCount, onPress }) {
  const [now, setNow] = useState(() => Date.now());
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  const age = lastUpdated ? Math.round((now - lastUpdated) / 1000) : null;
  const stale = age != null && age > 45;
  const live = age != null && !stale;

  // A slow breath on the dot, which is the difference between "this is live"
  // and "this is a screenshot". It stops when the feed goes stale, so the
  // stillness itself carries the warning.
  useEffect(() => {
    if (!live) {
      pulse.setValue(1);
      return undefined;
    }

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.35, duration: 900, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [live, pulse]);

  let label;
  if (age == null) label = "Łączenie…";
  else if (stale) label = `Brak odświeżenia od ${Math.round(age / 60) || 1} min`;
  else label = `${vehicleCount} w ruchu · ${lineCount} ${plural(lineCount)}`;

  return (
    <PressableScale
      onPress={onPress}
      scale={0.97}
      accessibilityRole="button"
      accessibilityLabel={`${label}. Dotknij, aby wybrać linie.`}
    >
      <Material style={styles.pill}>
        <Animated.View
          style={[
            styles.dot,
            { opacity: live ? pulse : 1 },
            { backgroundColor: age == null ? color.textMuted : stale ? color.stale : color.live },
          ]}
        />
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
        <View style={styles.chevron}>
          <ChevronDown size={14} color={color.textMuted} strokeWidth={2.5} />
        </View>
      </Material>
    </PressableScale>
  );
}

/** Polish counts take three forms: 1 linia, 2-4 linie, 5+ linii. */
function plural(count) {
  if (count === 1) return "linia";
  const last = count % 10;
  const teen = count % 100 >= 12 && count % 100 <= 14;
  return !teen && last >= 2 && last <= 4 ? "linie" : "linii";
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    height: 40,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255, 255, 255, 0.55)",
    ...shadow.chip,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  label: { ...type.body, fontFamily: font.dataMedium, fontSize: 15, color: color.text },
  chevron: { marginLeft: -space.xs, opacity: 0.8 },
});

import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { color, font, radius, shadow, space, type } from "../theme";

/**
 * Replaces the old info box, which showed a wall clock and the raw feed
 * timestamp — both things the phone already tells you, neither of which
 * answers a question you would actually ask.
 *
 * This says the one thing worth knowing: is what you are looking at live, and
 * how much of the city is on screen.
 */
export default function StatusPill({ lastUpdated, vehicleCount, lineCount, onPress, style }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  const age = lastUpdated ? Math.round((now - lastUpdated) / 1000) : null;
  const stale = age != null && age > 45;

  let label;
  if (age == null) label = "Łączenie…";
  else if (stale) label = `Brak odświeżenia od ${Math.round(age / 60) || 1} min`;
  else label = `${vehicleCount} w ruchu · ${lineCount} ${plural(lineCount)}`;

  return (
    <Pressable
      style={[styles.pill, style]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View
        style={[
          styles.dot,
          { backgroundColor: age == null ? color.textMuted : stale ? color.stale : color.live },
        ]}
      />
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
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
    position: "absolute",
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    backgroundColor: color.paper,
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    ...shadow.chip,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  label: { ...type.small, fontFamily: font.dataMedium, fontSize: 15, color: color.text },
});

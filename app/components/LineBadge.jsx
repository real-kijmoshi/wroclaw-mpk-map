import { memo } from "react";
import { StyleSheet, Text, View } from "react-native";

import { colorForType, font, radius } from "../theme";

/**
 * The line number, set the way it appears on a vehicle's destination blind:
 * condensed, heavy, tight. Used everywhere a line is referenced so the number
 * always looks like the same object.
 */
export default memo(function LineBadge({ line, type, size = "md", style }) {
  const metrics = SIZES[size] ?? SIZES.md;

  return (
    <View
      style={[
        styles.badge,
        { backgroundColor: colorForType(type), minWidth: metrics.box, height: metrics.box },
        style,
      ]}
    >
      <Text
        style={[styles.text, { fontSize: metrics.font }]}
        numberOfLines={1}
        allowFontScaling={false}
      >
        {line}
      </Text>
    </View>
  );
});

const SIZES = {
  sm: { box: 24, font: 14 },
  md: { box: 32, font: 18 },
  lg: { box: 40, font: 23 },
};

const styles = StyleSheet.create({
  badge: {
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 5,
  },
  text: {
    fontFamily: font.data,
    color: "#fff",
    includeFontPadding: false,
    textAlign: "center",
  },
});

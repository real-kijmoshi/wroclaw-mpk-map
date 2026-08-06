import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { colorFor } from '@/lib/lines';

export type LineBadgeProps = {
  line: string;
  type?: string | null;
  size?: 'small' | 'medium' | 'large';
  style?: StyleProp<ViewStyle>;
};

/**
 * The line number, in its category colour.
 *
 * Every colour in the palette clears 4.5:1 against this white text — it is the
 * one thing on screen a rider reads at a glance in daylight. One shape for
 * every category, matching the markers on the map.
 */
export function LineBadge({ line, type, size = 'medium', style }: LineBadgeProps) {
  const backgroundColor = colorFor(type);
  const metrics = SIZES[size];

  return (
    <View
      style={[
        styles.badge,
        {
          backgroundColor,
          minWidth: metrics.box,
          height: metrics.box,
          borderRadius: metrics.box * 0.28,
          paddingHorizontal: metrics.padding,
        },
        style,
      ]}>
      <Text
        numberOfLines={1}
        allowFontScaling={false}
        style={[styles.label, { fontSize: line.length > 3 ? metrics.font - 2 : metrics.font }]}>
        {line}
      </Text>
    </View>
  );
}

const SIZES = {
  small: { box: 26, font: 13, padding: 6 },
  medium: { box: 34, font: 16, padding: 8 },
  large: { box: 44, font: 20, padding: 10 },
} as const;

const styles = StyleSheet.create({
  badge: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    color: '#ffffff',
    fontWeight: '800',
    letterSpacing: -0.3,
    // Digits line up when badges stack in a column, the way they do on the map.
    fontVariant: ['tabular-nums'],
  },
});

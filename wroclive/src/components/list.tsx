import Ionicons from '@expo/vector-icons/Ionicons';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { ThemedText } from './themed-text';
import { Motion, Radius, Space } from '@/constants/design';
import { withAlpha } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { tapped } from '@/lib/haptics';

/**
 * The grouped list, shared.
 *
 * These lived as private components inside `settings.tsx` while `alerts.tsx`,
 * `lines.tsx` and `search.tsx` each hand-rolled their own row with slightly
 * different padding and a slightly different divider. One row height, one
 * divider inset, one card radius — that consistency is most of what makes a
 * screen look designed rather than assembled.
 */

/** A titled group of rows on a card. */
export function Section({
  title,
  footer,
  children,
  style,
}: {
  title?: string;
  /** Quiet explanatory text under the card. */
  footer?: string;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();

  return (
    <View style={[styles.section, style]}>
      {!!title && (
        <ThemedText type="footnote" weight="semibold" themeColor="textSecondary" style={styles.sectionTitle}>
          {title.toLocaleUpperCase('pl')}
        </ThemedText>
      )}
      <View style={[styles.card, { backgroundColor: theme.backgroundCard }]}>{children}</View>
      {!!footer && (
        <ThemedText type="footnote" themeColor="textSecondary" style={styles.sectionFooter}>
          {footer}
        </ThemedText>
      )}
    </View>
  );
}

export type RowProps = {
  label: string;
  hint?: string | null;
  /** Rendered at the trailing edge — a switch, a value, a chevron. */
  accessory?: ReactNode;
  /** Rendered at the leading edge — an icon in a tinted tile. */
  leading?: ReactNode;
};

/** One line of a section. Static unless wrapped in `Choice` or `LinkRow`. */
export function Row({ label, hint, accessory, leading }: RowProps) {
  return (
    <View style={styles.row}>
      {leading}
      <View style={styles.rowText}>
        <ThemedText type="body" numberOfLines={1}>
          {label}
        </ThemedText>
        {!!hint && (
          <ThemedText type="footnote" themeColor="textSecondary" numberOfLines={2}>
            {hint}
          </ThemedText>
        )}
      </View>
      {accessory}
    </View>
  );
}

/** A row that picks one of several options. */
export function Choice({
  label,
  hint,
  selected,
  onPress,
}: RowProps & { selected: boolean; onPress: () => void }) {
  const theme = useTheme();

  return (
    <Pressable
      onPress={() => {
        tapped();
        onPress();
      }}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      style={({ pressed }) => [pressed && styles.pressed]}>
      <Row
        label={label}
        hint={hint}
        accessory={
          selected ? (
            <Ionicons name="checkmark" size={20} color={theme.accent} />
          ) : (
            <View style={styles.accessorySpacer} />
          )
        }
      />
    </Pressable>
  );
}

/** A row that opens something else. */
export function LinkRow({
  label,
  hint,
  leading,
  value,
  onPress,
}: RowProps & { value?: string | null; onPress: () => void }) {
  const theme = useTheme();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [pressed && styles.pressed]}>
      <Row
        label={label}
        hint={hint}
        leading={leading}
        accessory={
          <View style={styles.linkAccessory}>
            {!!value && (
              <ThemedText type="callout" themeColor="textSecondary" numberOfLines={1}>
                {value}
              </ThemedText>
            )}
            <Ionicons name="chevron-forward" size={16} color={theme.textTertiary} />
          </View>
        }
      />
    </Pressable>
  );
}

/**
 * The hairline between rows.
 *
 * Inset to the text column, the way the platform's own lists are: a divider
 * that runs the full width reads as the edge of a card, not as a separator
 * between two things inside one.
 */
export function Divider({ inset = true }: { inset?: boolean }) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.divider,
        { backgroundColor: theme.separator },
        inset && styles.dividerInset,
      ]}
    />
  );
}

/**
 * An icon in a rounded tile, for the leading edge of a `LinkRow`.
 *
 * The glyph is drawn in the tile's own colour on a tint of it, not in white on
 * a solid fill — see `withAlpha`. White only ever worked in light mode.
 */
export function RowIcon({
  name,
  color,
}: {
  name: keyof typeof Ionicons.glyphMap;
  color: string;
}) {
  return (
    <View style={[styles.rowIcon, { backgroundColor: withAlpha(color, 0.16) }]}>
      <Ionicons name={name} size={18} color={color} />
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: Space.sm },
  sectionTitle: { letterSpacing: 0.5, paddingHorizontal: Space.lg },
  sectionFooter: { paddingHorizontal: Space.lg },
  card: { borderRadius: Radius.lg, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.md,
    minHeight: 52,
  },
  rowText: { flex: 1, gap: 1, minWidth: 0 },
  linkAccessory: { flexDirection: 'row', alignItems: 'center', gap: Space.xs, flexShrink: 1 },
  accessorySpacer: { width: 20 },
  divider: { height: StyleSheet.hairlineWidth },
  dividerInset: { marginLeft: Space.lg },
  rowIcon: {
    width: 30,
    height: 30,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: Motion.pressedOpacity },
});

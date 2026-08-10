import { StyleSheet, Text, type TextProps } from 'react-native';

import { Fonts, type ThemeColor } from '@/constants/theme';
import { Type, Weight, type TypeStep, type WeightName } from '@/constants/design';
import { useTheme } from '@/hooks/use-theme';

export type ThemedTextProps = TextProps & {
  /** A step of the ramp in `design.ts`. Defaults to running text. */
  type?: TypeStep | 'mono';
  /**
   * Weight is its own axis.
   *
   * It used to be folded into the name — `smallBold` beside `small` — which
   * doubled the ramp and still left no way to bold a caption. Each step has a
   * sensible default weight; this overrides it.
   */
  weight?: WeightName;
  /** Any colour in the palette. Defaults to the primary text colour. */
  themeColor?: ThemeColor;
  /** Overrides `themeColor` — for the accent, or a line colour. */
  color?: string;
};

/**
 * How far text is allowed to grow inside a box that cannot.
 *
 * Content scales without limit — that is the point of Dynamic Type. Chrome
 * with a fixed height (the sheet's status line, a map control) caps out, so
 * the largest accessibility sizes clip a glyph instead of pushing the whole
 * layout apart. Pass it explicitly; nothing gets it by default.
 */
export const CHROME_MAX_SCALE = 1.4;

/**
 * Text, on the ramp.
 *
 * Every size in the app comes from `Type`; a component that needs a size the
 * ramp does not have needs a ramp step, not an inline `fontSize`.
 */
export function ThemedText({
  style,
  type = 'body',
  weight,
  themeColor,
  color,
  ...rest
}: ThemedTextProps) {
  const theme = useTheme();
  const step = type === 'mono' ? Type.footnote : Type[type];

  return (
    <Text
      style={[
        step,
        { fontWeight: Weight[weight ?? DEFAULT_WEIGHT[type]] },
        { color: color ?? theme[themeColor ?? 'text'] },
        type === 'mono' && styles.mono,
        style,
      ]}
      {...rest}
    />
  );
}

/**
 * What each step weighs when nothing says otherwise.
 *
 * Headlines and titles carry their emphasis in the weight, so they do not need
 * a caller to remember it; body text stays regular so a paragraph does not
 * shout. `medium` rather than `regular` for the small steps because they are
 * usually read at a glance, outdoors, at arm's length.
 */
const DEFAULT_WEIGHT: Record<TypeStep | 'mono', WeightName> = {
  display: 'bold',
  title: 'bold',
  headline: 'semibold',
  body: 'regular',
  callout: 'regular',
  subhead: 'medium',
  footnote: 'medium',
  caption: 'semibold',
  mono: 'medium',
};

const styles = StyleSheet.create({
  mono: { fontFamily: Fonts.mono },
});

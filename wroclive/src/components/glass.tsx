import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import type { ReactNode } from 'react';
import { Platform, StyleSheet, type ViewStyle, type StyleProp } from 'react-native';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { useTheme } from '@/hooks/use-theme';

/** True when the OS can draw real liquid glass (iOS 26 and up). */
export const liquidGlass = isLiquidGlassAvailable();

export type GlassProps = {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** `clear` for surfaces floating over the map, `regular` for panels holding text. */
  variant?: 'clear' | 'regular';
  /** Liquid glass reacts to touch; only worth it on things that are pressed. */
  interactive?: boolean;
};

/**
 * One translucent surface, drawn the best way the platform allows.
 *
 * iOS 26 gets the real thing. Everything older — and Android, and the web —
 * gets a blur of the same shape, then a plain translucent fill where even that
 * is unavailable. The layout is identical in all three, so nothing shifts.
 */
export function Glass({ children, style, variant = 'regular', interactive = false }: GlassProps) {
  const theme = useTheme();
  const scheme = useColorScheme();
  const flattened = StyleSheet.flatten(style) ?? {};

  if (liquidGlass) {
    return (
      <GlassView
        glassEffectStyle={variant}
        isInteractive={interactive}
        style={[styles.base, style]}>
        {children}
      </GlassView>
    );
  }

  // `experimentalBlurMethod` is what makes the blur real on Android rather than
  // a flat overlay; without it the surface reads as a grey box.
  return (
    <BlurView
      intensity={variant === 'clear' ? 40 : 70}
      tint={scheme === 'dark' ? 'systemThickMaterialDark' : 'systemThickMaterialLight'}
      experimentalBlurMethod={Platform.OS === 'android' ? 'dimezisBlurView' : undefined}
      style={[
        styles.base,
        // The blur alone is not opaque enough to hold small text over a moving
        // map, so it sits on a tinted fill.
        { backgroundColor: theme.glass, borderColor: theme.glassBorder, borderWidth: StyleSheet.hairlineWidth },
        style,
        { overflow: 'hidden' },
        flattened.backgroundColor ? { backgroundColor: flattened.backgroundColor } : null,
      ]}>
      {children}
    </BlurView>
  );
}

const styles = StyleSheet.create({
  base: {
    overflow: 'hidden',
  },
});

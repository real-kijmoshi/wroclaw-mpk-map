import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import type { ReactNode } from 'react';
import { Platform, StyleSheet, type ViewStyle, type StyleProp } from 'react-native';

import { MapChrome } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useTheme } from '@/hooks/use-theme';

/** True when the OS can draw real liquid glass (iOS 26 and up). */
export const liquidGlass = isLiquidGlassAvailable();

/**
 * What the surface is for, which is what decides how solid it has to be.
 *
 * There is deliberately no transparent variant. The previous `clear` one is
 * what made the map HUD unreadable: over hybrid tiles its secondary text sat
 * far below 4.5:1 and the control icons disappeared into the imagery
 * altogether. A surface that holds text holds it on every base map or it is not
 * a surface.
 */
export type GlassVariant =
  /** Floats over the map and carries text — the sheet header, a status pill. */
  | 'chrome'
  /** A round map button. Reacts to touch where the OS can. */
  | 'control'
  /** Inside a sheet or modal, where an opaque background is already behind it. */
  | 'panel';

export type GlassProps = {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  variant?: GlassVariant;
  /**
   * Forces the material's light or dark form.
   *
   * Map chrome passes what `useMapChrome()` decided, because the base map — not
   * the phone's colour scheme — is what the surface has to survive.
   */
  scheme?: 'light' | 'dark';
};

/**
 * One translucent surface, drawn the best way the platform allows.
 *
 * iOS 26 gets the real thing. Everything older — and Android, and the web —
 * gets a blur of the same shape over a tinted fill. The layout is identical in
 * all three, so nothing shifts between them.
 */
export function Glass({ children, style, variant = 'panel', scheme }: GlassProps) {
  const theme = useTheme();
  const appScheme = useColorScheme();
  const resolved = scheme ?? (appScheme === 'dark' ? 'dark' : 'light');
  const flattened = StyleSheet.flatten(style) ?? {};

  if (liquidGlass) {
    return (
      <GlassView
        glassEffectStyle="regular"
        isInteractive={variant === 'control'}
        tintColor={variant === 'panel' ? undefined : MapChrome[resolved].glassTint}
        style={[styles.base, style]}>
        {children}
      </GlassView>
    );
  }

  const fill = variant === 'panel' ? theme.glass : MapChrome[resolved].surface;
  const border = variant === 'panel' ? theme.glassBorder : MapChrome[resolved].border;

  // `experimentalBlurMethod` is what makes the blur real on Android rather than
  // a flat overlay; without it the surface reads as a grey box.
  return (
    <BlurView
      intensity={variant === 'panel' ? 60 : 40}
      tint={resolved === 'dark' ? 'systemThickMaterialDark' : 'systemThickMaterialLight'}
      experimentalBlurMethod={Platform.OS === 'android' ? 'dimezisBlurView' : undefined}
      style={[
        styles.base,
        // The blur alone is not opaque enough to hold small text over a moving
        // map, so it always sits on a tinted fill.
        { backgroundColor: fill, borderColor: border, borderWidth: StyleSheet.hairlineWidth },
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

/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

import '@/global.css';

import { Platform } from 'react-native';

export const Colors = {
  light: {
    text: '#000000',
    background: '#ffffff',
    backgroundElement: '#F0F0F3',
    backgroundSelected: '#E0E1E6',
    textSecondary: '#60646C',
    /**
     * Reserved for departure countdowns, and nothing else. It is the one loud
     * colour in the app and it works because nothing competes with it — if you
     * need emphasis somewhere else, use weight or spacing.
     */
    amber: '#9A5B00',
    separator: 'rgba(60,60,67,0.16)',
    danger: '#C0392B',
    success: '#15803D',
    /** What a glass surface falls back to where liquid glass is unavailable. */
    glass: 'rgba(255,255,255,0.82)',
    glassBorder: 'rgba(255,255,255,0.7)',
    scrim: 'rgba(0,0,0,0.35)',
  },
  dark: {
    text: '#ffffff',
    background: '#000000',
    backgroundElement: '#212225',
    backgroundSelected: '#2E3135',
    textSecondary: '#B0B4BA',
    amber: '#FFB020',
    separator: 'rgba(84,84,88,0.5)',
    danger: '#FF6B5E',
    success: '#3DDC84',
    glass: 'rgba(28,28,30,0.78)',
    glassBorder: 'rgba(255,255,255,0.12)',
    scrim: 'rgba(0,0,0,0.5)',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

/**
 * How much room the tab bar takes at the bottom of a screen.
 *
 * The web build draws its own floating bar over the content, so anything that
 * sits at the bottom there — a scroll list's last row, the sheet — has to
 * leave room for it or it ends up underneath.
 */
export const BottomTabInset = Platform.select({ ios: 50, android: 80, web: 72 }) ?? 0;
export const MaxContentWidth = 800;

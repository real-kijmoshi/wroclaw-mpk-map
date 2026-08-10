import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from './themed-text';
import { Motion, Radius, Space } from '@/constants/design';
import { useTheme } from '@/hooks/use-theme';

export type ErrorScreenProps = {
  error: Error;
  /** Remounts the route. Provided by expo-router's boundary. */
  retry: () => Promise<void>;
};

/**
 * What a rider sees if the app throws where nothing caught it.
 *
 * Without this a render error is a white screen in a release build — no
 * explanation and no way out but force-quitting. A boundary cannot know what
 * broke, so it does not pretend to: it says the app hit a problem, offers the
 * one action that ever helps, and shows the message underneath for anyone
 * reporting it.
 *
 * Deliberately plain. It has to render even if the thing that broke was the
 * theme, the fonts or the map, so it uses nothing but tokens and system text.
 */
export function ErrorScreen({ error, retry }: ErrorScreenProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + Space.huge, paddingBottom: insets.bottom + Space.xl },
        ]}>
        <Ionicons name="warning" size={40} color={theme.danger} />

        <ThemedText type="title" style={styles.title}>
          Coś poszło nie tak
        </ThemedText>
        <ThemedText type="callout" themeColor="textSecondary" style={styles.body}>
          Aplikacja napotkała nieoczekiwany błąd. Spróbuj wczytać ją ponownie — mapa i rozkłady
          powinny wrócić.
        </ThemedText>

        <Pressable
          onPress={() => {
            retry().catch(() => {
              // The boundary owns the remount; if even that fails there is
              // nothing left for this screen to do about it.
            });
          }}
          accessibilityRole="button"
          accessibilityLabel="Wczytaj ponownie"
          style={({ pressed }) => [
            styles.action,
            { backgroundColor: theme.text },
            pressed && styles.pressed,
          ]}>
          <ThemedText type="callout" weight="semibold" color={theme.background}>
            Wczytaj ponownie
          </ThemedText>
        </Pressable>

        {!!error?.message && (
          <View style={[styles.details, { backgroundColor: theme.backgroundElement }]}>
            <ThemedText type="mono" themeColor="textSecondary" selectable>
              {error.message}
            </ThemedText>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  // Grows to fill the screen so the message sits in the middle of it rather
  // than stranded at the top of an empty page, but still scrolls if a long
  // error message makes it taller than the viewport.
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: Space.xl,
    alignItems: 'center',
    gap: Space.md,
  },
  title: { textAlign: 'center' },
  body: { textAlign: 'center', maxWidth: 320 },
  action: {
    minHeight: 48,
    marginTop: Space.sm,
    borderRadius: Radius.md,
    paddingHorizontal: Space.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  details: {
    alignSelf: 'stretch',
    marginTop: Space.lg,
    borderRadius: Radius.md,
    padding: Space.md,
  },
  pressed: { opacity: Motion.pressedOpacity },
});

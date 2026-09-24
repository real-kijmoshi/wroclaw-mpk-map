import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Divider, LinkRow, RowIcon, Section } from '@/components/list';
import { ModalScreen } from '@/components/modal-screen';
import { ThemedText } from '@/components/themed-text';
import { Motion, Radius, Space, Type } from '@/constants/design';
import { useTheme } from '@/hooks/use-theme';
import {
  favouriteStopsStore,
  MAX_FAVOURITE_STOPS,
  MAX_LABEL_LENGTH,
  useFavouriteStops,
  type FavouriteStop,
} from '@/lib/favourite-stops';
import { tapped } from '@/lib/haptics';
import { mapIntentStore } from '@/lib/map-intent';

/**
 * The starred stops, managed: named, ordered, removed — and put on a widget.
 *
 * Starring happens where a stop is (its sheet), but a list that can only grow
 * by accident and shrink by finding each stop again on the map is not one a
 * rider keeps tidy. The order matters more than it looks: it is the order of
 * "Ulubione" on the sheet, of the long-press menu on the app icon, and the
 * stop an unconfigured widget falls back to. A name ("Dom", "Praca") is what
 * the widget and the list lead with, over the stop's own.
 */
export default function FavouritesScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const favourites = useFavouriteStops();
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <ModalScreen
      title="Ulubione przystanki"
      subtitle={
        favourites.length ? `${favourites.length} z ${MAX_FAVOURITE_STOPS}` : 'Twoje przystanki pod ręką'
      }>
      {(scroll) => (
        <Animated.ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Space.xxl }]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          onScroll={scroll.onScroll}
          scrollEventThrottle={scroll.scrollEventThrottle}>
          {favourites.length === 0 ? (
            <View style={[styles.empty, { backgroundColor: theme.backgroundCard }]}>
              <View style={[styles.emptyIcon, { backgroundColor: theme.backgroundElement }]}>
                <Ionicons name="star-outline" size={24} color={theme.text} />
              </View>
              <ThemedText type="headline">Brak ulubionych</ThemedText>
              <ThemedText type="footnote" themeColor="textSecondary" style={styles.emptyText}>
                Otwórz przystanek na mapie i dotknij gwiazdki. Jego odjazdy pojawią się na mapie od razu po
                otwarciu aplikacji{Platform.OS === 'ios' ? ' i na widżecie' : ''}.
              </ThemedText>
            </View>
          ) : (
            <Section
              title="Kolejność i nazwy"
              icon="star-outline"
              footer="Pierwszy przystanek pokazuje się na górze listy i na widżecie, dopóki nie wybierzesz innego.">
              {favourites.map((stop, index) => (
                <View key={stop.id}>
                  {index > 0 && <Divider />}
                  <FavouriteEditorRow
                    stop={stop}
                    first={index === 0}
                    last={index === favourites.length - 1}
                    editing={editing === stop.id}
                    onEdit={() => setEditing(editing === stop.id ? null : stop.id)}
                    onOpen={() => {
                      mapIntentStore.openStop(stop);
                      router.dismissAll();
                    }}
                  />
                </View>
              ))}
            </Section>
          )}

          <Section>
            <LinkRow
              label="Znajdź przystanek"
              hint="Otwórz go i oznacz gwiazdką"
              leading={<RowIcon name="search" color={theme.accent} />}
              onPress={() => router.push('/search')}
            />
          </Section>

          {Platform.OS === 'ios' && <WidgetHowTo />}
        </Animated.ScrollView>
      )}
    </ModalScreen>
  );
}

function FavouriteEditorRow({
  stop,
  first,
  last,
  editing,
  onEdit,
  onOpen,
}: {
  stop: FavouriteStop;
  first: boolean;
  last: boolean;
  editing: boolean;
  onEdit: () => void;
  onOpen: () => void;
}) {
  const theme = useTheme();
  const [draft, setDraft] = useState(stop.label ?? '');

  const save = () => {
    favouriteStopsStore.rename(stop.id, draft);
    onEdit();
  };

  return (
    <View>
      <View style={styles.row}>
        <Pressable
          onPress={onOpen}
          accessibilityRole="button"
          accessibilityLabel={[stop.label, stop.name].filter(Boolean).join(', ')}
          accessibilityHint="Pokazuje przystanek na mapie"
          style={({ pressed }) => [styles.rowMain, pressed && styles.pressed]}>
          <Ionicons name="star" size={16} color={theme.textSecondary} />
          <View style={styles.rowText}>
            <ThemedText type="body" numberOfLines={1}>
              {stop.label || stop.name}
            </ThemedText>
            <ThemedText type="footnote" themeColor="textSecondary" numberOfLines={1}>
              {stop.label ? stop.name : 'Bez własnej nazwy'}
            </ThemedText>
          </View>
        </Pressable>
        <IconButton
          icon="chevron-up"
          label={`Przesuń wyżej: ${stop.label || stop.name}`}
          disabled={first}
          onPress={() => favouriteStopsStore.move(stop.id, -1)}
        />
        <IconButton
          icon="chevron-down"
          label={`Przesuń niżej: ${stop.label || stop.name}`}
          disabled={last}
          onPress={() => favouriteStopsStore.move(stop.id, 1)}
        />
        <IconButton
          icon={editing ? 'close' : 'create-outline'}
          label={editing ? 'Zamknij edycję' : `Edytuj: ${stop.label || stop.name}`}
          onPress={() => {
            setDraft(stop.label ?? '');
            onEdit();
          }}
        />
      </View>

      {editing && (
        <View style={styles.editor}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={`Własna nazwa, np. Dom`}
            placeholderTextColor={theme.textTertiary}
            maxLength={MAX_LABEL_LENGTH}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={save}
            accessibilityLabel={`Własna nazwa przystanku ${stop.name}`}
            style={[styles.input, { color: theme.text, backgroundColor: theme.backgroundElement }]}
          />
          <View style={styles.editorActions}>
            <Pressable
              onPress={() => {
                tapped();
                favouriteStopsStore.remove(stop.id);
              }}
              accessibilityRole="button"
              accessibilityLabel={`Usuń z ulubionych: ${stop.name}`}
              hitSlop={8}
              style={({ pressed }) => [styles.editorAction, pressed && styles.pressed]}>
              <Ionicons name="trash-outline" size={16} color={theme.danger} />
              <ThemedText type="footnote" weight="semibold" color={theme.danger}>
                Usuń z ulubionych
              </ThemedText>
            </Pressable>
            <Pressable
              onPress={save}
              accessibilityRole="button"
              accessibilityLabel="Zapisz nazwę"
              hitSlop={8}
              style={({ pressed }) => [
                styles.saveButton,
                { backgroundColor: theme.accent },
                pressed && styles.pressed,
              ]}>
              <ThemedText type="footnote" weight="semibold" color="#ffffff">
                Zapisz
              </ThemedText>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

function IconButton({
  icon,
  label,
  disabled,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={() => {
        tapped();
        onPress();
      }}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      hitSlop={4}
      style={({ pressed }) => [
        styles.iconButton,
        { backgroundColor: theme.backgroundElement },
        disabled && styles.disabled,
        pressed && styles.pressed,
      ]}>
      <Ionicons name={icon} size={17} color={theme.textSecondary} />
    </Pressable>
  );
}

/**
 * How to put a stop on a widget. The choice lives on the widget itself — iOS
 * offers no way for an app to place or configure one — so the most the app
 * can do is say, in three steps, where to find it.
 */
function WidgetHowTo() {
  const theme = useTheme();
  const steps = [
    'Przytrzymaj puste miejsce na ekranie głównym lub blokady i dotknij „Edytuj” → „Dodaj widżet”.',
    'Wybierz Wroclive i rozmiar — mały pokazuje najbliższy odjazd, duży osiem kolejnych.',
    'Przytrzymaj dodany widżet, wybierz „Edytuj widżet” i w polu „Przystanek” wskaż, który z ulubionych ma pokazywać.',
  ];
  return (
    <Section
      title="Widżety"
      icon="apps-outline"
      footer="Każdy widżet może pokazywać inny przystanek. Odjazdy odświeżają się, gdy otwierasz aplikację, i co jakiś czas w tle.">
      {steps.map((step, index) => (
        <View key={step}>
          {index > 0 && <Divider />}
          <View style={styles.step}>
            <View style={[styles.stepNumber, { backgroundColor: theme.backgroundElement }]}>
              <ThemedText type="footnote" weight="bold">
                {index + 1}
              </ThemedText>
            </View>
            <ThemedText type="callout" style={styles.stepText}>
              {step}
            </ThemedText>
          </View>
        </View>
      ))}
    </Section>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { paddingHorizontal: Space.lg, paddingTop: Space.sm, gap: Space.xl },
  empty: { borderRadius: Radius.lg, padding: Space.xl, alignItems: 'center', gap: Space.xs },
  emptyIcon: {
    width: 48,
    height: 48,
    borderRadius: Radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Space.xs,
  },
  emptyText: { textAlign: 'center', maxWidth: 300 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs,
    paddingRight: Space.md,
    minHeight: 60,
  },
  rowMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    paddingLeft: Space.lg,
    paddingVertical: Space.sm,
    minWidth: 0,
  },
  rowText: { flex: 1, gap: 1, minWidth: 0 },
  iconButton: { width: 32, height: 32, borderRadius: Radius.pill, alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.3 },
  editor: { paddingHorizontal: Space.lg, paddingBottom: Space.md, gap: Space.sm },
  input: {
    ...Type.body,
    minHeight: 44,
    borderRadius: Radius.md,
    paddingHorizontal: Space.md,
    paddingVertical: Space.sm,
  },
  editorActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  editorAction: { flexDirection: 'row', alignItems: 'center', gap: Space.xs, minHeight: 36 },
  saveButton: {
    minHeight: 36,
    paddingHorizontal: Space.lg,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: Space.md, padding: Space.lg },
  stepNumber: { width: 24, height: 24, borderRadius: Radius.pill, alignItems: 'center', justifyContent: 'center' },
  stepText: { flex: 1 },
  pressed: { opacity: Motion.pressedOpacity },
});

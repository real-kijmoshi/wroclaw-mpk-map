import Ionicons from '@expo/vector-icons/Ionicons';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LineBadge } from '@/components/line-badge';
import { ModalScreen } from '@/components/modal-screen';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { usePoll } from '@/hooks/use-poll';
import { useTheme } from '@/hooks/use-theme';
import { getLines, type LineType } from '@/lib/api';
import { plural } from '@/lib/format';
import { CATEGORY_ORDER, compareLines, HIDDEN_CATEGORIES, labelFor } from '@/lib/lines';
import { selectionStore, useSelectedLines } from '@/lib/selection';

/**
 * Which lines the map draws.
 *
 * Nothing selected means everything is shown — the map is useful before anyone
 * has made a choice here.
 */
export default function LinesScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const selected = useSelectedLines();
  const [query, setQuery] = useState('');

  // The timetable changes about as often as the city publishes a new snapshot,
  // so this is fetched rather than polled.
  const lines = usePoll((signal) => getLines({ signal }), 15 * 60_000);

  const categories = useMemo(() => {
    if (!lines.data) return [];
    const needle = query.trim().toUpperCase();

    const known = new Set(CATEGORY_ORDER);
    const order = [
      ...CATEGORY_ORDER,
      ...Object.keys(lines.data).filter((key) => !known.has(key as LineType)),
    ];

    return order
      .filter((category) => !HIDDEN_CATEGORIES.has(category))
      .map((category) => ({
        category,
        label: labelFor(category),
        lines: (lines.data?.[category] ?? [])
          .filter((line) => !needle || line.toUpperCase().includes(needle))
          .sort(compareLines),
      }))
      .filter((group) => group.lines.length > 0);
  }, [lines.data, query]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  return (
    <ModalScreen
      title="Linie"
      subtitle={
        selected.length === 0
          ? 'Mapa pokazuje wszystkie linie'
          : `Mapa pokazuje ${selected.length} ${plural(selected.length, [
              'wybraną linię',
              'wybrane linie',
              'wybranych linii',
            ])}`
      }
      action={
        selected.length > 0 ? (
          <Pressable onPress={() => selectionStore.clear()} accessibilityRole="button" hitSlop={8}>
            <ThemedText type="smallBold" themeColor="textSecondary">
              Wyczyść
            </ThemedText>
          </Pressable>
        ) : null
      }>
      <View style={styles.searchRow}>
        <View style={[styles.search, { backgroundColor: theme.backgroundElement }]}>
          <Ionicons name="search" size={16} color={theme.textSecondary} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Numer linii"
            placeholderTextColor={theme.textSecondary}
            style={[styles.searchInput, { color: theme.text }]}
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="search"
            inputMode="search"
          />
          {query.length > 0 && (
            <Pressable onPress={() => setQuery('')} accessibilityLabel="Wyczyść wyszukiwanie">
              <Ionicons name="close-circle" size={17} color={theme.textSecondary} />
            </Pressable>
          )}
        </View>
      </View>

      {lines.loading && !lines.data ? (
        <View style={styles.centered}>
          <ActivityIndicator />
          <ThemedText type="small" themeColor="textSecondary">
            Wczytywanie rozkładu…
          </ThemedText>
        </View>
      ) : lines.error && !lines.data ? (
        <View style={styles.centered}>
          <ThemedText themeColor="textSecondary">Nie udało się pobrać listy linii</ThemedText>
          <Pressable onPress={lines.refresh} accessibilityRole="button">
            <ThemedText type="linkPrimary">Spróbuj ponownie</ThemedText>
          </Pressable>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.five }]}
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}>
          {categories.length === 0 ? (
            <ThemedText themeColor="textSecondary" style={styles.empty}>
              Brak linii pasujących do „{query}”.
            </ThemedText>
          ) : (
            categories.map((group) => {
              const all = group.lines.every((line) => selectedSet.has(line));
              return (
                <View key={group.category} style={styles.group}>
                  <View style={styles.groupHeader}>
                    <ThemedText type="smallBold">{group.label}</ThemedText>
                    <Pressable
                      accessibilityRole="button"
                      hitSlop={8}
                      onPress={() => {
                        const next = new Set(selected);
                        for (const line of group.lines) {
                          if (all) next.delete(line);
                          else next.add(line);
                        }
                        selectionStore.set([...next]);
                      }}>
                      <ThemedText type="small" themeColor="textSecondary">
                        {all ? 'Odznacz' : 'Zaznacz'}
                      </ThemedText>
                    </Pressable>
                  </View>

                  <View style={styles.badges}>
                    {group.lines.map((line) => {
                      const isSelected = selectedSet.has(line);
                      return (
                        <Pressable
                          key={line}
                          onPress={() => selectionStore.toggle(line)}
                          accessibilityRole="checkbox"
                          accessibilityState={{ checked: isSelected }}
                          accessibilityLabel={`Linia ${line}`}
                          style={({ pressed }) => [pressed && styles.pressed]}>
                          <View
                            style={[
                              styles.badgeWrap,
                              isSelected && { borderColor: theme.text, borderWidth: 2 },
                            ]}>
                            <LineBadge line={line} type={group.category} size="medium" />
                          </View>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              );
            })
          )}
        </ScrollView>
      )}
    </ModalScreen>
  );
}

const styles = StyleSheet.create({
  searchRow: { paddingHorizontal: Spacing.three, paddingTop: Spacing.two },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    height: 40,
    borderRadius: 12,
  },
  searchInput: { flex: 1, fontSize: 16, paddingVertical: 0 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.two },
  content: { paddingHorizontal: Spacing.three, gap: Spacing.four, paddingTop: Spacing.three },
  empty: { paddingVertical: Spacing.four },
  group: { gap: Spacing.two },
  groupHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  badgeWrap: {
    padding: 2,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  pressed: { opacity: 0.6 },
});

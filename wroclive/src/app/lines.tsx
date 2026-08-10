import Ionicons from '@expo/vector-icons/Ionicons';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ModalScreen } from '@/components/modal-screen';
import { ThemedText } from '@/components/themed-text';
import { HitTarget, Motion, Radius, Space, Type, Weight } from '@/constants/design';
import { usePoll } from '@/hooks/use-poll';
import { useTheme } from '@/hooks/use-theme';
import { getLines, type LineType } from '@/lib/api';
import { plural } from '@/lib/format';
import {
  CATEGORY_ORDER,
  colorFor,
  compareLines,
  HIDDEN_CATEGORIES,
  labelFor,
} from '@/lib/lines';
import { selectionStore, useSelectedLines } from '@/lib/selection';

type PickerTab = 'all' | 'tram' | 'bus' | 'night' | 'other';

const TABS: { id: PickerTab; label: string }[] = [
  { id: 'all', label: 'Wszystkie' },
  { id: 'tram', label: 'Tramwaje' },
  { id: 'bus', label: 'Autobusy' },
  { id: 'night', label: 'Nocne' },
  { id: 'other', label: 'Inne' },
];

const categoryInTab = (category: string, tab: PickerTab) => {
  if (tab === 'all') return true;
  if (tab === 'tram') return category.startsWith('tram');
  if (tab === 'night') return category === 'busNight';
  if (tab === 'other') return category === 'unknown';
  return category.startsWith('bus') && category !== 'busNight';
};

/**
 * The line grid's geometry.
 *
 * Chips are sized from the width actually available rather than from a fixed
 * column count, so a 320pt phone gets fewer, still-tappable chips instead of
 * six squeezed under the 44pt minimum. The cap stops a tablet from spreading
 * one row of line numbers across the whole screen.
 */
const CHIP_GAP = Space.sm;
const CHIP_MIN_WIDTH = 54;
const MAX_COLUMNS = 6;
const MIN_COLUMNS = 3;

function columnsFor(width: number) {
  if (width <= 0) return MAX_COLUMNS;
  const fits = Math.floor((width + CHIP_GAP) / (CHIP_MIN_WIDTH + CHIP_GAP));
  return Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, fits));
}

/** A dense, immediate line filter. An empty selection still means the whole fleet. */
export default function LinesScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const selected = useSelectedLines();
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<PickerTab>('all');
  const [gridWidth, setGridWidth] = useState(0);
  const lines = usePoll((signal) => getLines({ signal }), 15 * 60_000);

  const groups = useMemo(() => {
    if (!lines.data) return [];
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
        color: colorFor(category),
        lines: (lines.data?.[category] ?? []).slice().sort(compareLines),
      }))
      .filter((group) => group.lines.length > 0);
  }, [lines.data]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const needle = query.trim().toUpperCase();
  const visibleGroups = useMemo(
    () => groups
      // Search is global: a rider should never miss a line because an old tab
      // happens to be active.
      .filter((group) => needle.length > 0 || categoryInTab(group.category, tab))
      .map((group) => ({
        ...group,
        lines: needle
          ? group.lines.filter((line) => line.toUpperCase().includes(needle))
          : group.lines,
      }))
      .filter((group) => group.lines.length > 0),
    [groups, needle, tab],
  );

  const selectionLabel = selected.length === 0
    ? 'Cała sieć na mapie'
    : `${selected.length} ${plural(selected.length, [
        'wybrana linia',
        'wybrane linie',
        'wybranych linii',
      ])}`;

  const columns = columnsFor(gridWidth);
  const chipWidth =
    gridWidth > 0 ? (gridWidth - CHIP_GAP * (columns - 1)) / columns : CHIP_MIN_WIDTH;

  return (
    <ModalScreen
      title="Linie"
      subtitle={selectionLabel}
      action={
        selected.length > 0 ? (
          <Pressable
            onPress={() => selectionStore.clear()}
            accessibilityRole="button"
            accessibilityLabel="Usuń filtr linii"
            hitSlop={8}
            style={({ pressed }) => [styles.headerAction, pressed && styles.pressed]}>
            <ThemedText type="footnote" weight="semibold" color={theme.accent}>
              Wyczyść
            </ThemedText>
          </Pressable>
        ) : null
      }>
      {(scroll) => (
        <>
          <View style={styles.tools}>
            <View style={[styles.search, { backgroundColor: theme.backgroundElement }]}>
              <Ionicons name="search" size={17} color={theme.textSecondary} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Szukaj linii"
                placeholderTextColor={theme.textSecondary}
                style={[styles.searchInput, { color: theme.text }]}
                autoCapitalize="characters"
                autoCorrect={false}
                inputMode="search"
                returnKeyType="search"
              />
              {query.length > 0 && (
                <Pressable
                  onPress={() => setQuery('')}
                  accessibilityRole="button"
                  accessibilityLabel="Wyczyść wyszukiwanie"
                  hitSlop={8}>
                  <Ionicons name="close-circle" size={18} color={theme.textTertiary} />
                </Pressable>
              )}
            </View>

            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.tabs}>
              {TABS.map((entry) => {
                const active = tab === entry.id;
                return (
                  <Pressable
                    key={entry.id}
                    onPress={() => setTab(entry.id)}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: active }}
                    style={({ pressed }) => [
                      styles.tab,
                      { backgroundColor: active ? theme.backgroundSelected : theme.backgroundElement },
                      pressed && styles.pressed,
                    ]}>
                    <ThemedText
                      type="footnote"
                      weight="semibold"
                      themeColor={active ? 'text' : 'textSecondary'}>
                      {entry.label}
                    </ThemedText>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>

          {lines.loading && !lines.data ? (
            <View style={styles.centered}>
              <ActivityIndicator />
              <ThemedText type="footnote" themeColor="textSecondary">
                Wczytywanie rozkładu…
              </ThemedText>
            </View>
          ) : lines.error && !lines.data ? (
            <View style={styles.centered}>
              <ThemedText themeColor="textSecondary">Nie udało się pobrać listy linii</ThemedText>
              <Pressable onPress={lines.refresh} accessibilityRole="button" hitSlop={8}>
                <ThemedText type="callout" weight="semibold" color={theme.accent}>
                  Spróbuj ponownie
                </ThemedText>
              </Pressable>
            </View>
          ) : (
            <Animated.ScrollView
              style={styles.scroll}
              contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Space.xxl }]}
              keyboardDismissMode="on-drag"
              showsVerticalScrollIndicator={false}
              onScroll={scroll.onScroll}
              scrollEventThrottle={scroll.scrollEventThrottle}>
              {visibleGroups.length === 0 ? (
                <View style={styles.empty}>
                  <Ionicons name="search-outline" size={26} color={theme.textTertiary} />
                  <ThemedText type="headline">Nie znaleziono linii</ThemedText>
                  <ThemedText type="footnote" themeColor="textSecondary">
                    Sprawdź numer albo skrót linii.
                  </ThemedText>
                </View>
              ) : visibleGroups.map((group) => {
                const allSelected = group.lines.every((line) => selectedSet.has(line));
                const selectedInGroup = group.lines.filter((line) => selectedSet.has(line)).length;

                return (
                  <View key={group.category} style={styles.group}>
                    <View style={styles.groupHeader}>
                      <View style={styles.groupTitle}>
                        <View style={[styles.categoryBar, { backgroundColor: group.color }]} />
                        <ThemedText type="callout" weight="semibold" numberOfLines={1}>
                          {group.label}
                        </ThemedText>
                        <ThemedText type="footnote" themeColor="textSecondary">
                          {selectedInGroup > 0
                            ? `${selectedInGroup}/${group.lines.length}`
                            : group.lines.length}
                        </ThemedText>
                      </View>
                      <Pressable
                        onPress={() => {
                          const next = new Set(selected);
                          for (const line of group.lines) {
                            if (allSelected) next.delete(line);
                            else next.add(line);
                          }
                          selectionStore.set([...next]);
                        }}
                        accessibilityRole="button"
                        accessibilityLabel={`${allSelected ? 'Odznacz' : 'Wybierz'} wszystkie: ${group.label}`}
                        hitSlop={8}
                        style={({ pressed }) => [styles.bulkAction, pressed && styles.pressed]}>
                        <ThemedText type="footnote" weight="semibold" color={theme.accent}>
                          {allSelected ? 'Odznacz' : 'Wybierz'}
                        </ThemedText>
                      </Pressable>
                    </View>

                    {/* Measured once per layout, so every group's grid agrees
                        and partial rows run left rather than centring. */}
                    <View
                      style={styles.chips}
                      onLayout={(event) => {
                        const next = Math.round(event.nativeEvent.layout.width);
                        if (next > 0) setGridWidth((current) => (current === next ? current : next));
                      }}>
                      {group.lines.map((line) => (
                        <RouteChip
                          key={line}
                          line={line}
                          color={group.color}
                          width={chipWidth}
                          selected={selectedSet.has(line)}
                          onPress={() => selectionStore.toggle(line)}
                        />
                      ))}
                    </View>
                  </View>
                );
              })}
            </Animated.ScrollView>
          )}
        </>
      )}
    </ModalScreen>
  );
}

function RouteChip({
  line,
  color,
  width,
  selected,
  onPress,
}: {
  line: string;
  color: string;
  width: number;
  selected: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={`Linia ${line}`}
      style={({ pressed }) => [
        styles.chip,
        {
          width,
          backgroundColor: selected ? color : theme.backgroundCard,
          borderColor: selected ? color : theme.separator,
        },
        pressed && styles.pressed,
      ]}>
      <Text
        numberOfLines={1}
        allowFontScaling={false}
        style={[styles.chipLabel, { color: selected ? '#ffffff' : theme.text }]}>
        {line}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  headerAction: { minHeight: 32, justifyContent: 'center', paddingHorizontal: Space.xs },
  tools: { gap: Space.sm, paddingBottom: Space.sm },
  search: {
    minHeight: 40,
    paddingVertical: Space.sm,
    marginHorizontal: Space.lg,
    borderRadius: Radius.md,
    paddingHorizontal: Space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
  },
  searchInput: { ...Type.body, flex: 1, fontWeight: Weight.medium, paddingVertical: 0 },
  tabs: { gap: Space.xs, paddingHorizontal: Space.lg },
  tab: { height: 32, borderRadius: Radius.sm, justifyContent: 'center', paddingHorizontal: Space.md },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Space.sm },
  scroll: { flex: 1 },
  content: { paddingHorizontal: Space.lg, paddingTop: Space.sm, gap: Space.xl },
  empty: { alignItems: 'center', gap: Space.xs, paddingTop: Space.huge },
  group: { gap: Space.sm },
  groupHeader: {
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Space.sm,
  },
  groupTitle: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, flexShrink: 1 },
  categoryBar: { width: 3, height: 15, borderRadius: Radius.pill },
  bulkAction: { minHeight: 28, justifyContent: 'center', paddingHorizontal: Space.xs },
  // Left-aligned: a partial last row centred leaves a right-hand margin that
  // reads as a layout bug.
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: CHIP_GAP },
  chip: {
    height: HitTarget,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Space.xs,
  },
  chipLabel: {
    ...Type.callout,
    fontWeight: Weight.heavy,
    letterSpacing: -0.25,
    fontVariant: ['tabular-nums'],
  },
  pressed: { opacity: Motion.pressedOpacity },
});

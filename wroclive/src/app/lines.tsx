import Ionicons from '@expo/vector-icons/Ionicons';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ModalScreen } from '@/components/modal-screen';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
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
  shortLabelFor,
} from '@/lib/lines';
import { selectionStore, useSelectedLines } from '@/lib/selection';

const ALL_TAB = 'all';

const GRID_GAP = Spacing.two;
/** Smallest chip that still fits a three-digit line and clears a 44pt target. */
const MIN_CHIP = 48;
/** Largest chip: keeps badges from ballooning on tablets/desktops. */
const MAX_CHIP = 80;
/** Never more than five line badges in a single row. */
const MAX_COLUMNS = 5;

/**
 * Chip size and grid width for the line badge grid.
 *
 * Columns are derived from the available width and `MIN_CHIP`, capped at
 * `MAX_COLUMNS` so the grid never feels over-stuffed. On narrow phones this
 * yields five or six comfortable ~50 mm badges; on wide screens the count is
 * capped at six and badges grow to `MAX_CHIP` rather than stretching to fill
 * the viewport. The returned `gridWidth` is applied to the grid View so the
 * flexbox wrapper respects the column count (a capped `size` alone would let
 * smaller chips wrap to more per row than `columns` intends).
 */
function useGrid(horizontalPadding: number) {
  const { width } = useWindowDimensions();
  const available = Math.max(width - horizontalPadding * 2, MIN_CHIP);
  const maxColsByMin = Math.floor((available + GRID_GAP) / (MIN_CHIP + GRID_GAP));
  const columns = Math.max(1, Math.min(MAX_COLUMNS, maxColsByMin));
  const size = Math.min(MAX_CHIP, (available - GRID_GAP * (columns - 1)) / columns);
  const gridWidth = columns * size + GRID_GAP * (columns - 1);
  return { size, columns, gridWidth };
}

/**
 * Which lines the map draws.
 *
 * Nothing selected means everything is shown — the map is useful before anyone
 * has made a choice here. Categories double as tabs: with eleven of them,
 * stacking every group at once meant scrolling past ten cards to reach the
 * eleventh, so a tab narrows the list to one category at a time. Search still
 * reaches across whichever tab is active.
 */
export default function LinesScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const selected = useSelectedLines();
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<string>(ALL_TAB);
  const grid = useGrid(Spacing.three);

  // The timetable changes about as often as the city publishes a new snapshot,
  // so this is fetched rather than polled.
  const lines = usePoll((signal) => getLines({ signal }), 15 * 60_000);

  // Unfiltered by search — the tab strip is built from this, so a tab never
  // disappears out from under someone mid-search.
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
        shortLabel: shortLabelFor(category),
        color: colorFor(category),
        lines: (lines.data?.[category] ?? []).slice().sort(compareLines),
      }))
      .filter((group) => group.lines.length > 0);
  }, [lines.data]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const totalLines = useMemo(() => groups.reduce((sum, g) => sum + g.lines.length, 0), [groups]);

  const visibleGroups = useMemo(() => {
    const needle = query.trim().toUpperCase();
    return groups
      .filter((group) => tab === ALL_TAB || group.category === tab)
      .map((group) => ({
        ...group,
        lines: needle
          ? group.lines.filter((line) => line.toUpperCase().includes(needle))
          : group.lines,
      }))
      .filter((group) => group.lines.length > 0);
  }, [groups, tab, query]);

  return (
    <ModalScreen
      title="Linie"
      subtitle={
        selected.length === 0
          ? 'Na mapie widać całą sieć'
          : `${selected.length} ${plural(selected.length, [
              'wybrana linia',
              'wybrane linie',
              'wybranych linii',
            ])}`
      }
      action={
        selected.length > 0 ? (
          <Pressable
            onPress={() => selectionStore.clear()}
            accessibilityRole="button"
            accessibilityLabel="Usuń filtr linii"
            hitSlop={8}
            style={({ pressed }) => [
              styles.resetButton,
              { backgroundColor: theme.backgroundElement },
              pressed && styles.pressed,
            ]}>
            <ThemedText type="smallBold">Resetuj</ThemedText>
          </Pressable>
        ) : null
      }>
      <View style={styles.searchRow}>
        <View
          style={[
            styles.search,
            {
              backgroundColor: theme.backgroundElement,
              borderColor: theme.separator,
            },
          ]}>
          <Ionicons name="search" size={19} color={theme.textSecondary} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Szukaj numeru linii"
            placeholderTextColor={theme.textSecondary}
            style={[styles.searchInput, { color: theme.text }]}
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="search"
            inputMode="search"
          />
          {query.length > 0 && (
            <Pressable
              onPress={() => setQuery('')}
              accessibilityRole="button"
              accessibilityLabel="Wyczyść wyszukiwanie"
              hitSlop={8}>
              <Ionicons name="close-circle" size={19} color={theme.textSecondary} />
            </Pressable>
          )}
        </View>
      </View>

      {groups.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tabsRow}
          style={styles.tabsScroll}>
          <CategoryTab
            active={tab === ALL_TAB}
            accentColor={theme.text}
            accentText={theme.background}
            label="Wszystkie"
            count={selected.length > 0 ? `${selected.length}/${totalLines}` : `${totalLines}`}
            onPress={() => setTab(ALL_TAB)}
          />
          {groups.map((group) => {
            const inGroup = group.lines.filter((line) => selectedSet.has(line)).length;
            return (
              <CategoryTab
                key={group.category}
                active={tab === group.category}
                accentColor={group.color}
                accentText="#ffffff"
                label={group.shortLabel}
                dotColor={group.color}
                count={inGroup > 0 ? `${inGroup}/${group.lines.length}` : `${group.lines.length}`}
                onPress={() => setTab(group.category)}
              />
            );
          })}
        </ScrollView>
      )}

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
          style={styles.scroll}
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.five }]}
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}>
          {visibleGroups.length === 0 ? (
            <View style={styles.empty}>
              <Ionicons name="search-outline" size={28} color={theme.textSecondary} />
              <ThemedText type="defaultSemiBold">Nie znaleziono linii</ThemedText>
              <ThemedText type="small" themeColor="textSecondary" style={styles.emptyText}>
                Spróbuj wpisać inny numer albo wybrać inną kategorię.
              </ThemedText>
            </View>
          ) : (
            <>
              {visibleGroups.map((group) => {
                const all = group.lines.every((line) => selectedSet.has(line));
                const inGroup = group.lines.filter((line) => selectedSet.has(line)).length;

                return (
                  <View key={group.category} style={styles.group}>
                    {/* The name is here on every tab, not just "Wszystkie":
                        eleven pills do not fit on a phone, so the active one is
                        often scrolled off and this is the only thing on screen
                        saying which category is being shown. */}
                    <View style={styles.groupHeader}>
                      <View style={styles.groupTitle}>
                        <View style={[styles.categoryDot, { backgroundColor: group.color }]} />
                        <ThemedText type="defaultSemiBold" numberOfLines={1}>
                          {group.label}
                        </ThemedText>
                        <ThemedText type="small" themeColor="textSecondary">
                          {inGroup > 0 ? `${inGroup}/${group.lines.length}` : group.lines.length}
                        </ThemedText>
                      </View>

                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${all ? 'Odznacz' : 'Wybierz'} wszystkie: ${group.label}`}
                        hitSlop={8}
                        onPress={() => {
                          const next = new Set(selected);
                          for (const line of group.lines) {
                            if (all) next.delete(line);
                            else next.add(line);
                          }
                          selectionStore.set([...next]);
                        }}
                        style={({ pressed }) => [styles.groupAction, pressed && styles.pressed]}>
                        {/* A bulk action, not a heading — it recedes so the
                            category name stays the loudest thing in the row. */}
                        <ThemedText type="small" themeColor="textSecondary">
                          {all ? 'Odznacz wszystkie' : 'Zaznacz wszystkie'}
                        </ThemedText>
                      </Pressable>
                    </View>

                    <View style={[styles.grid, { width: grid.gridWidth }]}>
                      {group.lines.map((line) => {
                        const isSelected = selectedSet.has(line);
                        return (
                          <Pressable
                            key={line}
                            onPress={() => selectionStore.toggle(line)}
                            accessibilityRole="checkbox"
                            accessibilityState={{ checked: isSelected }}
                            accessibilityLabel={`Linia ${line}`}
                            style={({ pressed }) => [
                              styles.chip,
                              {
                                width: grid.size,
                                height: grid.size,
                                backgroundColor: isSelected ? group.color : theme.backgroundElement,
                              },
                              pressed && styles.pressed,
                            ]}>
                            {/* Not `LineBadge`: the chip is the badge here. Nesting one
                                inside a container drew the number twice over. */}
                            <Text
                              numberOfLines={1}
                              allowFontScaling={false}
                              style={[
                                styles.chipLabel,
                                {
                                  // White on a category colour clears 4.5:1 by
                                  // construction; the unselected chip is theme text
                                  // on `backgroundElement`, which clears it in both
                                  // light and dark.
                                  color: isSelected ? '#ffffff' : theme.text,
                                  fontSize: line.length > 3 ? 15 : 17,
                                },
                              ]}>
                              {line}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>
                );
              })}
            </>
          )}
        </ScrollView>
      )}
    </ModalScreen>
  );
}

type CategoryTabProps = {
  active: boolean;
  label: string;
  count: string;
  accentColor: string;
  accentText: string;
  dotColor?: string;
  onPress: () => void;
};

/** One pill in the horizontal category strip — the primary navigation here. */
function CategoryTab({
  active,
  label,
  count,
  accentColor,
  accentText,
  dotColor,
  onPress,
}: CategoryTabProps) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.tab,
        { backgroundColor: active ? accentColor : theme.backgroundElement },
        pressed && styles.pressed,
      ]}>
      {!!dotColor && (
        <View style={[styles.tabDot, { backgroundColor: active ? accentText : dotColor }]} />
      )}
      <ThemedText type="smallBold" style={{ color: active ? accentText : theme.text }}>
        {label}
      </ThemedText>
      <ThemedText
        type="small"
        style={{
          color: active ? accentText : theme.textSecondary,
          opacity: active ? 0.8 : 1,
        }}>
        {count}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  resetButton: {
    minHeight: 32,
    paddingHorizontal: Spacing.two + 2,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchRow: {
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.two,
  },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    height: 44,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  searchInput: { flex: 1, fontSize: 16, fontWeight: '500', paddingVertical: 0 },
  // A horizontal strip in a column: it must neither grow into the list's space
  // nor be shrunk to nothing by it. Height is explicit for the same reason.
  tabsScroll: { flexGrow: 0, flexShrink: 0, height: 34 + Spacing.three },
  tabsRow: {
    flexDirection: 'row',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.three,
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one + 2,
    height: 34,
    paddingHorizontal: Spacing.three - 2,
    borderRadius: 17,
  },
  tabDot: { width: 7, height: 7, borderRadius: 4 },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
  },
  scroll: { flex: 1 },
  content: {
    paddingHorizontal: Spacing.three,
    gap: Spacing.four,
    paddingBottom: Spacing.five,
  },
  empty: {
    alignItems: 'center',
    gap: Spacing.one,
    paddingVertical: Spacing.six,
  },
  // The block is centred, but the sentence still needs to be told to follow.
  emptyText: { textAlign: 'center', maxWidth: 260 },
  group: { gap: Spacing.two },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    minHeight: 24,
  },
  groupTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    flexShrink: 1,
  },
  categoryDot: { width: 8, height: 8, borderRadius: 4 },
  groupAction: { paddingVertical: Spacing.half },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GRID_GAP },
  // Width and height come from `useGrid` so the row divides exactly.
  chip: { borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  chipLabel: {
    fontWeight: '800',
    letterSpacing: -0.3,
    // Digits line up across the grid the way they do on the map.
    fontVariant: ['tabular-nums'],
  },
  pressed: { opacity: 0.6 },
});

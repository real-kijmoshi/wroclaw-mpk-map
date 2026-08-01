import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import * as Haptics from "expo-haptics";
import { Search, X } from "lucide-react-native";

import SwipeableModal from "../components/Modal";
import { color, colorForType, font, lineLabel, radius, space, type } from "../theme";

const HIDDEN_CATEGORIES = new Set(["allBuses", "allTrams"]);

const tick = () => Haptics.selectionAsync().catch(() => {});

export default function LinesSelection({
  lines,
  selectedLines,
  setSelectedLines,
  visible,
  onClose,
}) {
  const [query, setQuery] = useState("");
  const selected = useMemo(() => new Set(selectedLines), [selectedLines]);

  const categories = useMemo(() => {
    const needle = query.trim().toUpperCase();
    return Object.entries(lines ?? {})
      .filter(([category, values]) => !HIDDEN_CATEGORIES.has(category) && values?.length)
      .map(([category, values]) => [
        category,
        // Copy before filtering: sorting the prop array in place used to mutate
        // the state held by App.
        needle ? values.filter((line) => line.toUpperCase().includes(needle)) : [...values],
      ])
      .filter(([, values]) => values.length);
  }, [lines, query]);

  const toggle = (line) => {
    tick();
    setSelectedLines((previous) =>
      previous.includes(line) ? previous.filter((item) => item !== line) : [...previous, line],
    );
  };

  const toggleCategory = (values) => {
    tick();
    const allSelected = values.every((line) => selected.has(line));
    setSelectedLines((previous) =>
      allSelected
        ? previous.filter((line) => !values.includes(line))
        : [...new Set([...previous, ...values])],
    );
  };

  return (
    <SwipeableModal visible={visible} onClose={onClose}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.headerTitle}>Wybierz linie</Text>
          <Text style={styles.headerSubtitle}>
            {selectedLines.length === 0
              ? "Śledzone linie pojawią się na mapie"
              : `Śledzisz ${selectedLines.length} ${plural(selectedLines.length)}`}
          </Text>
        </View>
        <View style={styles.headerActions}>
          {selectedLines.length > 0 && (
            <Pressable
              onPress={() => setSelectedLines([])}
              style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}
              accessibilityRole="button"
            >
              <Text style={styles.headerButtonText}>Wyczyść</Text>
            </Pressable>
          )}
          <Pressable
            onPress={onClose}
            style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}
            accessibilityRole="button"
          >
            <Text style={[styles.headerButtonText, styles.headerButtonPrimary]}>Gotowe</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.searchRow}>
        <Search size={17} color={color.textMuted} strokeWidth={2} />
        <TextInput
          style={styles.search}
          value={query}
          onChangeText={setQuery}
          placeholder="Szukaj linii…"
          placeholderTextColor={color.textMuted}
          autoCapitalize="characters"
          autoCorrect={false}
          inputMode="search"
          returnKeyType="search"
        />
        {query.length > 0 && (
          <Pressable
            onPress={() => setQuery("")}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Wyczyść wyszukiwanie"
          >
            <X size={17} color={color.textMuted} />
          </Pressable>
        )}
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {categories.length === 0 && (
          <Text style={styles.empty}>
            {query ? "Brak linii pasujących do wyszukiwania." : "Brak dostępnych linii."}
          </Text>
        )}

        {categories.map(([category, values]) => {
          const tint = colorForType(category);
          const allSelected = values.every((line) => selected.has(line));
          return (
            <View key={category} style={styles.category}>
              <View style={styles.categoryHeader}>
                <View style={styles.categoryTitleRow}>
                  <View style={[styles.swatch, { backgroundColor: tint }]} />
                  <Text style={styles.categoryTitle}>{lineLabel[category] ?? category}</Text>
                </View>
                <Pressable
                  onPress={() => toggleCategory(values)}
                  hitSlop={8}
                  style={({ pressed }) => pressed && styles.pressed}
                  accessibilityRole="button"
                >
                  <Text style={styles.categoryAction}>
                    {allSelected ? "Odznacz wszystkie" : "Zaznacz wszystkie"}
                  </Text>
                </Pressable>
              </View>

              <View style={styles.linesRow}>
                {values.map((line) => {
                  const isSelected = selected.has(line);
                  return (
                    <Pressable
                      key={line}
                      onPress={() => toggle(line)}
                      style={({ pressed }) => [
                        styles.lineButton,
                        isSelected && { backgroundColor: tint, borderColor: tint },
                        pressed && styles.pressed,
                      ]}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: isSelected }}
                      accessibilityLabel={`Linia ${line}`}
                    >
                      <Text
                        style={[styles.lineText, isSelected && styles.lineTextSelected]}
                        allowFontScaling={false}
                      >
                        {line}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          );
        })}
      </ScrollView>
    </SwipeableModal>
  );
}

/** Polish counts take three forms: 1 linię, 2-4 linie, 5+ linii. */
function plural(count) {
  if (count === 1) return "linię";
  const last = count % 10;
  const teen = count % 100 >= 12 && count % 100 <= 14;
  return !teen && last >= 2 && last <= 4 ? "linie" : "linii";
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.6 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: space.sm,
    marginBottom: space.md,
  },
  headerText: { flex: 1 },
  headerTitle: { ...type.title, color: color.text },
  headerSubtitle: { ...type.small, color: color.textMuted, marginTop: 2 },
  headerActions: { flexDirection: "row", alignItems: "center" },
  headerButton: { paddingVertical: space.xs, paddingHorizontal: space.sm },
  headerButtonText: { ...type.body, color: color.textMuted, fontWeight: "600" },
  headerButtonPrimary: { color: color.rail },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    backgroundColor: color.paperMuted,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    marginBottom: space.md,
  },
  search: {
    flex: 1,
    paddingVertical: space.md,
    color: color.text,
    ...type.body,
  },
  scrollContent: { paddingBottom: space.xxl },
  empty: { ...type.body, color: color.textMuted, textAlign: "center", marginTop: space.xl },
  category: { marginBottom: space.xl },
  categoryHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: space.sm,
    marginBottom: space.md,
  },
  categoryTitleRow: { flexDirection: "row", alignItems: "center", gap: space.sm, flexShrink: 1 },
  swatch: { width: 10, height: 10, borderRadius: 5 },
  categoryTitle: { ...type.body, fontWeight: "700", fontSize: 16, color: color.text },
  categoryAction: { ...type.caption, letterSpacing: 0, color: color.rail },
  linesRow: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  lineButton: {
    minWidth: 52,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    alignItems: "center",
    backgroundColor: color.paperMuted,
    borderWidth: 1.5,
    borderColor: "transparent",
  },
  // The same condensed numeral face the badges use, so a line number reads as
  // the same object here as it does on the map and on the board.
  lineText: {
    fontFamily: font.data,
    fontSize: 17,
    lineHeight: 20,
    color: color.textMuted,
    includeFontPadding: false,
  },
  lineTextSelected: { color: color.paper },
});

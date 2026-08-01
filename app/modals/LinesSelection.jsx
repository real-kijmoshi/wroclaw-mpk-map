import { useMemo, useState } from "react";
import { Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Search, X } from "lucide-react-native";

import SwipeableModal from "../components/Modal";
import PressableScale from "../components/PressableScale";
import { HIT_SIZE, color, colorForType, font, lineLabel, radius, space, type } from "../theme";

const HIDDEN_CATEGORIES = new Set(["allBuses", "allTrams"]);

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

  const toggle = (line) =>
    setSelectedLines((previous) =>
      previous.includes(line) ? previous.filter((item) => item !== line) : [...previous, line],
    );

  const toggleCategory = (values) => {
    const allSelected = values.every((line) => selected.has(line));
    setSelectedLines((previous) =>
      allSelected
        ? previous.filter((line) => !values.includes(line))
        : [...new Set([...previous, ...values])],
    );
  };

  return (
    <SwipeableModal
      visible={visible}
      onClose={onClose}
      title="Wybierz linie"
      subtitle={`Zaznaczono ${selectedLines.length}`}
      secondaryAction={
        selectedLines.length > 0
          ? { label: "Wyczyść", onPress: () => setSelectedLines([]) }
          : undefined
      }
    >
      <View style={styles.searchRow}>
        <View style={styles.search}>
          <Search size={16} color={color.textMuted} strokeWidth={2.5} />
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder="Szukaj linii…"
            placeholderTextColor={color.textMuted}
            autoCapitalize="characters"
            autoCorrect={false}
            inputMode="search"
            returnKeyType="search"
            clearButtonMode="never"
          />
          {query.length > 0 && (
            <PressableScale
              onPress={() => setQuery("")}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Wyczyść wyszukiwanie"
            >
              <View style={styles.clear}>
                <X size={12} color={color.paper} strokeWidth={3} />
              </View>
            </PressableScale>
          )}
        </View>
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
          const allSelected = values.every((line) => selected.has(line));
          const tint = colorForType(category);

          return (
            <View key={category} style={styles.category}>
              <View style={styles.categoryHeader}>
                <View style={styles.categoryTitleRow}>
                  <View style={[styles.swatch, { backgroundColor: tint }]} />
                  <Text style={styles.categoryTitle}>{lineLabel[category] ?? category}</Text>
                </View>
                <PressableScale
                  onPress={() => toggleCategory(values)}
                  hitSlop={8}
                  style={styles.categoryButton}
                  accessibilityRole="button"
                >
                  <Text style={styles.categoryAction}>
                    {allSelected ? "Odznacz wszystkie" : "Zaznacz wszystkie"}
                  </Text>
                </PressableScale>
              </View>

              <View style={styles.linesRow}>
                {values.map((line) => {
                  const isSelected = selected.has(line);
                  return (
                    <PressableScale
                      key={line}
                      onPress={() => toggle(line)}
                      scale={0.9}
                      style={[styles.lineButton, isSelected && { backgroundColor: tint }]}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: isSelected }}
                      accessibilityLabel={`Linia ${line}`}
                    >
                      <Text
                        style={[styles.lineText, isSelected && styles.lineTextSelected]}
                        allowFontScaling={false}
                        numberOfLines={1}
                      >
                        {line}
                      </Text>
                    </PressableScale>
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

const styles = StyleSheet.create({
  searchRow: { paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.sm },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    height: 38,
    paddingHorizontal: space.md,
    borderRadius: radius.control,
    backgroundColor: color.fill,
  },
  searchInput: {
    flex: 1,
    ...type.callout,
    color: color.text,
    // Web only: react-native-web renders a real <input>, which draws a focus
    // ring the rest of the app has no equivalent for.
    ...Platform.select({ web: { outlineStyle: "none" }, default: {} }),
  },
  clear: {
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.textMuted,
  },
  scrollContent: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xxl },
  empty: { ...type.callout, color: color.textMuted, textAlign: "center", marginTop: space.xxl },
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
  categoryTitle: { ...type.headline, color: color.text, flexShrink: 1 },
  categoryButton: { paddingVertical: space.xs, paddingLeft: space.sm },
  categoryAction: { ...type.small, color: color.rail, fontWeight: "600" },
  linesRow: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  // 44pt square minimum: these were 35pt tall, which is a miss every few taps
  // when you are walking.
  lineButton: {
    minWidth: 56,
    height: HIT_SIZE,
    paddingHorizontal: space.md,
    borderRadius: radius.control,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.fill,
  },
  lineText: {
    fontFamily: font.data,
    fontSize: 19,
    color: color.text,
    includeFontPadding: false,
  },
  lineTextSelected: { color: color.paper },
});

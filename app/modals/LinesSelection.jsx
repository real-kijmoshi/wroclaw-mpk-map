import { useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";

import SwipeableModal from "../components/Modal";
import { CATEGORY_LABELS, COLORS, LINE_COLORS } from "../theme";

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
    <SwipeableModal visible={visible} onClose={onClose}>
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>Wybierz linie</Text>
          <Text style={styles.headerSubtitle}>{`Zaznaczono ${selectedLines.length}`}</Text>
        </View>
        <View style={styles.headerActions}>
          {selectedLines.length > 0 && (
            <TouchableOpacity onPress={() => setSelectedLines([])} style={styles.headerButton}>
              <Text style={styles.headerButtonText}>Wyczyść</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={onClose} style={styles.headerButton}>
            <Text style={[styles.headerButtonText, styles.headerButtonPrimary]}>Gotowe</Text>
          </TouchableOpacity>
        </View>
      </View>

      <TextInput
        style={styles.search}
        value={query}
        onChangeText={setQuery}
        placeholder="Szukaj linii…"
        placeholderTextColor={COLORS.textMuted}
        autoCapitalize="characters"
        autoCorrect={false}
        inputMode="search"
        returnKeyType="search"
      />

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {categories.length === 0 && (
          <Text style={styles.empty}>
            {query ? "Brak linii pasujących do wyszukiwania." : "Brak dostępnych linii."}
          </Text>
        )}

        {categories.map(([category, values]) => {
          const allSelected = values.every((line) => selected.has(line));
          return (
            <View key={category} style={styles.category}>
              <View style={styles.categoryHeader}>
                <View style={styles.categoryTitleRow}>
                  <View
                    style={[
                      styles.swatch,
                      { backgroundColor: LINE_COLORS[category] ?? LINE_COLORS.unknown },
                    ]}
                  />
                  <Text style={styles.categoryTitle}>
                    {CATEGORY_LABELS[category] ?? category}
                  </Text>
                </View>
                <TouchableOpacity onPress={() => toggleCategory(values)} hitSlop={8}>
                  <Text style={styles.categoryAction}>
                    {allSelected ? "Odznacz wszystkie" : "Zaznacz wszystkie"}
                  </Text>
                </TouchableOpacity>
              </View>

              <View style={styles.linesRow}>
                {values.map((line) => {
                  const isSelected = selected.has(line);
                  return (
                    <TouchableOpacity
                      key={line}
                      onPress={() => toggle(line)}
                      style={[
                        styles.lineButton,
                        isSelected && {
                          backgroundColor: LINE_COLORS[category] ?? LINE_COLORS.unknown,
                          borderColor: "#fff",
                        },
                      ]}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: isSelected }}
                      accessibilityLabel={`Linia ${line}`}
                    >
                      <Text style={[styles.lineText, isSelected && styles.lineTextSelected]}>
                        {line}
                      </Text>
                    </TouchableOpacity>
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
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  headerTitle: { fontSize: 20, fontWeight: "700", color: COLORS.text },
  headerSubtitle: { fontSize: 12, color: COLORS.textMuted, marginTop: 2 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 4 },
  headerButton: { paddingVertical: 6, paddingHorizontal: 8 },
  headerButtonText: { fontSize: 15, color: COLORS.textMuted, fontWeight: "600" },
  headerButtonPrimary: { color: COLORS.accentText },
  search: {
    backgroundColor: COLORS.surfaceAlt,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: COLORS.text,
    fontSize: 15,
    marginBottom: 14,
  },
  scrollContent: { paddingBottom: 30 },
  empty: { color: COLORS.textMuted, fontSize: 14, textAlign: "center", marginTop: 24 },
  category: { marginBottom: 22 },
  categoryHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  categoryTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  swatch: { width: 10, height: 10, borderRadius: 5 },
  categoryTitle: { fontSize: 16, fontWeight: "700", color: COLORS.text },
  categoryAction: { fontSize: 12, color: COLORS.accentText, fontWeight: "600" },
  linesRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  lineButton: {
    minWidth: 52,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    alignItems: "center",
    backgroundColor: COLORS.surfaceAlt,
    borderWidth: 1.5,
    borderColor: "transparent",
  },
  lineText: { fontSize: 15, color: COLORS.textMuted, fontWeight: "700" },
  lineTextSelected: { color: "#fff" },
});

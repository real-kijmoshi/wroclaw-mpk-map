import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from "react-native";
import SwipeableModal from "../components/Modal";

const translations = {
  tram: { name: "Tramwaje", color: "#4A90E2" },
  tramSpecial: { name: "Tramwaje Specjalne", color: "#50E3C2" },
  tramTemporary: { name: "Tramwaje Tymczasowe", color: "#F8E71C" },
  bus: { name: "Autobusy", color: "#E85D75" },
  busNight: { name: "Autobusy Nocne", color: "#9013FE" },
  busSuburban: { name: "Autobusy Podmiejskie", color: "#7ED321" },
  busTemporary: { name: "Autobusy Tymczasowe", color: "#B8E986" },
  busZone: { name: "Autobusy Strefowe", color: "#efff00" },
  busExpress: { name: "Autobusy Ekspresowe", color: "#F5A623" },
  busSpecial: { name: "Autobusy Specjalne", color: "#D0021B" },
  unknown: { name: "Nieznane", color: "#D0021B" },
};

export default function LinesSelection({
  lines,
  selectedLines,
  setSelectedLines,
  visible,
  onClose,
}) {
  return (
    <SwipeableModal 
        visible={visible} 
        onClose={onClose}
    >
      
      {/* Header with close button */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Wybierz linie</Text>
        <TouchableOpacity onPress={onClose} style={styles.closeButton}>
          <Text style={styles.closeButtonText}>Gotowe</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {Object.keys(lines)
          .filter(
            (cat) => !["allBuses", "allTrams"].includes(cat) && lines[cat].length
          )
          .map((category) => (
            <View key={category} style={styles.categoryContainer}>
              <Text style={styles.categoryTitle}>
                {translations[category]?.name || category}
              </Text>

              <View style={styles.linesRow}>
                {lines[category]
                .sort((a, b) => a - b)
                .map((line) => {
                  const isSelected = selectedLines.includes(line);
                  const categoryColor = translations[category]?.color || "#999";

                  return (
                    <TouchableOpacity
                      key={line}
                      style={[
                        styles.lineButton,
                        { backgroundColor: categoryColor },
                        isSelected && styles.lineButtonSelected,
                      ]}
                      onPress={() => {
                        setSelectedLines((prev) =>
                          prev.includes(line)
                            ? prev.filter((l) => l !== line)
                            : [...prev, line]
                        );
                      }}
                      accessibilityRole="button"
                      accessibilityState={{ selected: isSelected }}
                      accessibilityLabel={`Linia ${line}, ${
                        isSelected ? "wybrana" : "nie wybrana"
                      }`}
                    >
                      <Text
                        style={[
                          styles.lineText,
                          isSelected && styles.lineTextSelected,
                        ]}
                      >
                        {line}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          ))}
      </ScrollView>
    </SwipeableModal>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: "600",
    color: "#FFFFFF", // Changed to white for dark mode
  },
  closeButton: {
    padding: 8,
  },
  closeButtonText: {
    fontSize: 17,
    color: "#0A84FF", // Brighter blue for better visibility in dark mode
    fontWeight: "600",
  },
  scrollContent: {
    paddingBottom: 30,
    backgroundColor: "#121212", // Dark background for the content area
  },
  categoryContainer: {
    marginBottom: 25,
  },
  categoryTitle: {
    fontSize: 20,
    fontWeight: "bold",
    marginBottom: 12,
    color: "#E0E0E0", // Light gray for better readability
  },
  linesRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-start",
    alignItems: "center",
  },
  lineButton: {
    minWidth: 60,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
    marginRight: 10,
    marginBottom: 10,
    flexDirection: "row",
    alignItems: "center",
  },
  lineButtonSelected: {
    backgroundColor: "#BB86FC", // Purple accent color for selected items in dark mode
  },
  lineText: {
    fontSize: 16,
    color: "#FFFFFF", // White text for better contrast
    fontWeight: "600",
  },
  lineTextSelected: {
    color: "#000000", // Black text for selected items for better contrast
  },
});
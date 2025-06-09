import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from "react-native";
import SwipeableModal from "../components/Modal";

export default function SettingsModal({ visible, onClose }) {
  // You can add actual settings UI here — toggles, options, etc.
  return (
    <SwipeableModal visible={visible} onClose={onClose}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Ustawienia</Text>
        <TouchableOpacity onPress={onClose} style={styles.closeButton}>
          <Text style={styles.closeButtonText}>Gotowe</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.settingText}>Tutaj możesz dodać ustawienia aplikacji.</Text>
        {/* Add your actual settings components here */}
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
    color: "#000",
  },
  closeButton: {
    padding: 8,
  },
  closeButtonText: {
    fontSize: 17,
    color: "#007AFF",
    fontWeight: "600",
  },
  scrollContent: {
    paddingBottom: 30,
  },
  settingText: {
    fontSize: 16,
    color: "#444",
  },
});

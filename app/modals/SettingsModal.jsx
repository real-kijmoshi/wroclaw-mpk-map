import { Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import Constants from "expo-constants";

import SwipeableModal from "../components/Modal";
import { API_URL } from "../api";
import { COLORS } from "../theme";

const REPO_URL = "https://github.com/real-kijmoshi/wroclaw-mpk-map";

function Row({ label, value }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

export default function SettingsModal({ visible, onClose, selectedCount = 0, onClearLines }) {
  return (
    <SwipeableModal visible={visible} onClose={onClose} modalHeight={520}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Ustawienia</Text>
        <TouchableOpacity onPress={onClose} style={styles.closeButton} hitSlop={12}>
          <Text style={styles.closeButtonText}>Gotowe</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.sectionTitle}>Twoje linie</Text>
        <Row label="Zaznaczone linie" value={String(selectedCount)} />
        <TouchableOpacity
          style={[styles.button, selectedCount === 0 && styles.buttonDisabled]}
          onPress={onClearLines}
          disabled={selectedCount === 0}
        >
          <Text style={styles.buttonText}>Wyczyść wybór linii</Text>
        </TouchableOpacity>

        <Text style={styles.sectionTitle}>Aplikacja</Text>
        <Row label="Wersja" value={Constants.expoConfig?.version ?? "—"} />
        <Row label="Serwer API" value={API_URL} />

        <Text style={styles.sectionTitle}>Dane</Text>
        <Text style={styles.paragraph}>
          Rozkłady jazdy pochodzą z serwisu Otwarte Dane Wrocław (GTFS), a pozycje pojazdów
          z publicznego API MPK Wrocław. Aplikacja nie jest oficjalnym produktem MPK.
        </Text>

        <TouchableOpacity style={styles.button} onPress={() => Linking.openURL(REPO_URL)}>
          <Text style={styles.buttonText}>Kod źródłowy na GitHubie</Text>
        </TouchableOpacity>
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
  headerTitle: { fontSize: 22, fontWeight: "700", color: COLORS.text },
  closeButton: { paddingVertical: 6, paddingHorizontal: 8 },
  closeButtonText: { fontSize: 15, color: COLORS.accentText, fontWeight: "600" },
  content: { paddingBottom: 30 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: COLORS.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 18,
    marginBottom: 8,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.12)",
  },
  rowLabel: { fontSize: 15, color: COLORS.text },
  rowValue: { fontSize: 13, color: COLORS.textMuted, flexShrink: 1, textAlign: "right" },
  paragraph: { fontSize: 13, color: COLORS.textMuted, lineHeight: 19 },
  button: {
    marginTop: 14,
    backgroundColor: COLORS.surfaceAlt,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: COLORS.text, fontSize: 15, fontWeight: "600" },
});

import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Constants from "expo-constants";

import SwipeableModal from "../components/Modal";
import { API_URL } from "../api";
import { color, font, radius, space, type } from "../theme";

const REPO_URL = "https://github.com/real-kijmoshi/wroclaw-mpk-map";
const DATA_URL = "https://opendata.cui.wroclaw.pl/";

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

/**
 * The old settings screen was `#000` text on a `#121212` background — invisible
 * — and had nothing in it besides a sentence saying settings could go here.
 */
export default function SettingsModal({ visible, onClose, selectedCount = 0, onClearLines }) {
  return (
    <SwipeableModal visible={visible} onClose={onClose} modalHeight={540}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Ustawienia</Text>
        <Pressable onPress={onClose} style={styles.close} hitSlop={12}>
          <Text style={styles.closeText}>Gotowe</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.section}>Twoje linie</Text>
        <Row label="Zaznaczone linie" value={String(selectedCount)} />
        <Pressable
          style={[styles.button, selectedCount === 0 && styles.buttonDisabled]}
          onPress={onClearLines}
          disabled={selectedCount === 0}
        >
          <Text style={styles.buttonText}>Wyczyść wybór linii</Text>
        </Pressable>

        <Text style={styles.section}>Aplikacja</Text>
        <Row label="Wersja" value={Constants.expoConfig?.version ?? "—"} />
        <Row label="Serwer API" value={API_URL} />

        <Text style={styles.section}>Skąd są dane</Text>
        <Text style={styles.paragraph}>
          Rozkłady jazdy pochodzą z serwisu Otwarte Dane Wrocław (format GTFS), a pozycje
          pojazdów z publicznego API MPK Wrocław. Komunikaty są zbierane ze stron miejskich.
          Aplikacja nie jest oficjalnym produktem MPK.
        </Text>
        <Text style={styles.paragraph}>
          Lokalizacja jest używana wyłącznie do pokazania Cię na mapie i nie opuszcza
          urządzenia.
        </Text>

        <Pressable style={styles.button} onPress={() => Linking.openURL(DATA_URL)}>
          <Text style={styles.buttonText}>Otwarte Dane Wrocław</Text>
        </Pressable>
        <Pressable style={styles.button} onPress={() => Linking.openURL(REPO_URL)}>
          <Text style={styles.buttonText}>Kod źródłowy na GitHubie</Text>
        </Pressable>
      </ScrollView>
    </SwipeableModal>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: space.md,
  },
  headerTitle: { ...type.title, color: color.text },
  close: { paddingVertical: space.xs, paddingHorizontal: space.sm },
  closeText: { ...type.body, color: color.rail, fontWeight: "600" },
  content: { paddingBottom: space.xxl },
  section: {
    ...type.caption,
    color: color.textMuted,
    textTransform: "uppercase",
    marginTop: space.xl,
    marginBottom: space.sm,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: space.md,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.paperLine,
  },
  rowLabel: { ...type.body, color: color.text },
  rowValue: {
    ...type.small,
    fontFamily: font.dataMedium,
    color: color.textMuted,
    flexShrink: 1,
    textAlign: "right",
  },
  paragraph: { ...type.small, color: color.textMuted, lineHeight: 20, marginBottom: space.sm },
  button: {
    marginTop: space.md,
    backgroundColor: color.paperMuted,
    borderRadius: radius.md,
    paddingVertical: space.md,
    alignItems: "center",
  },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { ...type.body, color: color.text, fontWeight: "600" },
});

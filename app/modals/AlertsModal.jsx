import {
  ActivityIndicator,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import SwipeableModal from "../components/Modal";
import { COLORS } from "../theme";

const formatAge = (timestamp) => {
  const minutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "teraz";
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} godz.`;
  return `${Math.floor(minutes / 1440)} dni`;
};

/** "https://www.wroclaw.pl/komunikacja/rss" -> "wroclaw.pl" */
const sourceLabel = (source) => {
  if (!source) return "";
  const match = /^https?:\/\/(?:www\.)?([^/]+)/i.exec(source);
  return match ? match[1] : source;
};

export default function AlertsModal({ visible, onClose, alerts = [], loading, error }) {
  const open = (url) => {
    if (url) Linking.openURL(url).catch(() => {});
  };

  return (
    <SwipeableModal visible={visible} onClose={onClose}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Komunikaty</Text>
        <TouchableOpacity onPress={onClose} style={styles.closeButton} hitSlop={12}>
          <Text style={styles.closeButtonText}>Zamknij</Text>
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
        {loading && (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={COLORS.accent} />
          </View>
        )}

        {!loading && error && (
          <View style={styles.center}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {!loading && !error && alerts.length === 0 && (
          <View style={styles.center}>
            <Text style={styles.emptyText}>Brak aktualnych utrudnień.</Text>
          </View>
        )}

        {!loading &&
          !error &&
          alerts.map((alert) => (
            <TouchableOpacity
              key={alert.id}
              style={styles.card}
              activeOpacity={alert.url ? 0.7 : 1}
              onPress={() => open(alert.url)}
              accessibilityRole={alert.url ? "link" : "text"}
            >
              <View style={styles.cardHeader}>
                <Text style={styles.source}>{sourceLabel(alert.source)}</Text>
                <Text style={styles.age}>{formatAge(alert.timestamp)}</Text>
              </View>

              {alert.title ? <Text style={styles.title}>{alert.title}</Text> : null}
              {alert.content ? (
                <Text style={styles.body} numberOfLines={6}>
                  {alert.content}
                </Text>
              ) : null}

              {alert.affected?.length > 0 && (
                <View style={styles.chips}>
                  {alert.affected.map((line) => (
                    <View key={line} style={styles.chip}>
                      <Text style={styles.chipText}>{line}</Text>
                    </View>
                  ))}
                </View>
              )}
            </TouchableOpacity>
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
    marginBottom: 12,
  },
  headerTitle: { fontSize: 22, fontWeight: "700", color: COLORS.text },
  closeButton: { paddingVertical: 6, paddingHorizontal: 8 },
  closeButtonText: { fontSize: 15, color: COLORS.accentText, fontWeight: "600" },
  scroll: { flex: 1 },
  center: { alignItems: "center", justifyContent: "center", paddingVertical: 60 },
  errorText: { fontSize: 15, color: COLORS.danger, textAlign: "center" },
  emptyText: { fontSize: 15, color: COLORS.textMuted, textAlign: "center" },
  card: {
    backgroundColor: COLORS.surfaceAlt,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: 6 },
  source: { fontSize: 12, color: COLORS.textMuted, fontWeight: "600" },
  age: { fontSize: 12, color: COLORS.textMuted },
  title: { fontSize: 15, fontWeight: "700", color: COLORS.text, marginBottom: 4 },
  body: { fontSize: 14, color: "rgba(255,255,255,0.85)", lineHeight: 20 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 10 },
  chip: {
    backgroundColor: COLORS.accent,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  chipText: { color: "#fff", fontSize: 12, fontWeight: "700" },
});

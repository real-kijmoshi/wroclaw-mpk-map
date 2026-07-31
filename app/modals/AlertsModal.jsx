import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import SwipeableModal from "../components/Modal";
import LineBadge from "../components/LineBadge";
import { color, font, radius, space, type } from "../theme";

const formatAge = (timestamp) => {
  const minutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "teraz";
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} godz.`;
  return `${Math.floor(minutes / 1440)} dni`;
};

/** "https://www.wroclaw.pl/komunikacja/..." -> "wroclaw.pl" */
const sourceLabel = (source) => {
  if (!source) return "";
  const match = /^https?:\/\/(?:www\.)?([^/]+)/i.exec(source);
  return match ? match[1] : source;
};

export default function AlertsModal({
  visible,
  onClose,
  alerts = [],
  followedLines,
  loading,
  error,
}) {
  const open = (url) => {
    if (url) Linking.openURL(url).catch(() => {});
  };

  const followed = (alert) => alert.affected?.some((line) => followedLines?.has(line));

  return (
    <SwipeableModal visible={visible} onClose={onClose}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Komunikaty</Text>
        <Pressable onPress={onClose} style={styles.close} hitSlop={12}>
          <Text style={styles.closeText}>Zamknij</Text>
        </Pressable>
      </View>

      <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
        {loading && (
          <View style={styles.centre}>
            <ActivityIndicator size="large" color={color.rail} />
          </View>
        )}

        {!loading && error && (
          <View style={styles.centre}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {!loading && !error && alerts.length === 0 && (
          <View style={styles.centre}>
            <Text style={styles.emptyText}>Brak aktualnych utrudnień.</Text>
          </View>
        )}

        {!loading &&
          !error &&
          alerts.map((alert) => (
            <Pressable
              key={alert.id}
              style={[styles.card, followed(alert) && styles.cardFollowed]}
              onPress={() => open(alert.url)}
              accessibilityRole={alert.url ? "link" : "text"}
            >
              <View style={styles.cardHeader}>
                <Text style={styles.source}>{sourceLabel(alert.source)}</Text>
                <Text style={styles.age}>{formatAge(alert.timestamp)}</Text>
              </View>

              {alert.title ? <Text style={styles.title}>{alert.title}</Text> : null}
              {alert.content && alert.content !== alert.title ? (
                <Text style={styles.body} numberOfLines={6}>
                  {alert.content}
                </Text>
              ) : null}

              {alert.affected?.length > 0 && (
                <View style={styles.badges}>
                  {alert.affected.slice(0, 12).map((line) => (
                    <LineBadge key={line} line={line} type={alert.types?.[line]} size="sm" />
                  ))}
                </View>
              )}
            </Pressable>
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
    marginBottom: space.md,
  },
  headerTitle: { ...type.title, color: color.text },
  close: { paddingVertical: space.xs, paddingHorizontal: space.sm },
  closeText: { ...type.body, color: color.rail, fontWeight: "600" },
  scroll: { flex: 1 },
  centre: { alignItems: "center", justifyContent: "center", paddingVertical: 60 },
  errorText: { ...type.body, color: color.disruption, textAlign: "center" },
  emptyText: { ...type.body, color: color.textMuted, textAlign: "center" },
  card: {
    backgroundColor: color.paperMuted,
    borderRadius: radius.md,
    padding: space.lg,
    marginBottom: space.sm,
    borderLeftWidth: 3,
    borderLeftColor: "transparent",
  },
  // Something touching a line you follow is the reason you opened this.
  cardFollowed: { borderLeftColor: color.disruption },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: space.xs },
  source: { ...type.caption, color: color.textMuted, textTransform: "none" },
  age: { ...type.caption, color: color.textMuted, fontFamily: font.dataMedium },
  title: { ...type.body, fontWeight: "700", color: color.text, marginBottom: space.xs },
  body: { ...type.small, color: color.textMuted, lineHeight: 20 },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: space.xs, marginTop: space.md },
});

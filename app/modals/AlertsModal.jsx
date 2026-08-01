import { ActivityIndicator, Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import { CheckCircle2, ChevronRight, TriangleAlert } from "lucide-react-native";

import SwipeableModal from "../components/Modal";
import LineBadge from "../components/LineBadge";
import PressableScale from "../components/PressableScale";
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
    <SwipeableModal
      visible={visible}
      onClose={onClose}
      title="Komunikaty"
      subtitle={alerts.length > 0 ? `${alerts.length} aktualnych` : undefined}
      actionLabel="Zamknij"
      background="grouped"
    >
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {loading && (
          <View style={styles.centre}>
            <ActivityIndicator size="large" color={color.rail} />
          </View>
        )}

        {!loading && error && (
          <View style={styles.centre}>
            <TriangleAlert size={28} color={color.disruption} strokeWidth={2} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {!loading && !error && alerts.length === 0 && (
          <View style={styles.centre}>
            <CheckCircle2 size={30} color={color.live} strokeWidth={2} />
            <Text style={styles.emptyText}>Brak aktualnych utrudnień.</Text>
          </View>
        )}

        {!loading &&
          !error &&
          alerts.map((alert) => (
            <PressableScale
              key={alert.id}
              scale={0.98}
              style={[styles.card, followed(alert) && styles.cardFollowed]}
              onPress={() => open(alert.url)}
              disabled={!alert.url}
              feedback={alert.url ? "selection" : null}
              accessibilityRole={alert.url ? "link" : "text"}
            >
              <View style={styles.cardHeader}>
                <Text style={styles.source} numberOfLines={1}>
                  {sourceLabel(alert.source)}
                </Text>
                <View style={styles.cardHeaderRight}>
                  <Text style={styles.age}>{formatAge(alert.timestamp)}</Text>
                  {alert.url ? (
                    <ChevronRight size={15} color={color.textMuted} strokeWidth={2.5} />
                  ) : null}
                </View>
              </View>

              {followed(alert) && <Text style={styles.followedTag}>Dotyczy Twojej linii</Text>}

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
            </PressableScale>
          ))}
      </ScrollView>
    </SwipeableModal>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.xxl },
  centre: { alignItems: "center", justifyContent: "center", gap: space.md, paddingVertical: 64 },
  errorText: { ...type.callout, color: color.disruption, textAlign: "center" },
  emptyText: { ...type.callout, color: color.textMuted, textAlign: "center" },
  card: {
    backgroundColor: color.paper,
    borderRadius: radius.card,
    padding: space.lg,
    marginBottom: space.md,
    borderLeftWidth: 3,
    borderLeftColor: "transparent",
  },
  // Something touching a line you follow is the reason you opened this.
  cardFollowed: { borderLeftColor: color.disruption },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: space.sm,
    marginBottom: space.xs,
  },
  cardHeaderRight: { flexDirection: "row", alignItems: "center", gap: space.xs },
  source: { ...type.caption, color: color.textMuted, textTransform: "none", flexShrink: 1 },
  age: { ...type.caption, color: color.textMuted, fontFamily: font.dataMedium },
  followedTag: {
    ...type.caption,
    color: color.disruption,
    textTransform: "uppercase",
    marginBottom: space.xs,
  },
  title: { ...type.headline, color: color.text, marginBottom: space.xs },
  body: { ...type.footnote, color: color.textMuted, lineHeight: 19 },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: space.xs, marginTop: space.md },
});

import { Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import Constants from "expo-constants";
import { ChevronRight, ExternalLink } from "lucide-react-native";

import SwipeableModal from "../components/Modal";
import PressableScale from "../components/PressableScale";
import { API_URL } from "../api";
import { HIT_SIZE, color, font, hairline, radius, space, type } from "../theme";

const REPO_URL = "https://github.com/real-kijmoshi/wroclaw-mpk-map";
const DATA_URL = "https://opendata.cui.wroclaw.pl/";

/** iOS inset grouped list: a card per group, hairlines only between rows. */
function Group({ title, footer, children }) {
  const rows = Array.isArray(children) ? children.filter(Boolean) : [children];

  return (
    <View style={styles.group}>
      {title ? <Text style={styles.groupTitle}>{title}</Text> : null}
      <View style={styles.card}>
        {rows.map((row, index) => (
          <View key={index} style={index > 0 ? styles.rowDivider : null}>
            {row}
          </View>
        ))}
      </View>
      {footer ? <Text style={styles.groupFooter}>{footer}</Text> : null}
    </View>
  );
}

function ValueRow({ label, value }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function ActionRow({ label, onPress, disabled, destructive, external }) {
  return (
    <PressableScale
      scale={0.99}
      onPress={onPress}
      disabled={disabled}
      style={[styles.row, disabled && styles.rowDisabled]}
      accessibilityRole={external ? "link" : "button"}
      accessibilityState={{ disabled: Boolean(disabled) }}
    >
      <Text style={[styles.rowLabel, destructive && styles.rowLabelDestructive]}>{label}</Text>
      {external ? (
        <ExternalLink size={17} color={color.textMuted} strokeWidth={2} />
      ) : destructive ? null : (
        <ChevronRight size={18} color={color.textMuted} strokeWidth={2.5} />
      )}
    </PressableScale>
  );
}

/**
 * The old settings screen was `#000` text on a `#121212` background — invisible
 * — and had nothing in it besides a sentence saying settings could go here.
 */
export default function SettingsModal({ visible, onClose, selectedCount = 0, onClearLines }) {
  const open = (url) => Linking.openURL(url).catch(() => {});

  return (
    <SwipeableModal
      visible={visible}
      onClose={onClose}
      title="Ustawienia"
      background="grouped"
      detent={0.72}
    >
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Group title="Twoje linie">
          <ValueRow label="Zaznaczone linie" value={String(selectedCount)} />
          <ActionRow
            label="Wyczyść wybór linii"
            onPress={onClearLines}
            disabled={selectedCount === 0}
            destructive
          />
        </Group>

        <Group title="Aplikacja">
          <ValueRow label="Wersja" value={Constants.expoConfig?.version ?? "—"} />
          <ValueRow label="Serwer API" value={API_URL} />
        </Group>

        <Group
          title="Skąd są dane"
          footer="Lokalizacja jest używana wyłącznie do pokazania Cię na mapie i nie opuszcza urządzenia."
        >
          <View style={styles.prose}>
            <Text style={styles.paragraph}>
              Rozkłady jazdy pochodzą z serwisu Otwarte Dane Wrocław (format GTFS), a pozycje
              pojazdów z publicznego API MPK Wrocław. Komunikaty są zbierane ze stron miejskich.
              Aplikacja nie jest oficjalnym produktem MPK.
            </Text>
          </View>
          <ActionRow label="Otwarte Dane Wrocław" onPress={() => open(DATA_URL)} external />
          <ActionRow label="Kod źródłowy na GitHubie" onPress={() => open(REPO_URL)} external />
        </Group>
      </ScrollView>
    </SwipeableModal>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.xxl },
  group: { marginBottom: space.xl },
  groupTitle: {
    ...type.caption,
    color: color.textMuted,
    textTransform: "uppercase",
    marginBottom: space.sm,
    marginLeft: space.md,
  },
  groupFooter: {
    ...type.footnote,
    color: color.textMuted,
    lineHeight: 18,
    marginTop: space.sm,
    marginHorizontal: space.md,
  },
  card: { backgroundColor: color.paper, borderRadius: radius.card, overflow: "hidden" },
  rowDivider: { borderTopWidth: hairline, borderTopColor: color.separator },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: space.md,
    minHeight: HIT_SIZE,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  rowDisabled: { opacity: 0.4 },
  rowLabel: { ...type.callout, color: color.text },
  rowLabelDestructive: { color: color.destructive },
  rowValue: {
    ...type.footnote,
    fontFamily: font.dataMedium,
    color: color.textMuted,
    flexShrink: 1,
    textAlign: "right",
  },
  prose: { paddingHorizontal: space.lg, paddingVertical: space.md },
  paragraph: { ...type.footnote, color: color.textMuted, lineHeight: 19 },
});

import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { X } from "lucide-react-native";

import BottomSheet from "./BottomSheet";
import LineBadge from "./LineBadge";
import PressableScale from "./PressableScale";
import { fetchDepartures } from "../api";
import { color, font, hairline, radius, space, type } from "../theme";

const REFRESH_MS = 30000;

/**
 * The departure board.
 *
 * The backend has served real, calendar-filtered departures this whole time and
 * nothing ever called it — tapping a stop wrote to the console. This is the
 * answer to the only question most people open a transit app to ask, so it gets
 * the one piece of visual boldness in the product: the amber board you already
 * read while standing at the pole.
 *
 * It clears the floating tab bar by being told how much room that takes
 * (`bottomOffset`) rather than by a hardcoded number that quietly went wrong
 * every time the bar changed height.
 */
export default function DeparturesSheet({ stop, onClose, bottomOffset = 0 }) {
  const [state, setState] = useState({ status: "loading", departures: [] });

  const load = useCallback(
    async (signal, quiet) => {
      if (!stop?.id) return;
      if (!quiet) setState((previous) => ({ ...previous, status: "loading" }));

      try {
        const data = await fetchDepartures(stop.id, { signal, retries: 1 });
        setState({
          status: "ready",
          departures: Array.isArray(data.departures) ? data.departures : [],
        });
      } catch (error) {
        if (error.name !== "AbortError") setState({ status: "error", departures: [] });
      }
    },
    [stop?.id],
  );

  useEffect(() => {
    if (!stop?.id) return undefined;

    const controller = new AbortController();
    load(controller.signal, false);
    const id = setInterval(() => load(controller.signal, true), REFRESH_MS);

    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, [stop?.id, load]);

  if (!stop) return null;

  const header = (
    <View style={styles.header}>
      <View style={styles.headerText}>
        <Text style={styles.eyebrow}>Najbliższe odjazdy</Text>
        <Text style={styles.stopName} numberOfLines={1}>
          {stop.name}
        </Text>
      </View>
      <PressableScale
        onPress={onClose}
        hitSlop={12}
        style={styles.close}
        accessibilityRole="button"
        accessibilityLabel="Zamknij odjazdy"
      >
        <X size={18} color={color.textOnDarkMuted} strokeWidth={2.5} />
      </PressableScale>
    </View>
  );

  return (
    <BottomSheet header={header} onClose={onClose} bottomOffset={bottomOffset}>
      {state.status === "loading" && (
        <View style={styles.centre}>
          <ActivityIndicator color={color.amber} />
        </View>
      )}

      {state.status === "error" && (
        <View style={styles.centre}>
          <Text style={styles.message}>Nie udało się pobrać odjazdów.</Text>
          <PressableScale onPress={() => load(undefined, false)} style={styles.retry}>
            <Text style={styles.retryText}>Spróbuj ponownie</Text>
          </PressableScale>
        </View>
      )}

      {state.status === "ready" && state.departures.length === 0 && (
        <View style={styles.centre}>
          <Text style={styles.message}>Brak odjazdów w ciągu najbliższych dwóch godzin.</Text>
        </View>
      )}

      {state.status === "ready" && state.departures.length > 0 && (
        <ScrollView
          style={styles.list}
          contentContainerStyle={{ paddingBottom: space.sm }}
          showsVerticalScrollIndicator={false}
        >
          {state.departures.map((departure, index) => {
            const minutes = Math.round((departure.inSeconds ?? 0) / 60);
            return (
              <View
                key={`${departure.tripId}-${departure.departure}-${index}`}
                style={[styles.row, index === 0 && styles.rowFirst]}
              >
                <LineBadge line={departure.line} type={departure.type} size="sm" />
                <View style={styles.rowText}>
                  <Text style={styles.headsign} numberOfLines={1}>
                    {departure.headsign || "—"}
                  </Text>
                  {departure.departure ? (
                    <Text style={styles.scheduled}>{departure.departure.slice(0, 5)}</Text>
                  ) : null}
                </View>
                <Text style={styles.minutes} allowFontScaling={false}>
                  {minutes <= 0 ? "teraz" : minutes}
                </Text>
                {minutes > 0 && <Text style={styles.unit}>min</Text>}
              </View>
            );
          })}
        </ScrollView>
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.md,
  },
  headerText: { flex: 1 },
  eyebrow: {
    ...type.caption,
    color: color.textOnDarkMuted,
    textTransform: "uppercase",
  },
  stopName: {
    fontFamily: font.data,
    fontSize: 22,
    color: color.textOnDark,
    marginTop: 2,
    includeFontPadding: false,
  },
  close: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.inkRaised,
  },
  list: { borderTopWidth: hairline, borderTopColor: color.inkLine },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderTopWidth: hairline,
    borderTopColor: color.inkLine,
  },
  rowFirst: { borderTopWidth: 0 },
  rowText: { flex: 1 },
  headsign: { ...type.callout, color: color.textOnDark },
  // The timetabled time, for when "8 min" is not enough to plan around.
  scheduled: {
    fontFamily: font.dataMedium,
    fontSize: 12,
    color: color.textOnDarkMuted,
    marginTop: 1,
    fontVariant: ["tabular-nums"],
  },
  // Amber is reserved for the countdown. Nothing else in the app uses it, so
  // the eye goes straight to the number that decides whether you run.
  minutes: {
    fontFamily: font.data,
    fontSize: 26,
    color: color.amber,
    includeFontPadding: false,
    fontVariant: ["tabular-nums"],
  },
  unit: {
    fontFamily: font.dataMedium,
    fontSize: 13,
    color: color.amber,
    opacity: 0.7,
    marginLeft: -6,
  },
  centre: {
    paddingVertical: space.xl,
    paddingHorizontal: space.lg,
    alignItems: "center",
    gap: space.md,
  },
  message: { ...type.callout, color: color.textOnDarkMuted, textAlign: "center" },
  retry: {
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    backgroundColor: color.inkRaised,
  },
  retryText: { ...type.body, color: color.textOnDark },
});

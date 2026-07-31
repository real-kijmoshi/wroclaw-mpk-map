import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { X } from "lucide-react-native";

import LineBadge from "./LineBadge";
import { fetchDepartures } from "../api";
import { color, font, radius, shadow, space, type } from "../theme";

const REFRESH_MS = 30000;

/**
 * The departure board.
 *
 * The backend has served real, calendar-filtered departures this whole time and
 * nothing ever called it — tapping a stop wrote to the console. This is the
 * answer to the only question most people open a transit app to ask, so it gets
 * the one piece of visual boldness in the product: the amber board you already
 * read while standing at the pole.
 */
export default function DeparturesSheet({ stop, onClose }) {
  const [state, setState] = useState({ status: "loading", departures: [] });
  const slide = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.spring(slide, {
      toValue: stop ? 0 : 1,
      useNativeDriver: true,
      damping: 22,
      stiffness: 220,
      mass: 0.7,
    }).start();
  }, [stop, slide]);

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

  return (
    <Animated.View
      style={[
        styles.sheet,
        {
          transform: [
            { translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [0, 420] }) },
          ],
        },
      ]}
    >
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.eyebrow}>Najbliższe odjazdy</Text>
          <Text style={styles.stopName} numberOfLines={1}>
            {stop.name}
          </Text>
        </View>
        <Pressable
          onPress={onClose}
          hitSlop={12}
          style={styles.close}
          accessibilityRole="button"
          accessibilityLabel="Zamknij odjazdy"
        >
          <X size={20} color={color.textOnDarkMuted} />
        </Pressable>
      </View>

      {state.status === "loading" && (
        <View style={styles.centre}>
          <ActivityIndicator color={color.amber} />
        </View>
      )}

      {state.status === "error" && (
        <View style={styles.centre}>
          <Text style={styles.message}>Nie udało się pobrać odjazdów.</Text>
          <Pressable onPress={() => load(undefined, false)} style={styles.retry}>
            <Text style={styles.retryText}>Spróbuj ponownie</Text>
          </Pressable>
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
                <Text style={styles.headsign} numberOfLines={1}>
                  {departure.headsign || "—"}
                </Text>
                <Text style={styles.minutes} allowFontScaling={false}>
                  {minutes <= 0 ? "teraz" : minutes}
                </Text>
                {minutes > 0 && <Text style={styles.unit}>min</Text>}
              </View>
            );
          })}
        </ScrollView>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: "absolute",
    left: space.md,
    right: space.md,
    bottom: 92,
    maxHeight: 340,
    backgroundColor: color.ink,
    borderRadius: radius.lg,
    paddingBottom: space.sm,
    overflow: "hidden",
    ...shadow.card,
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.md,
  },
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
  close: { padding: space.xs },
  list: { borderTopWidth: 1, borderTopColor: color.inkLine },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderTopWidth: 1,
    borderTopColor: color.inkLine,
  },
  rowFirst: { borderTopWidth: 0 },
  headsign: {
    flex: 1,
    ...type.body,
    color: color.textOnDark,
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
  message: { ...type.body, color: color.textOnDarkMuted, textAlign: "center" },
  retry: {
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    backgroundColor: color.inkRaised,
  },
  retryText: { ...type.small, color: color.textOnDark },
});

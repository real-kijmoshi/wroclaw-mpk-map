import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { X } from "lucide-react-native";

import LineBadge from "./LineBadge";
import { fetchDepartures } from "../api";
import { color, font, layout, radius, shadow, space, type } from "../theme";

/** How often to ask the server for a fresh board. */
const REFRESH_MS = 30_000;
/** How often to re-derive the countdown locally between those requests. */
const TICK_MS = 5_000;

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
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [state, setState] = useState({ status: "loading", departures: [], fetchedAt: Date.now() });
  const [now, setNow] = useState(() => Date.now());

  // The sheet outlives `stop` by one animation: closing used to unmount it on
  // the same frame the state cleared, so the slide-out never played and the
  // board simply blinked out of existence.
  const [shown, setShown] = useState(stop);
  const slide = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (stop) setShown(stop);
    Animated.spring(slide, {
      toValue: stop ? 0 : 1,
      useNativeDriver: true,
      damping: 22,
      stiffness: 220,
      mass: 0.7,
    }).start(({ finished }) => {
      if (finished && !stop) setShown(null);
    });
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
          // `inSeconds` is measured from when the server answered, so the
          // countdown has to be re-derived against this, not against the clock.
          fetchedAt: Date.now(),
        });
      } catch (error) {
        if (error.name !== "AbortError") {
          setState({ status: "error", departures: [], fetchedAt: Date.now() });
        }
      }
    },
    [stop?.id],
  );

  useEffect(() => {
    if (!stop?.id) return undefined;

    const controller = new AbortController();
    load(controller.signal, false);
    const request = setInterval(() => load(controller.signal, true), REFRESH_MS);
    // Without this the board froze between requests: a departure fetched as
    // "3 min" still read 3 min half a minute later, then jumped two.
    const tick = setInterval(() => setNow(Date.now()), TICK_MS);

    return () => {
      controller.abort();
      clearInterval(request);
      clearInterval(tick);
    };
  }, [stop?.id, load]);

  const rows = useMemo(() => {
    const elapsed = (now - state.fetchedAt) / 1000;
    return state.departures.map((departure, index) => ({
      key: `${departure.tripId}-${departure.departure}-${index}`,
      line: departure.line,
      type: departure.type,
      headsign: departure.headsign,
      // "14:32:00" is what the timetable says; the countdown is what you act on.
      scheduled: String(departure.departure ?? "").slice(0, 5),
      minutes: Math.round(((departure.inSeconds ?? 0) - elapsed) / 60),
    }));
  }, [state.departures, state.fetchedAt, now]);

  if (!shown) return null;

  return (
    <Animated.View
      pointerEvents={stop ? "auto" : "none"}
      style={[
        styles.sheet,
        {
          bottom: layout.tabBar + insets.bottom + space.md,
          maxHeight: Math.min(360, height * 0.45),
          transform: [
            { translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [0, 460] }) },
          ],
        },
      ]}
    >
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.eyebrow}>Najbliższe odjazdy</Text>
          <Text style={styles.stopName} numberOfLines={1}>
            {shown.name}
          </Text>
        </View>
        <Pressable
          onPress={onClose}
          hitSlop={12}
          style={({ pressed }) => [styles.close, pressed && styles.closePressed]}
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
          <Pressable
            onPress={() => load(undefined, false)}
            style={({ pressed }) => [styles.retry, pressed && styles.closePressed]}
            accessibilityRole="button"
          >
            <Text style={styles.retryText}>Spróbuj ponownie</Text>
          </Pressable>
        </View>
      )}

      {state.status === "ready" && rows.length === 0 && (
        <View style={styles.centre}>
          <Text style={styles.message}>Brak odjazdów w ciągu najbliższych dwóch godzin.</Text>
        </View>
      )}

      {state.status === "ready" && rows.length > 0 && (
        <ScrollView
          style={styles.list}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        >
          {rows.map((row, index) => (
            <View key={row.key} style={[styles.row, index === 0 && styles.rowFirst]}>
              <LineBadge line={row.line} type={row.type} size="sm" />
              <View style={styles.rowText}>
                <Text style={styles.headsign} numberOfLines={1}>
                  {row.headsign || "—"}
                </Text>
                {row.scheduled ? <Text style={styles.scheduled}>{row.scheduled}</Text> : null}
              </View>
              <Text style={styles.minutes} allowFontScaling={false}>
                {row.minutes <= 0 ? "teraz" : row.minutes}
              </Text>
              {row.minutes > 0 && <Text style={styles.unit}>min</Text>}
            </View>
          ))}
        </ScrollView>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // `bottom` and `maxHeight` are supplied at render time — they depend on the
  // safe-area inset and the window, and hardcoding them put the sheet 34pt off
  // the tab bar on anything without a home indicator.
  sheet: {
    position: "absolute",
    left: space.md,
    right: space.md,
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
  close: { padding: space.xs },
  closePressed: { opacity: 0.6 },
  list: { borderTopWidth: 1, borderTopColor: color.inkLine },
  listContent: { paddingBottom: space.sm },
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
  rowText: { flex: 1 },
  headsign: {
    ...type.body,
    color: color.textOnDark,
  },
  scheduled: {
    ...type.caption,
    fontFamily: font.dataMedium,
    letterSpacing: 0,
    color: color.textOnDarkMuted,
    marginTop: 1,
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

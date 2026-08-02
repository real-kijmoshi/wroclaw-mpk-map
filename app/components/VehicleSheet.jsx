import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { X } from "lucide-react-native";

import BottomSheet from "./BottomSheet";
import LineBadge from "./LineBadge";
import PressableScale from "./PressableScale";
import { color, font, hairline, radius, space, type } from "../theme";

/**
 * Where this vehicle is going, and when it gets there.
 *
 * The counterpart of the departures board: that one answers "what comes to
 * this stop", this one answers "where is this tram going and when does it
 * reach mine" — the question you ask once you can see the thing on the map.
 *
 * Every number here comes from the vehicle's real position on its route, not
 * from the timetable alone, so a delayed vehicle reads as delayed. Where the
 * server could not identify the run it says so instead of inventing times: no
 * scheduled column, only the minutes still to go.
 */
export default function VehicleSheet({
  vehicle,
  trip,
  status = "loading",
  onRetry,
  onClose,
  bottomOffset = 0,
}) {
  if (!vehicle) return null;

  const summary = vehicle.trip ?? null;
  const towards = trip?.towards ?? summary?.towards ?? summary?.headsign ?? null;
  const previous = trip?.previousStops ?? [];
  const next = trip?.nextStops ?? [];

  const header = (
    <View style={styles.header}>
      <LineBadge line={vehicle.line} type={vehicle.type} size="md" />
      <View style={styles.headerText}>
        <Text style={styles.eyebrow}>Kierunek</Text>
        <Text style={styles.destination} numberOfLines={1}>
          {towards ?? "Nieznany"}
        </Text>
      </View>
      <PressableScale
        onPress={onClose}
        hitSlop={12}
        style={styles.close}
        accessibilityRole="button"
        accessibilityLabel="Zamknij kurs"
      >
        <X size={18} color={color.textOnDarkMuted} strokeWidth={2.5} />
      </PressableScale>
    </View>
  );

  return (
    <BottomSheet header={header} onClose={onClose} bottomOffset={bottomOffset} maxHeight={380}>
      <View style={styles.status}>
        <Text style={styles.delay}>{delayLabel(trip ?? summary)}</Text>
        {locationLabel(trip, summary) ? (
          <Text style={styles.location} numberOfLines={1}>
            {locationLabel(trip, summary)}
          </Text>
        ) : null}
      </View>

      {status === "loading" && !trip && (
        <View style={styles.centre}>
          <ActivityIndicator color={color.amber} />
        </View>
      )}

      {status === "error" && (
        <View style={styles.centre}>
          <Text style={styles.message}>Nie udało się pobrać kursu.</Text>
          <PressableScale onPress={onRetry} style={styles.retry}>
            <Text style={styles.retryText}>Spróbuj ponownie</Text>
          </PressableScale>
        </View>
      )}

      {status === "ready" && next.length === 0 && (
        <View style={styles.centre}>
          <Text style={styles.message}>
            {trip?.onRoute === false
              ? "Pojazd jest poza trasą, więc nie znamy kolejnych przystanków."
              : "Brak kolejnych przystanków — to koniec trasy."}
          </Text>
        </View>
      )}

      {next.length > 0 && (
        <ScrollView
          style={styles.list}
          contentContainerStyle={{ paddingBottom: space.sm }}
          showsVerticalScrollIndicator={false}
        >
          {previous.map((stop) => (
            <StopRow key={`passed-${stop.id}-${stop.sequence}`} stop={stop} passed />
          ))}
          {next.map((stop) => (
            <StopRow key={`next-${stop.id}-${stop.sequence}`} stop={stop} />
          ))}
        </ScrollView>
      )}
    </BottomSheet>
  );
}

function StopRow({ stop, passed = false }) {
  const minutes = Math.round((stop.etaSeconds ?? 0) / 60);

  return (
    <View style={[styles.row, passed && styles.rowPassed]}>
      <View style={[styles.track, passed && styles.trackPassed]}>
        <View style={[styles.dot, passed && styles.dotPassed]} />
      </View>
      <View style={styles.rowText}>
        <Text style={[styles.stopName, passed && styles.stopNamePassed]} numberOfLines={1}>
          {stop.name}
        </Text>
        {stop.scheduled ? (
          <Text style={styles.scheduled}>{stop.scheduled.slice(0, 5)}</Text>
        ) : null}
      </View>
      {passed ? (
        <Text style={styles.ago}>{agoLabel(stop.agoSeconds)}</Text>
      ) : (
        <>
          <Text style={styles.minutes} allowFontScaling={false}>
            {minutes <= 0 ? "teraz" : minutes}
          </Text>
          {minutes > 0 && <Text style={styles.unit}>min</Text>}
        </>
      )}
    </View>
  );
}

/** "3 min spóźnienia" is what a rider cares about; the sign is not obvious, so spell it out. */
function delayLabel(trip) {
  if (!trip || trip.delaySeconds === null || trip.delaySeconds === undefined) {
    return "Rozkład tego kursu nieznany";
  }

  const minutes = Math.round(trip.delaySeconds / 60);
  if (minutes >= 1) return `Spóźniony ${minutes} min`;
  if (minutes <= -1) return `Przed czasem ${Math.abs(minutes)} min`;
  return "Zgodnie z rozkładem";
}

/** Where the vehicle is right now, in the words of the stops around it. */
function locationLabel(trip, summary) {
  const atStop = trip?.atStop?.name ?? summary?.atStop;
  if (atStop) return `Na przystanku ${atStop}`;

  const previous = trip?.previousStop?.name ?? summary?.previousStop?.name;
  return previous ? `Minął ${previous}` : null;
}

function agoLabel(seconds) {
  const minutes = Math.round((seconds ?? 0) / 60);
  return minutes <= 0 ? "przed chwilą" : `${minutes} min temu`;
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.md,
  },
  headerText: { flex: 1 },
  eyebrow: { ...type.caption, color: color.textOnDarkMuted, textTransform: "uppercase" },
  destination: {
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

  status: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
  },
  // Deliberately not amber: this is a state, not a countdown.
  delay: { ...type.footnote, color: color.textOnDark },
  location: { ...type.footnote, color: color.textOnDarkMuted, flexShrink: 1 },

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
  rowPassed: { opacity: 0.55 },
  // A thin rail down the left edge turns the list into the route it describes.
  track: { width: 12, alignItems: "center" },
  trackPassed: { opacity: 0.6 },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: color.textOnDark,
  },
  dotPassed: { backgroundColor: "transparent", borderWidth: 2, borderColor: color.textOnDarkMuted },
  rowText: { flex: 1 },
  stopName: { ...type.callout, color: color.textOnDark },
  stopNamePassed: { color: color.textOnDarkMuted },
  scheduled: {
    fontFamily: font.dataMedium,
    fontSize: 12,
    color: color.textOnDarkMuted,
    marginTop: 1,
    fontVariant: ["tabular-nums"],
  },
  ago: { ...type.footnote, color: color.textOnDarkMuted },
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

import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

const formatClock = (date) =>
  date.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** "12 s temu" reads better than a wall-clock time for a freshness indicator. */
const formatAge = (isoString, now) => {
  if (!isoString) return "brak danych";
  const updatedAt = Date.parse(isoString);
  if (!Number.isFinite(updatedAt)) return "brak danych";

  const seconds = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (seconds < 60) return `${seconds} s temu`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min temu`;
  return formatClock(new Date(updatedAt));
};

export default function InfoBox({ lastUpdated, vehicleCount = 0, totalCount = 0, error }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const updatedAt = lastUpdated ? Date.parse(lastUpdated) : Number.NaN;
  const stale = !Number.isFinite(updatedAt) || now - updatedAt > 60_000;

  return (
    <View style={[styles.container, (error || stale) && styles.containerWarning]}>
      <Text style={styles.time}>{formatClock(new Date(now))}</Text>
      <Text style={styles.detail}>
        {error ?? `${vehicleCount} z ${totalCount} pojazdów • ${formatAge(lastUpdated, now)}`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignSelf: "flex-start",
    marginTop: 8,
    marginLeft: 16,
    backgroundColor: "rgba(0, 117, 255, 0.92)",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
  },
  containerWarning: {
    backgroundColor: "rgba(232, 93, 117, 0.94)",
  },
  time: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "700",
  },
  detail: {
    color: "rgba(255,255,255,0.9)",
    fontSize: 12,
    marginTop: 2,
  },
});

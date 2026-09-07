import Ionicons from '@expo/vector-icons/Ionicons';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { LineBadge } from './line-badge';
import { ThemedText } from './themed-text';
import { CloseButton } from './vehicle-details';
import { Motion, Radius, Space } from '@/constants/design';
import { useTheme } from '@/hooks/use-theme';
import type { Departure, Departures, Stop } from '@/lib/api';
import { favouritesStore, useFavourites } from '@/lib/favourites';
import { etaParts, formatDistance, formatScheduled } from '@/lib/format';
import { tapped } from '@/lib/haptics';
import {
  alarmId,
  cancelDepartureAlarm,
  pendingAlarms,
  scheduleDepartureAlarm,
} from '@/lib/notifications';
import { distanceMeters } from '@/lib/stops-api';

/**
 * The selected stop, as the sheet's header.
 *
 * Built from the stop the map handed over rather than from the departures
 * payload, so the name is on screen the moment it is tapped instead of after
 * the board has loaded.
 */
export function StopSummary({
  stop,
  userPosition,
  onClose,
}: {
  stop: Stop;
  /** Where the rider is, when that is known. */
  userPosition: { lat: number; lon: number } | null;
  onClose: () => void;
}) {
  const theme = useTheme();

  /**
   * How far this stop is *from the rider* — measured here, never taken from
   * `stop.distance`.
   *
   * That field is whatever the query that produced the stop measured from, and
   * since the stops layer started following the map it is usually the centre of
   * the screen. Printing it beside "Odjazdy na żywo" read as "250 m from you"
   * while meaning "250 m from the middle of the map". With no position known
   * there is no honest number, so none is shown.
   */
  const distance = userPosition
    ? formatDistance(distanceMeters(userPosition.lat, userPosition.lon, stop.lat, stop.lon))
    : null;

  return (
    <View style={styles.summary}>
      <View style={[styles.mark, { backgroundColor: theme.backgroundElement }]}>
        <View style={[styles.markInner, { borderColor: theme.accent }]} />
      </View>

      <View style={styles.summaryText}>
        <ThemedText type="headline" numberOfLines={1}>
          {stop.name}
        </ThemedText>
        <ThemedText type="footnote" themeColor="textSecondary" numberOfLines={1}>
          {['Odjazdy na żywo', distance].filter(Boolean).join(' · ')}
        </ThemedText>
      </View>

      <FavouriteStar stop={stop} />
      <CloseButton onPress={onClose} label="Zamknij odjazdy" />
    </View>
  );
}

/**
 * Pin this stop, or unpin it.
 *
 * It lives on the summary rather than in a menu because pinning is a decision
 * made *while looking at the board* — "this is the one I want tomorrow
 * morning" — and a control two taps away is one nobody finds. Filled star for
 * pinned, outline for not: the same affordance every list on the phone uses,
 * so it needs no label to be understood.
 */
function FavouriteStar({ stop }: { stop: Stop }) {
  const theme = useTheme();
  const favourites = useFavourites();
  const pinned = favourites.stops.some((entry) => entry.id === stop.id);

  return (
    <Pressable
      onPress={() => {
        favouritesStore.toggleStop(stop);
        tapped();
      }}
      accessibilityRole="button"
      accessibilityLabel={pinned ? 'Usuń z ulubionych' : 'Dodaj do ulubionych'}
      accessibilityState={{ selected: pinned }}
      hitSlop={8}
      style={({ pressed }) => [
        styles.close,
        { backgroundColor: theme.backgroundElement },
        pressed && styles.pressed,
      ]}>
      <Ionicons
        name={pinned ? 'star' : 'star-outline'}
        size={17}
        color={pinned ? theme.amber : theme.textSecondary}
      />
    </Pressable>
  );
}

export type StopDetailsProps = {
  data: Departures | null;
  loading: boolean;
  error: Error | null;
};

/** The next departures from one stop — the board, as it would read at the stop. */
export function StopDetails({ data, loading, error }: StopDetailsProps) {
  const theme = useTheme();

  /*
   * Which departures already have an alarm.
   *
   * Read from the OS rather than kept in app state: a scheduled notification
   * outlives the process, so a rider who set one, closed the app and came back
   * must see it still set. The set is keyed by `alarmId`, which is the same
   * identifier the notification itself carries.
   */
  const [alarms, setAlarms] = useState<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    pendingAlarms().then((pending) => {
      if (!cancelled) setAlarms(pending);
    });
    return () => {
      cancelled = true;
    };
  }, [data?.stop.id]);

  const stopId = data?.stop.id;
  const stopName = data?.stop.name;

  const toggleAlarm = useCallback(
    async (departure: Departure) => {
      if (!stopId || !stopName) return;
      const id = alarmId(stopId, departure.tripId);
      tapped();

      if (alarms.has(id)) {
        await cancelDepartureAlarm(stopId, departure.tripId);
        setAlarms((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
        return;
      }

      const warning = await scheduleDepartureAlarm(stopId, {
        line: departure.line,
        headsign: departure.headsign,
        stopName,
        inSeconds:
          departure.realtime && departure.predictedInSeconds != null
            ? departure.predictedInSeconds
            : departure.inSeconds,
        tripId: departure.tripId,
      });
      // Null means it could not be set — too close to departure, or permission
      // refused. The bell simply does not light, which is the honest answer;
      // a toast claiming success would be worse than the silence.
      if (warning !== null) setAlarms((current) => new Set(current).add(id));
    },
    [alarms, stopId, stopName],
  );

  if (loading && !data) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
      </View>
    );
  }

  if (error || !data) {
    return (
      <View style={styles.centered}>
        <ThemedText themeColor="textSecondary">Nie udało się pobrać odjazdów</ThemedText>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}>
      {data.departures.length === 0 ? (
        <View style={[styles.empty, { backgroundColor: theme.backgroundCard }]}>
          <ThemedText type="callout" themeColor="textSecondary">
            Brak zaplanowanych odjazdów w najbliższej dobie.
          </ThemedText>
          {!!data.stop.lines?.length && (
            <ThemedText type="footnote" themeColor="textSecondary">
              Obsługiwane linie: {data.stop.lines.join(', ')}
            </ThemedText>
          )}
        </View>
      ) : (
        <View style={[styles.board, { backgroundColor: theme.backgroundCard }]}>
          {data.departures.slice(0, 12).map((departure, index) => {
            const seconds =
              departure.realtime && departure.predictedInSeconds != null
                ? departure.predictedInSeconds
                : departure.inSeconds;
            const eta = etaParts(seconds);
            const scheduled = formatScheduled(departure.departure);

            return (
              <View
                key={`${departure.tripId}-${departure.departure}`}
                style={[
                  styles.row,
                  index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.separator },
                ]}>
                <LineBadge line={departure.line} type={departure.type} size="small" />

                <View style={styles.rowText}>
                  <View style={styles.headsign}>
                    <ThemedText type="callout" numberOfLines={1} style={styles.headsignText}>
                      {departure.headsign ?? '—'}
                    </ThemedText>
                    {/*
                      * Only drawn when the feed actually says yes. `null` is
                      * "unstated", and marking that as step-access would tell
                      * a wheelchair user a usable run is unusable.
                      */}
                    {departure.wheelchair === true && (
                      <Ionicons
                        name="accessibility"
                        size={13}
                        color={theme.textSecondary}
                        accessibilityLabel="Niskopodłogowy"
                      />
                    )}
                  </View>
                  {scheduled && (
                    <ThemedText type="footnote" themeColor="textSecondary" numberOfLines={1}>
                      {departure.serviceDay === 'tomorrow' ? 'Jutro · ' : null}
                      {scheduled}
                      {departure.realtime ? ' · ' : null}
                      {departure.realtime && (
                        <ThemedText type="footnote" color={theme.success}>
                          na żywo
                        </ThemedText>
                      )}
                    </ThemedText>
                  )}
                </View>

                {/* Amber is reserved for countdowns; nothing else competes. */}
                <View style={styles.eta}>
                  <ThemedText type="title" color={theme.amber} style={styles.etaValue}>
                    {eta.value}
                  </ThemedText>
                  {!!eta.unit && (
                    <ThemedText type="footnote" weight="semibold" color={theme.amber}>
                      {eta.unit}
                    </ThemedText>
                  )}
                </View>

                <AlarmBell
                  set={alarms.has(alarmId(data.stop.id, departure.tripId))}
                  onPress={() => toggleAlarm(departure)}
                />
              </View>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}

/**
 * Set a reminder to leave for this departure.
 *
 * A bell per row rather than one control for the board: the rider is picking a
 * *departure*, not a stop, and which one they want is exactly the decision the
 * board exists to support. Filled when set, so the state is legible without
 * opening anything.
 */
function AlarmBell({ set, onPress }: { set: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: set }}
      accessibilityLabel={set ? 'Wyłącz przypomnienie o odjeździe' : 'Przypomnij o odjeździe'}
      hitSlop={10}
      style={({ pressed }) => [styles.bell, pressed && styles.pressed]}>
      <Ionicons
        name={set ? 'notifications' : 'notifications-outline'}
        size={18}
        color={set ? theme.accent : theme.textTertiary}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  summary: { flexDirection: 'row', alignItems: 'center', gap: Space.md, paddingBottom: Space.md, minHeight: 48 },
  mark: { width: 38, height: 38, borderRadius: Radius.md, alignItems: 'center', justifyContent: 'center' },
  markInner: { width: 14, height: 14, borderRadius: Radius.pill, borderWidth: 4 },
  summaryText: { flex: 1, gap: 1, minWidth: 0 },
  scroll: { flex: 1 },
  content: { paddingHorizontal: Space.lg, paddingBottom: Space.xxl, gap: Space.md },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Space.xl },
  empty: { borderRadius: Radius.lg, padding: Space.lg, gap: Space.xs },
  board: { borderRadius: Radius.lg, paddingHorizontal: Space.lg },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    paddingVertical: Space.md,
    minHeight: 56,
  },
  rowText: { flex: 1, gap: 1, minWidth: 0 },
  headsign: { flexDirection: 'row', alignItems: 'center', gap: Space.xs },
  headsignText: { flexShrink: 1 },
  bell: { width: 32, minHeight: 32, alignItems: 'center', justifyContent: 'center' },
  eta: { flexDirection: 'row', alignItems: 'baseline', gap: 3 },
  etaValue: { fontVariant: ['tabular-nums'] },
  // Same round 30pt target as the close button it sits beside, so the pair
  // reads as one control group rather than two sizes of button.
  close: { width: 30, height: 30, borderRadius: Radius.pill, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: Motion.pressedOpacity },
});

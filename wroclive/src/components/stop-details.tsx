import Ionicons from '@expo/vector-icons/Ionicons';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { LineBadge } from './line-badge';
import { ThemedText } from './themed-text';
import { CloseButton, HeaderButton } from './vehicle-details';
import { Motion, Radius, Space } from '@/constants/design';
import { useTheme } from '@/hooks/use-theme';
import type { Departures, Stop } from '@/lib/api';
import { etaParts, formatDistance, formatScheduled } from '@/lib/format';
import { distanceMeters } from '@/lib/stops-api';
import { leaveInSeconds, leaveLabel, openWalkingDirections, walkSeconds } from '@/lib/walking';

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
  favourite,
  onToggleFavourite,
  onShare,
  onClose,
}: {
  stop: Stop;
  /** Where the rider is, when that is known. */
  userPosition: { lat: number; lon: number } | null;
  favourite: boolean;
  onToggleFavourite: () => void;
  onShare: () => void;
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

      <HeaderButton
        icon={favourite ? 'star' : 'star-outline'}
        // Amber is for countdowns; a lit star is told apart by its fill.
        color={favourite ? theme.text : undefined}
        label={favourite ? 'Usuń z ulubionych' : 'Dodaj do ulubionych'}
        selected={favourite}
        onPress={onToggleFavourite}
      />
      <HeaderButton icon="share-outline" label="Udostępnij przystanek" onPress={onShare} />
      <CloseButton onPress={onClose} label="Zamknij odjazdy" />
    </View>
  );
}

export type StopDetailsProps = {
  data: Departures | null;
  loading: boolean;
  error: Error | null;
  /** The stop the board is for — the walk is measured to it. */
  stop: Stop;
  /** Where the rider is, when known: turns the board into "when to leave". */
  userPosition: { lat: number; lon: number } | null;
  /** Seconds since `data` was fetched; the board counts down by this much between polls. */
  ageSeconds?: number;
};

/** A little more than one 30 s departures poll; past it the clock alone is not trusted. */
const MAX_LOCAL_COUNTDOWN_SECONDS = 40;

/** The next departures from one stop — the board, as it would read at the stop. */
export function StopDetails({ data, loading, error, stop, userPosition, ageSeconds = 0 }: StopDetailsProps) {
  const theme = useTheme();
  const walk = walkSeconds(userPosition, stop);

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
      {/* The walk first: with it, every row below answers "when do I leave"
          rather than "when does it go". Only when the rider is close enough
          for the estimate to mean something. */}
      {walk !== null && (
        <Pressable
          onPress={() => openWalkingDirections(stop)}
          accessibilityRole="button"
          accessibilityLabel={`Prowadź pieszo, około ${Math.max(1, Math.round(walk / 60))} minut`}
          accessibilityHint="Otwiera Mapy Apple"
          style={({ pressed }) => [
            styles.walk,
            { backgroundColor: theme.backgroundCard },
            pressed && styles.pressed,
          ]}>
          <Ionicons name="walk" size={18} color={theme.text} />
          <ThemedText type="callout" weight="semibold" style={styles.walkText}>
            Prowadź pieszo
          </ThemedText>
          <ThemedText type="callout" themeColor="textSecondary">
            ok. {Math.max(1, Math.round(walk / 60))} min
          </ThemedText>
          <Ionicons name="chevron-forward" size={16} color={theme.textTertiary} />
        </Pressable>
      )}
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
            const seconds = Math.max(
              0,
              (departure.realtime && departure.predictedInSeconds != null
                ? departure.predictedInSeconds
                : departure.inSeconds) - Math.min(Math.max(ageSeconds, 0), MAX_LOCAL_COUNTDOWN_SECONDS),
            );
            const eta = etaParts(seconds);
            const scheduled = formatScheduled(departure.departure);
            const leave = walk === null ? null : leaveLabel(leaveInSeconds(seconds, walk));

            return (
              <View
                key={`${departure.tripId}-${departure.departure}`}
                style={[
                  styles.row,
                  index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.separator },
                  // Still listed — it is on the board at the stop too — but it
                  // steps back so the first catchable one leads.
                  leave?.missed && styles.missed,
                ]}>
                <LineBadge line={departure.line} type={departure.type} size="small" />

                <View style={styles.rowText}>
                  <ThemedText type="callout" numberOfLines={1}>
                    {departure.headsign ?? '—'}
                  </ThemedText>
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
                  {leave && (
                    <ThemedText type="footnote" weight="semibold" themeColor="textSecondary" numberOfLines={1}>
                      {leave.text}
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
              </View>
            );
          })}
        </View>
      )}
    </ScrollView>
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
  eta: { flexDirection: 'row', alignItems: 'baseline', gap: 3 },
  etaValue: { fontVariant: ['tabular-nums'] },
  missed: { opacity: 0.45 },
  walk: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    borderRadius: Radius.lg,
    paddingHorizontal: Space.lg,
    minHeight: 52,
  },
  walkText: { flex: 1 },
  pressed: { opacity: Motion.pressedOpacity },
});

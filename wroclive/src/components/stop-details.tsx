import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';

import { LineBadge } from './line-badge';
import { ThemedText } from './themed-text';
import { CloseButton } from './vehicle-details';
import { Radius, Space } from '@/constants/design';
import { useTheme } from '@/hooks/use-theme';
import type { Departures, Stop } from '@/lib/api';
import { etaParts, formatDistance, formatScheduled } from '@/lib/format';
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

      <CloseButton onPress={onClose} label="Zamknij odjazdy" />
    </View>
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
});

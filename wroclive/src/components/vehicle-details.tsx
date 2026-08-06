import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';

import { LineBadge } from './line-badge';
import { ThemedText } from './themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { VehicleDetail } from '@/lib/api';
import { etaParts, formatDelay, formatScheduled } from '@/lib/format';
import { colorFor } from '@/lib/lines';

export type VehicleDetailsProps = {
  detail: VehicleDetail | null;
  loading: boolean;
  error: Error | null;
};

/**
 * One vehicle: where it is going, how late it is, and what it reaches when.
 *
 * The server infers the run from the position alone — MPK's feed carries no
 * trip id — and says so when it cannot. When `scheduleMatched` is false there
 * is no delay and no clock time to show, only the remaining running time, and
 * this screen says that rather than inventing a number.
 */
export function VehicleDetails({ detail, loading, error }: VehicleDetailsProps) {
  const theme = useTheme();

  if (loading && !detail) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
      </View>
    );
  }

  if (error || !detail) {
    return (
      <View style={styles.centered}>
        <ThemedText themeColor="textSecondary">
          {error ? 'Nie udało się pobrać pojazdu' : 'Pojazd nie jest już śledzony'}
        </ThemedText>
      </View>
    );
  }

  const { vehicle, trip } = detail;
  const delay = formatDelay(trip?.delaySeconds);
  const delayColor =
    delay.tone === 'late' ? theme.danger : delay.tone === 'early' ? theme.success : theme.textSecondary;

  const stops = trip?.nextStops ?? [];
  const lineColor = colorFor(vehicle.type);

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}>
      <View style={styles.header}>
        <LineBadge line={vehicle.line} type={vehicle.type} size="large" />
        <View style={styles.headerText}>
          <ThemedText type="defaultSemiBold" numberOfLines={1}>
            {trip?.towards ?? trip?.headsign ?? 'Kierunek nieznany'}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
            {trip?.atStop
              ? `Na przystanku ${trip.atStop.name}`
              : trip?.previousStop
                ? `Minął ${trip.previousStop.name}`
                : 'W trasie'}
          </ThemedText>
        </View>
      </View>

      <View style={[styles.statusRow, { borderColor: theme.separator }]}>
        <View style={styles.statusItem}>
          <ThemedText type="small" themeColor="textSecondary">
            Punktualność
          </ThemedText>
          <ThemedText type="defaultSemiBold" style={{ color: delayColor }}>
            {delay.text}
          </ThemedText>
        </View>
        <View style={[styles.divider, { backgroundColor: theme.separator }]} />
        <View style={styles.statusItem}>
          <ThemedText type="small" themeColor="textSecondary">
            Pozostało przystanków
          </ThemedText>
          <ThemedText type="defaultSemiBold">{trip?.stopsAhead ?? '—'}</ThemedText>
        </View>
      </View>

      {!trip?.onRoute && (
        <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
          Pojazd jest poza trasą — możliwy objazd. Lista przystanków może być niedokładna.
        </ThemedText>
      )}

      {stops.length === 0 ? (
        <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
          Brak danych o kolejnych przystankach.
        </ThemedText>
      ) : (
        <View style={styles.timeline}>
          {stops.map((stop, index) => {
            const eta = etaParts(stop.etaSeconds);
            const scheduled = formatScheduled(stop.scheduled);
            const first = index === 0;

            return (
              <View key={`${stop.id}-${stop.sequence}`} style={styles.stopRow}>
                <View style={styles.rail}>
                  {index > 0 && <View style={[styles.railLine, { backgroundColor: lineColor }]} />}
                  <View
                    style={[
                      styles.railDot,
                      {
                        backgroundColor: first ? lineColor : theme.background,
                        borderColor: lineColor,
                      },
                    ]}
                  />
                  {index < stops.length - 1 && (
                    <View style={[styles.railLine, styles.railLineBottom, { backgroundColor: lineColor }]} />
                  )}
                </View>

                <View style={styles.stopText}>
                  <ThemedText
                    type={first ? 'defaultSemiBold' : 'default'}
                    numberOfLines={1}>
                    {stop.name}
                  </ThemedText>
                  {scheduled && (
                    <ThemedText type="small" themeColor="textSecondary">
                      wg rozkładu {scheduled}
                    </ThemedText>
                  )}
                </View>

                {/* Amber is reserved for countdowns; nothing else competes with it. */}
                <View style={styles.eta}>
                  <ThemedText
                    type="defaultSemiBold"
                    style={[styles.etaValue, { color: theme.amber }]}>
                    {eta.value}
                  </ThemedText>
                  {!!eta.unit && (
                    <ThemedText type="small" style={{ color: theme.amber }}>
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
  scroll: { flex: 1 },
  content: { paddingHorizontal: Spacing.three, paddingBottom: Spacing.five, gap: Spacing.three },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.four },
  header: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  headerText: { flex: 1, gap: 2 },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: Spacing.two,
  },
  statusItem: { flex: 1, alignItems: 'center', gap: 2 },
  divider: { width: StyleSheet.hairlineWidth, alignSelf: 'stretch' },
  note: { paddingVertical: Spacing.one },
  timeline: { gap: 0 },
  stopRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three, minHeight: 52 },
  rail: { width: 14, alignItems: 'center', alignSelf: 'stretch' },
  railLine: { position: 'absolute', top: 0, height: '50%', width: 3, opacity: 0.45 },
  railLineBottom: { top: undefined, bottom: 0 },
  railDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 3,
    marginTop: 'auto',
    marginBottom: 'auto',
  },
  stopText: { flex: 1, gap: 1 },
  eta: { flexDirection: 'row', alignItems: 'baseline', gap: 3 },
  etaValue: { fontSize: 20, fontWeight: '700' },
});

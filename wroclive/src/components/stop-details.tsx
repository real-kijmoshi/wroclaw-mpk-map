import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';

import { LineBadge } from './line-badge';
import { ThemedText } from './themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { Departures } from '@/lib/api';
import { etaParts, formatScheduled } from '@/lib/format';

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
      <View style={styles.header}>
        <ThemedText type="defaultSemiBold" numberOfLines={2}>
          {data.stop.name}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          Najbliższe odjazdy
        </ThemedText>
      </View>

      {data.departures.length === 0 ? (
        <View style={styles.empty}>
          <ThemedText type="small" themeColor="textSecondary">
            Brak zaplanowanych odjazdów w najbliższej dobie.
          </ThemedText>
          {!!data.stop.lines?.length && (
            <ThemedText type="small" themeColor="textSecondary">
              Obsługiwane linie: {data.stop.lines.join(', ')}
            </ThemedText>
          )}
        </View>
      ) : (
        data.departures.map((departure) => {
          const seconds =
            departure.realtime && departure.predictedInSeconds != null
              ? departure.predictedInSeconds
              : departure.inSeconds;
          const eta = etaParts(seconds);
          const scheduled = formatScheduled(departure.departure);

          return (
            <View
              key={`${departure.tripId}-${departure.departure}`}
              style={[styles.row, { borderColor: theme.separator }]}>
              <LineBadge line={departure.line} type={departure.type} size="small" />

              <View style={styles.rowText}>
                <ThemedText numberOfLines={1}>
                  {departure.headsign ?? '—'}
                  {departure.operator ? ` · ${departure.operator}` : ''}
                </ThemedText>
                {scheduled && (
                  <ThemedText type="small" themeColor="textSecondary">
                    {departure.serviceDay === 'tomorrow' ? 'Jutro · ' : null}
                    {scheduled}
                    {departure.realtime ? ' · ' : null}
                    {departure.realtime && (
                      <ThemedText type="small" style={{ color: theme.success }}>
                        na żywo
                      </ThemedText>
                    )}
                  </ThemedText>
                )}
              </View>

              <View style={styles.eta}>
                <ThemedText type="defaultSemiBold" style={[styles.etaValue, { color: theme.amber }]}>
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
        })
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { paddingHorizontal: Spacing.three, paddingBottom: Spacing.five },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.four },
  header: { gap: 2, paddingBottom: Spacing.two },
  empty: { paddingVertical: Spacing.three, gap: Spacing.one },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.two,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  rowText: { flex: 1, gap: 1 },
  eta: { flexDirection: 'row', alignItems: 'baseline', gap: 3 },
  etaValue: { fontSize: 20, fontWeight: '700' },
});

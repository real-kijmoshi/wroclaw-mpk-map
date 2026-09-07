import Ionicons from '@expo/vector-icons/Ionicons';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { LineBadge } from './line-badge';
import { ThemedText } from './themed-text';
import { Motion, Radius, Space } from '@/constants/design';
import { useTheme } from '@/hooks/use-theme';
import type { VehicleDetail } from '@/lib/api';
import { etaParts, formatDelay, formatScheduled } from '@/lib/format';
import { colorFor } from '@/lib/lines';

/**
 * The selected vehicle, as the sheet's header.
 *
 * It is the part that stays on screen at every detent, so it carries only what
 * identifies the vehicle: which line, going where, and a way out. Everything
 * that needs reading — the delay, the stop list — is in the body below and
 * appears when the sheet is opened.
 */
export function VehicleSummary({
  detail,
  onClose,
}: {
  detail: VehicleDetail | null;
  onClose: () => void;
}) {
  const vehicle = detail?.vehicle ?? null;
  const trip = detail?.trip ?? null;

  return (
    <View style={styles.summary}>
      <LineBadge
        line={vehicle?.line ?? '—'}
        type={vehicle?.type}
        size="medium"
        style={styles.summaryBadge}
      />

      <View style={styles.summaryText}>
        <ThemedText type="headline" numberOfLines={1}>
          {trip?.towards ?? trip?.headsign ?? 'Kierunek nieznany'}
        </ThemedText>
        <ThemedText type="footnote" themeColor="textSecondary" numberOfLines={1}>
          {[
            vehicle?.operator,
            trip?.atStop
              ? `Na przystanku ${trip.atStop.name}`
              : trip?.previousStop
                ? `Minął ${trip.previousStop.name}`
                : 'W trasie',
          ]
            .filter(Boolean)
            .join(' · ')}
        </ThemedText>
      </View>

      <CloseButton onPress={onClose} label="Zamknij szczegóły pojazdu" />
    </View>
  );
}

export type VehicleDetailsProps = {
  detail: VehicleDetail | null;
  loading: boolean;
  error: Error | null;
  /** Recentres the already-highlighted route without leaving the live view. */
  onOpenRoute: () => void;
};

/**
 * One vehicle: where it is going, how late it is, and what it reaches when.
 *
 * The server infers the run from the position alone — MPK's feed carries no
 * trip id — and says so when it cannot. When the run cannot be identified there
 * is no delay and no clock time to show, only the remaining running time, and
 * this screen says that rather than inventing a number.
 */
export function VehicleDetails({ detail, loading, error, onOpenRoute }: VehicleDetailsProps) {
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
  const nextStop = trip?.nextStop ?? stops[0] ?? null;
  const nextEta = nextStop ? etaParts(nextStop.etaSeconds) : null;

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}>
      {/* The one number a rider is actually waiting for, given the room that
          deserves. Amber is reserved for countdowns and nothing competes. */}
      <View style={[styles.nextStop, { backgroundColor: theme.backgroundCard }]}>
        <View style={styles.nextStopCopy}>
          <ThemedText type="caption" themeColor="textSecondary">
            NASTĘPNY PRZYSTANEK
          </ThemedText>
          <ThemedText type="headline" numberOfLines={1}>
            {nextStop?.name ?? 'Brak danych o trasie'}
          </ThemedText>
          <View style={styles.metaRow}>
            <ThemedText type="footnote" weight="semibold" color={delayColor}>
              {delay.text}
            </ThemedText>
            <View style={[styles.metaDot, { backgroundColor: theme.textTertiary }]} />
            <ThemedText type="footnote" themeColor="textSecondary">
              {trip?.stopsAhead === null || trip?.stopsAhead === undefined
                ? 'Brak liczby przystanków'
                : `${trip.stopsAhead} ${pluralStops(trip.stopsAhead)}`}
            </ThemedText>
          </View>
        </View>

        {nextEta && (
          <View style={styles.nextEta}>
            <ThemedText type="display" color={theme.amber} style={styles.nextEtaValue}>
              {nextEta.value}
            </ThemedText>
            {!!nextEta.unit && (
              <ThemedText type="footnote" weight="semibold" color={theme.amber}>
                {nextEta.unit}
              </ThemedText>
            )}
          </View>
        )}
      </View>

      <Occupancy
        status={vehicle.occupancyStatus ?? null}
        percentage={vehicle.occupancyPercentage ?? null}
      />

      {trip && !trip.onRoute && (
        <ThemedText type="footnote" themeColor="textSecondary">
          Pojazd jest poza trasą — możliwy objazd. Lista przystanków może być niedokładna.
        </ThemedText>
      )}

      {stops.length === 0 ? (
        <ThemedText type="footnote" themeColor="textSecondary">
          Brak danych o kolejnych przystankach.
        </ThemedText>
      ) : (
        <View style={[styles.timeline, { backgroundColor: theme.backgroundCard }]}>
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
                        backgroundColor: first ? lineColor : theme.backgroundCard,
                        borderColor: lineColor,
                      },
                    ]}
                  />
                  {index < stops.length - 1 && (
                    <View style={[styles.railLine, styles.railLineBottom, { backgroundColor: lineColor }]} />
                  )}
                </View>

                <View style={styles.stopText}>
                  <ThemedText type="callout" weight={first ? 'semibold' : 'regular'} numberOfLines={1}>
                    {stop.name}
                  </ThemedText>
                  {scheduled && (
                    <ThemedText type="footnote" themeColor="textSecondary">
                      wg rozkładu {scheduled}
                    </ThemedText>
                  )}
                </View>

                <View style={styles.eta}>
                  <ThemedText type="headline" color={theme.amber}>
                    {eta.value}
                  </ThemedText>
                  {!!eta.unit && (
                    <ThemedText type="footnote" color={theme.amber}>
                      {eta.unit}
                    </ThemedText>
                  )}
                </View>
              </View>
            );
          })}
        </View>
      )}

      <Pressable
        onPress={onOpenRoute}
        accessibilityRole="button"
        accessibilityLabel="Pokaż trasę na mapie"
        style={({ pressed }) => [
          styles.routeAction,
          { backgroundColor: theme.backgroundCard },
          pressed && styles.pressed,
        ]}>
        <Ionicons name="map-outline" size={18} color={theme.text} />
        <ThemedText type="callout" weight="semibold" style={styles.routeActionText}>
          Pokaż trasę na mapie
        </ThemedText>
        <Ionicons name="chevron-forward" size={16} color={theme.textTertiary} />
      </Pressable>
    </ScrollView>
  );
}

/** The one way out, shared by both selection headers. */
export function CloseButton({ onPress, label }: { onPress: () => void; label: string }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      style={({ pressed }) => [
        styles.close,
        { backgroundColor: theme.backgroundElement },
        pressed && styles.pressed,
      ]}>
      <Ionicons name="close" size={17} color={theme.textSecondary} />
    </Pressable>
  );
}

/**
 * How full the vehicle is.
 *
 * The Kłosok feed has been serving this all along — `occupancyStatus` and
 * `occupancyPercentage` are validated in `api.ts` and were rendered nowhere.
 * It is the second question after "when", and on a wet Monday it is the first.
 *
 * Only vehicles whose operator publishes it have it, so the row is absent
 * rather than showing "brak danych": an empty state for a field most vehicles
 * will never carry is noise on every other sheet in the app.
 *
 * The GTFS-RT vocabulary is coarser than a percentage and more honest than
 * one, so where both arrive the words lead and the number qualifies.
 */
const OCCUPANCY_LABELS: Record<string, { label: string; level: number }> = {
  EMPTY: { label: 'Pusty', level: 0 },
  MANY_SEATS_AVAILABLE: { label: 'Dużo miejsc', level: 1 },
  FEW_SEATS_AVAILABLE: { label: 'Mało miejsc siedzących', level: 2 },
  STANDING_ROOM_ONLY: { label: 'Tylko miejsca stojące', level: 3 },
  CRUSHED_STANDING_ROOM_ONLY: { label: 'Bardzo tłoczno', level: 4 },
  FULL: { label: 'Pełny', level: 4 },
  NOT_ACCEPTING_PASSENGERS: { label: 'Nie zabiera pasażerów', level: 4 },
};

function Occupancy({ status, percentage }: { status: string | null; percentage: number | null }) {
  const theme = useTheme();
  const known = status ? OCCUPANCY_LABELS[status] : undefined;
  if (!known && percentage === null) return null;

  // Four bars, filled to the level. A bar chart rather than a number because
  // the underlying value is a category and printing "62%" from a category
  // would be inventing precision the feed does not have.
  const level = known?.level ?? Math.min(4, Math.round(((percentage ?? 0) / 100) * 4));
  const tone = level >= 3 ? theme.danger : level === 2 ? theme.amber : theme.success;

  return (
    <View style={[styles.occupancy, { backgroundColor: theme.backgroundCard }]}>
      <Ionicons name="people" size={17} color={theme.textSecondary} />
      <View style={styles.occupancyText}>
        <ThemedText type="callout" numberOfLines={1}>
          {known?.label ?? `Zajętość ${Math.round(percentage ?? 0)}%`}
        </ThemedText>
        {!!known && percentage !== null && (
          <ThemedText type="footnote" themeColor="textSecondary">
            ok. {Math.round(percentage)}% zajętości
          </ThemedText>
        )}
      </View>
      <View
        style={styles.occupancyBars}
        accessibilityRole="progressbar"
        accessibilityLabel={`Zajętość: ${known?.label ?? `${Math.round(percentage ?? 0)}%`}`}>
        {[1, 2, 3, 4].map((step) => (
          <View
            key={step}
            style={[
              styles.occupancyBar,
              { backgroundColor: step <= level ? tone : theme.backgroundElement },
            ]}
          />
        ))}
      </View>
    </View>
  );
}

function pluralStops(count: number) {
  if (count === 1) return 'przystanek';
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return 'przystanki';
  return 'przystanków';
}

const styles = StyleSheet.create({
  summary: { flexDirection: 'row', alignItems: 'center', gap: Space.md, paddingBottom: Space.md, minHeight: 48 },
  summaryBadge: { minWidth: 38, height: 38, borderRadius: Radius.sm },
  summaryText: { flex: 1, gap: 1, minWidth: 0 },
  scroll: { flex: 1 },
  content: { paddingHorizontal: Space.lg, paddingBottom: Space.xxl, gap: Space.md },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Space.xl },
  nextStop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    borderRadius: Radius.lg,
    padding: Space.lg,
    minHeight: 84,
  },
  nextStopCopy: { flex: 1, gap: 2, minWidth: 0 },
  nextEta: { flexDirection: 'row', alignItems: 'baseline', gap: 3 },
  nextEtaValue: { fontVariant: ['tabular-nums'] },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, paddingTop: 2 },
  metaDot: { width: 3, height: 3, borderRadius: Radius.pill },
  timeline: { borderRadius: Radius.lg, paddingHorizontal: Space.lg, paddingVertical: Space.xs },
  stopRow: { flexDirection: 'row', alignItems: 'center', gap: Space.md, minHeight: 48 },
  rail: { width: 12, alignItems: 'center', alignSelf: 'stretch' },
  railLine: { position: 'absolute', top: 0, height: '50%', width: 3, opacity: 0.45 },
  railLineBottom: { top: undefined, bottom: 0 },
  railDot: {
    width: 11,
    height: 11,
    borderRadius: Radius.pill,
    borderWidth: 2.5,
    marginTop: 'auto',
    marginBottom: 'auto',
  },
  stopText: { flex: 1, gap: 1, minWidth: 0 },
  eta: { flexDirection: 'row', alignItems: 'baseline', gap: 3 },
  routeAction: {
    minHeight: 52,
    borderRadius: Radius.lg,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Space.lg,
    gap: Space.md,
  },
  routeActionText: { flex: 1 },
  close: { width: 30, height: 30, borderRadius: Radius.pill, alignItems: 'center', justifyContent: 'center' },
  occupancy: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    borderRadius: Radius.lg,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.md,
    minHeight: 52,
  },
  occupancyText: { flex: 1, gap: 1, minWidth: 0 },
  occupancyBars: { flexDirection: 'row', alignItems: 'flex-end', gap: 3 },
  occupancyBar: { width: 5, height: 16, borderRadius: 2 },
  pressed: { opacity: Motion.pressedOpacity },
});

import Ionicons from '@expo/vector-icons/Ionicons';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { LineBadge } from './line-badge';
import { ThemedText } from './themed-text';
import { Motion, Radius, Space } from '@/constants/design';
import { useTheme } from '@/hooks/use-theme';
import type { Vehicle, VehicleDetail, VehicleTripDetail } from '@/lib/api';
import type { ArrivalAlert } from '@/lib/arrival-alerts';
import { AT_STOP_ETA, etaParts, formatDelay, formatScheduled, plural } from '@/lib/format';
import { colorFor } from '@/lib/lines';
import { tripProgress } from '@/lib/trip-progress';

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
  onShare,
  onClose,
}: {
  detail: VehicleDetail | null;
  onShare?: () => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const vehicle = detail?.vehicle ?? null;
  const trip = detail?.trip ?? null;
  const delay = formatDelay(trip?.delaySeconds);
  const delayColor =
    delay.tone === 'late' ? theme.danger : delay.tone === 'early' ? theme.success : theme.textSecondary;
  const stopsLeft =
    trip?.stopsAhead === null || trip?.stopsAhead === undefined
      ? null
      : `${trip.stopsAhead} ${pluralStops(trip.stopsAhead)}`;

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
        {/* How it is running, not where: where is the first row of the stop
            list, and saying it here too put the same stop on screen three
            times. The delay keeps its colour — late is the thing to notice. */}
        <ThemedText type="footnote" themeColor="textSecondary" numberOfLines={1}>
          {vehicle?.operator ? `${vehicle.operator} · ` : null}
          {detail ? (
            <ThemedText type="footnote" weight="semibold" color={delayColor}>
              {delay.text}
            </ThemedText>
          ) : null}
          {detail && stopsLeft ? ` · ${stopsLeft}` : null}
        </ThemedText>
      </View>

      {onShare && vehicle && (
        <HeaderButton icon="share-outline" label="Udostępnij pojazd" onPress={onShare} />
      )}
      <CloseButton onPress={onClose} label="Zamknij szczegóły pojazdu" />
    </View>
  );
}

/**
 * How far the sheet counts ETAs down on its own between polls.
 *
 * The server's ETA is exact only at the instant of the fix; left alone it sits
 * on "1 min" for a whole poll while the tram is already at the platform. A
 * little more than one poll is enough to bridge the gap, and the cap keeps a
 * stalled feed — or a tram held at a red light — from counting to "teraz"
 * on the strength of the clock alone.
 */
const MAX_LOCAL_COUNTDOWN_SECONDS = 12;

/** A server ETA aged by the time since it was fetched. */
function agedEta(etaSeconds: number | null | undefined, ageSeconds: number) {
  if (etaSeconds === null || etaSeconds === undefined || !Number.isFinite(etaSeconds)) return etaSeconds;
  const age = Math.min(Math.max(ageSeconds, 0), MAX_LOCAL_COUNTDOWN_SECONDS);
  return Math.max(0, etaSeconds - age);
}

export type VehicleDetailsProps = {
  detail: VehicleDetail | null;
  /** Seconds since `detail` was fetched; its ETAs are counted down by this much. */
  ageSeconds?: number;
  loading: boolean;
  error: Error | null;
  /** Recentres the already-highlighted route without leaving the live view. */
  onOpenRoute: () => void;
  /**
   * Arms (asking: waiting here, or getting off here) or clears the alert for a
   * stop. Absent where local notifications are not available, and then the
   * rows are not buttons.
   */
  onStopPress?: (stop: { id: string; name: string }) => void;
  /** What is armed on *this* vehicle, if anything. */
  alert?: ArrivalAlert | null;
  onDisarm?: () => void;
};

/**
 * One vehicle: where it is going, how late it is, and what it reaches when.
 *
 * The server infers the run from the position alone — MPK's feed carries no
 * trip id — and says so when it cannot. When the run cannot be identified there
 * is no delay and no clock time to show, only the remaining running time, and
 * this screen says that rather than inventing a number.
 */
export function VehicleDetails({
  detail,
  ageSeconds = 0,
  loading,
  error,
  onOpenRoute,
  onStopPress,
  alert = null,
  onDisarm,
}: VehicleDetailsProps) {
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

  const stops = trip?.nextStops ?? [];
  const lineColor = colorFor(vehicle.type);
  const nextStop = trip?.nextStop ?? stops[0] ?? null;
  const standingAt = trip?.atStop?.id ?? null;
  const etaFor = (stop: { id: string; etaSeconds: number | null }) =>
    stop.id === standingAt ? AT_STOP_ETA : etaParts(agedEta(stop.etaSeconds, ageSeconds));
  const nextEta = nextStop ? etaFor(nextStop) : null;
  const alertStopId = alert?.stopId ?? null;
  const riding = alert?.kind === 'trip' ? tripProgress(trip, alert.stopId) : null;
  const destinationIndex = riding ? stops.findIndex((stop) => stop.id === alertStopId) : -1;

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}>
      {/* The next stop on its own only when there is no stop list: with one,
          its first row is this card, and both on screen said the same stop
          twice. Amber is reserved for countdowns and nothing competes. */}
      {stops.length === 0 && nextStop && (
      <View style={[styles.nextStop, { backgroundColor: theme.backgroundCard }]}>
        <View style={styles.nextStopCopy}>
          <ThemedText type="caption" themeColor="textSecondary">
            NASTĘPNY PRZYSTANEK
          </ThemedText>
          <ThemedText type="headline" numberOfLines={1}>
            {nextStop.name}
          </ThemedText>
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
      )}

      <VehicleAmenities vehicle={vehicle} trip={trip} />

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
        <View style={styles.timelineBlock}>
        {/* Armed: say what will happen and offer the way out, rather than
            leaving a small bell on one row to explain itself. */}
        {alert ? (
          <View style={[styles.alertCard, { backgroundColor: theme.backgroundCard }]}>
            <View style={styles.alertRow}>
              <Ionicons name={alert.kind === 'trip' ? 'flag' : 'notifications'} size={18} color={theme.text} />
              <View style={styles.alertText}>
                <ThemedText type="callout" weight="semibold" numberOfLines={1}>
                  {alert.kind === 'trip' ? `Wysiadasz: ${alert.stopName}` : alert.stopName}
                </ThemedText>
                <ThemedText type="footnote" themeColor="textSecondary">
                  {alert.kind === 'trip'
                    ? riding?.arrived
                      ? 'To Twój przystanek.'
                      : riding
                        ? `${riding.stopsAway === 1 ? 'Następny przystanek' : `Jeszcze ${riding.stopsAway} ${plural(riding.stopsAway, ['przystanek', 'przystanki', 'przystanków'])}`} · powiadomimy przed wysiadką.`
                        : 'Powiadomimy Cię przed wysiadką.'
                    : 'Powiadomimy Cię ok. 2 min przed przyjazdem.'}
                </ThemedText>
              </View>
              {onDisarm && (
                <Pressable
                  onPress={onDisarm}
                  accessibilityRole="button"
                  accessibilityLabel={alert.kind === 'trip' ? 'Zakończ śledzenie przejazdu' : 'Wyłącz powiadomienie o przyjeździe'}
                  hitSlop={8}
                  style={({ pressed }) => [styles.alertAction, pressed && styles.pressed]}>
                  <ThemedText type="footnote" weight="semibold" color={theme.accent}>
                    {alert.kind === 'trip' ? 'Zakończ' : 'Wyłącz'}
                  </ThemedText>
                </Pressable>
              )}
            </View>
            {riding && (
              <TripBar
                done={riding.arrived ? 1 : 1 - riding.stopsAway / Math.max(alert.totalStops ?? 1, riding.stopsAway, 1)}
                color={lineColor}
              />
            )}
          </View>
        ) : onStopPress && (
          <ThemedText type="footnote" themeColor="textSecondary">
            Dotknij przystanek, jeśli na nim czekasz albo na nim wysiadasz — powiadomimy Cię w porę.
          </ThemedText>
        )}
        <View style={[styles.timeline, { backgroundColor: theme.backgroundCard }]}>
          {stops.map((stop, index) => {
            const eta = etaFor(stop);
            const scheduled = formatScheduled(stop.scheduled);
            const first = index === 0;
            const alerting = stop.id === alertStopId;
            // Riding: the stops past the rider's own are not their journey.
            const beyond = destinationIndex >= 0 && index > destinationIndex;

            return (
              <Pressable
                key={`${stop.id}-${stop.sequence}`}
                disabled={!onStopPress}
                onPress={() => onStopPress?.({ id: stop.id, name: stop.name })}
                accessibilityRole={onStopPress ? 'button' : undefined}
                accessibilityState={onStopPress ? { selected: alerting } : undefined}
                accessibilityHint={
                  onStopPress
                    ? alerting
                      ? 'Wyłącza powiadomienie'
                      : 'Pozwala wybrać powiadomienie o przyjeździe albo o wysiadce'
                    : undefined
                }
                style={({ pressed }) => [styles.stopRow, beyond && styles.beyond, pressed && styles.pressed]}>
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
                  <View style={styles.stopName}>
                    <ThemedText
                      type="callout"
                      weight={first ? 'semibold' : 'regular'}
                      numberOfLines={1}
                      style={styles.stopNameText}>
                      {stop.name}
                    </ThemedText>
                    {alerting && (
                      <Ionicons
                        name={alert?.kind === 'trip' ? 'flag' : 'notifications'}
                        size={14}
                        color={theme.textSecondary}
                        accessibilityLabel={alert?.kind === 'trip' ? 'Tu wysiadasz' : 'Powiadomienie włączone'}
                      />
                    )}
                  </View>
                  {scheduled && (
                    <ThemedText type="footnote" themeColor="textSecondary">
                      wg rozkładu {scheduled}
                    </ThemedText>
                  )}
                </View>

                <View style={styles.eta}>
                  {/* The next stop's countdown leads — it is what the card
                      above the list used to be for. */}
                  <ThemedText type={first ? 'title' : 'headline'} color={theme.amber} style={styles.etaValue}>
                    {eta.value}
                  </ThemedText>
                  {!!eta.unit && (
                    <ThemedText type="footnote" weight={first ? 'semibold' : 'regular'} color={theme.amber}>
                      {eta.unit}
                    </ThemedText>
                  )}
                </View>
              </Pressable>
            );
          })}
        </View>
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

/** How much of the ride is behind the rider — the Live Activity's bar, in the sheet. */
function TripBar({ done, color }: { done: number; color: string }) {
  const theme = useTheme();
  const fraction = Math.min(1, Math.max(0, done));
  return (
    <View
      style={[styles.tripTrack, { backgroundColor: theme.backgroundElement }]}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(fraction * 100) }}>
      <View style={[styles.tripFill, { width: `${Math.max(fraction * 100, 4)}%`, backgroundColor: color }]} />
    </View>
  );
}

const LOW_FLOOR_LABEL = { full: 'pełna', partial: 'częściowa', none: 'brak' } as const;

/** `state` is the tri-state the row is really about; `value` is how it reads. */
type Amenity = {
  icon: 'enter-outline' | 'accessibility-outline' | 'snow-outline';
  label: string;
  value: string;
  state: boolean | null;
};

/**
 * What this vehicle is, and what a rider needs to know before it pulls up:
 * whether the floor is low, whether a wheelchair gets on, whether the saloon
 * is air conditioned.
 *
 * None of it comes from a live feed — the server reads it out of a roster
 * keyed on the side number, and the timetable contributes its own
 * `wheelchair_accessible` for the matched run. So the important state here is
 * the third one: `null` is "nie wiadomo", never "nie". Sending someone to a
 * stop expecting a ramp that is not there is worse than telling them nothing,
 * so an unknown reads as unknown and looks it. The whole card is dropped when
 * nothing at all is known, rather than filling the sheet with three
 * shrugs — which is most vehicles, since MPK's feed carries no side number
 * until an Open Data record is merged onto it.
 */
function VehicleAmenities({ vehicle, trip }: { vehicle: Vehicle; trip: VehicleTripDetail | null }) {
  const theme = useTheme();
  const fleet = vehicle.fleet ?? null;

  // The roster is about the vehicle, the timetable about the run it is on. The
  // roster wins when both speak, because it describes the physical vehicle
  // that is actually on the street right now.
  const wheelchair = fleet?.wheelchair ?? trip?.wheelchairAccessible ?? null;
  const lowFloor = fleet?.lowFloor ?? null;
  const airConditioning = fleet?.airConditioning ?? null;

  const rows: Amenity[] = [
    {
      icon: 'enter-outline',
      label: 'Niska podłoga',
      value: lowFloor ? LOW_FLOOR_LABEL[lowFloor] : 'brak danych',
      state: lowFloor ? lowFloor !== 'none' : null,
    },
    {
      icon: 'accessibility-outline',
      label: 'Miejsce dla wózka',
      value: wheelchair === null ? 'brak danych' : wheelchair ? 'tak' : 'nie',
      state: wheelchair,
    },
    {
      icon: 'snow-outline',
      label: 'Klimatyzacja',
      value: airConditioning === null ? 'brak danych' : airConditioning ? 'tak' : 'nie',
      state: airConditioning,
    },
  ];

  const stated = rows.filter((row) => row.state !== null);
  if (!fleet?.model && !vehicle.vehicleNumber && !stated.length) return null;

  const heading = fleet?.model ?? 'Model nieznany';
  const subtitle = [vehicle.vehicleNumber ? `nr ${vehicle.vehicleNumber}` : null, fleet?.years]
    .filter(Boolean)
    .join(' · ');

  // What nobody stated is still said — as one quiet line rather than a row
  // each, which gave two thirds of the card to "brak danych".
  const unknown = rows.filter((row) => row.state === null);

  return (
    <View style={[styles.amenities, { backgroundColor: theme.backgroundCard }]}>
      <View style={styles.amenitiesHead}>
        <Ionicons name={vehicle.type.startsWith('tram') ? 'train-outline' : 'bus-outline'} size={18} color={theme.textSecondary} />
        <ThemedText type="callout" weight="semibold" numberOfLines={1} style={styles.amenitiesModel}>
          {heading}
        </ThemedText>
        {!!subtitle && (
          <ThemedText type="footnote" themeColor="textSecondary" numberOfLines={1}>
            {subtitle}
          </ThemedText>
        )}
      </View>

      {stated.length > 0 && (
        <View style={styles.amenityChips}>
          {stated.map((row) => (
            <View
              key={row.label}
              style={[styles.amenityChip, { backgroundColor: theme.backgroundElement }]}
              accessible
              accessibilityLabel={`${row.label}: ${row.value}`}>
              <Ionicons name={row.icon} size={15} color={row.state ? theme.success : theme.textTertiary} />
              <ThemedText type="footnote" numberOfLines={1}>
                {row.label}
              </ThemedText>
              <ThemedText type="footnote" weight="semibold" themeColor="textSecondary">
                {row.value}
              </ThemedText>
            </View>
          ))}
        </View>
      )}

      {unknown.length > 0 && (
        <ThemedText type="footnote" themeColor="textTertiary">
          Brak danych: {unknown.map((row) => row.label.toLowerCase()).join(', ')}
        </ThemedText>
      )}
    </View>
  );
}

/** A secondary action in a selection header — share, star. Same size as the way out. */
export function HeaderButton({
  icon,
  label,
  onPress,
  color,
  selected,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  onPress: () => void;
  color?: string;
  /** For a toggle: read out as selected, so the star's state is not colour alone. */
  selected?: boolean;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected === undefined ? undefined : { selected }}
      hitSlop={8}
      style={({ pressed }) => [
        styles.close,
        { backgroundColor: theme.backgroundElement },
        pressed && styles.pressed,
      ]}>
      <Ionicons name={icon} size={17} color={color ?? theme.textSecondary} />
    </Pressable>
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
  amenities: { borderRadius: Radius.lg, paddingHorizontal: Space.lg, paddingVertical: Space.md, gap: Space.sm },
  amenitiesHead: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, minWidth: 0 },
  amenitiesModel: { flexShrink: 1 },
  amenityChips: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.xs },
  amenityChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs,
    minHeight: 28,
    paddingHorizontal: Space.sm,
    borderRadius: Radius.sm,
  },
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
  stopName: { flexDirection: 'row', alignItems: 'center', gap: Space.xs, minWidth: 0 },
  stopNameText: { flexShrink: 1 },
  timelineBlock: { gap: Space.sm },
  alertCard: {
    gap: Space.md,
    borderRadius: Radius.lg,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.md,
  },
  alertRow: { flexDirection: 'row', alignItems: 'center', gap: Space.md },
  tripTrack: { height: 6, borderRadius: Radius.pill, overflow: 'hidden' },
  tripFill: { height: '100%', borderRadius: Radius.pill },
  beyond: { opacity: 0.4 },
  alertText: { flex: 1, gap: 1, minWidth: 0 },
  alertAction: { minHeight: 32, justifyContent: 'center' },
  eta: { flexDirection: 'row', alignItems: 'baseline', gap: 3 },
  etaValue: { fontVariant: ['tabular-nums'] },
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
  pressed: { opacity: Motion.pressedOpacity },
});

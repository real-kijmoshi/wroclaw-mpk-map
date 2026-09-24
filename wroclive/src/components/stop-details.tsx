import Ionicons from '@expo/vector-icons/Ionicons';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { LineBadge } from './line-badge';
import { ThemedText } from './themed-text';
import { CloseButton, HeaderButton } from './vehicle-details';
import { Motion, Radius, Space } from '@/constants/design';
import { useTheme } from '@/hooks/use-theme';
import type { Departure, Departures, Stop } from '@/lib/api';
import { boardLines, departureSeconds, groupByRoute } from '@/lib/departures';
import { etaParts, formatDistance, formatScheduled } from '@/lib/format';
import { tapped } from '@/lib/haptics';
import { preferencesStore, usePreferences, type BoardView } from '@/lib/preferences';
import { distanceMeters } from '@/lib/stops-api';
import { leaveInSeconds, leaveLabel, openWalkingDirections, walkSeconds } from '@/lib/walking';

/**
 * The selected stop, as the sheet's header.
 *
 * Built from the stop the map handed over rather than from the departures
 * payload, so the name is on screen the moment it is tapped instead of after
 * the board has loaded. The directions arrive with the board and fill in the
 * second line: they are what tells a rider they opened the right side of the
 * street.
 */
export function StopSummary({
  stop,
  label,
  directions,
  userPosition,
  favourite,
  onToggleFavourite,
  onShare,
  onClose,
}: {
  stop: Stop;
  /** The rider's own name for it, when it is a starred stop they named. */
  label?: string | null;
  /** "→ Oporów, Leśnica", once the board is in. */
  directions?: string | null;
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
      {/* The map's stop plate, larger: the sheet names the thing that was tapped. */}
      <View style={[styles.mark, { backgroundColor: theme.backgroundElement }]}>
        <View style={[styles.markPlate, { backgroundColor: theme.text }]}>
          <View style={[styles.markPip, { backgroundColor: theme.backgroundElement }]} />
        </View>
      </View>

      <View style={styles.summaryText}>
        <ThemedText type="headline" numberOfLines={1}>
          {label ? `${label} · ${stop.name}` : stop.name}
        </ThemedText>
        <ThemedText type="footnote" themeColor="textSecondary" numberOfLines={1}>
          {[directions || 'Odjazdy na żywo', distance].filter(Boolean).join(' · ')}
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
  onRetry?: () => void;
  /** Whether this departure's vehicle is already on the road, so a tap can show it. */
  canOpenVehicle?: (departure: Departure) => boolean;
  /** Takes the map to the vehicle driving this departure and selects it. */
  onOpenVehicle?: (departure: Departure) => void;
};

/** A little more than one 30 s departures poll; past it the clock alone is not trusted. */
const MAX_LOCAL_COUNTDOWN_SECONDS = 40;
/** Rows in departure order. Past this a board is a timetable, which is not what the sheet is for. */
const TIME_ROWS = 15;
/** Departures shown per route in the grouped view: the next one, and the two after it. */
const ROUTE_DEPARTURES = 3;
/** A small line badge (26) inside its 2pt ring and 2pt padding: every control in the row is this tall. */
const CONTROL_HEIGHT = 34;

/**
 * The next departures from one stop — the board, as it would read at the stop,
 * or regrouped by line.
 *
 * The line chips filter both views. They are the answer to the interchange
 * problem: at Plac Grunwaldzki the board is a dozen rows of six lines, and a
 * rider who only takes the 4 wants the 4's next three departures and nothing
 * else. The filter belongs to this stop and this visit, so it resets with the
 * selection rather than being remembered; the view is a habit, and is.
 */
export function StopDetails({
  data,
  loading,
  error,
  stop,
  userPosition,
  ageSeconds = 0,
  onRetry,
  canOpenVehicle,
  onOpenVehicle,
}: StopDetailsProps) {
  const theme = useTheme();
  const { boardView } = usePreferences();
  const [lineFilter, setLineFilter] = useState<string | null>(null);
  const walk = walkSeconds(userPosition, stop);
  const age = Math.min(Math.max(ageSeconds, 0), MAX_LOCAL_COUNTDOWN_SECONDS);
  const secondsTo = (departure: Departure) => Math.max(0, departureSeconds(departure) - age);

  const departures = useMemo(() => data?.departures ?? [], [data]);
  const lines = useMemo(() => boardLines(departures), [departures]);
  // A line that has left the board since it was picked is not a filter any more.
  const activeFilter = lineFilter && lines.some((entry) => entry.line === lineFilter) ? lineFilter : null;
  const shown = useMemo(
    () => (activeFilter ? departures.filter((departure) => departure.line === activeFilter) : departures),
    [departures, activeFilter],
  );
  const routes = useMemo(() => groupByRoute(shown), [shown]);

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
        {onRetry && (
          <Pressable onPress={onRetry} accessibilityRole="button" hitSlop={8}>
            <ThemedText type="callout" weight="semibold" color={theme.accent}>
              Spróbuj ponownie
            </ThemedText>
          </Pressable>
        )}
      </View>
    );
  }

  const setView = (view: BoardView) => {
    tapped();
    preferencesStore.set('boardView', view);
  };

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      {/* The walk first: with it, every row below answers "when do I leave"
          rather than "when does it go". Only when the rider is close enough
          for the estimate to mean something. */}
      {walk !== null && (
        <Pressable
          onPress={() => openWalkingDirections(stop)}
          accessibilityRole="button"
          accessibilityLabel={`Prowadź pieszo, około ${Math.max(1, Math.round(walk / 60))} minut`}
          accessibilityHint="Otwiera Mapy Apple"
          style={({ pressed }) => [styles.walk, { backgroundColor: theme.backgroundCard }, pressed && styles.pressed]}>
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

      {departures.length === 0 ? (
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
        <>
          {/* One row, not two: the filter and the view are both "how do I
              want to read this board", and stacked they pushed the first
              departure half a screen down. The chips scroll; the toggle stays. */}
          <View style={styles.controls}>
            {lines.length > 1 ? (
              <ScrollView
                horizontal
                style={styles.chipScroll}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.chips}
                accessibilityLabel="Filtruj linie">
                <Pressable
                  onPress={() => {
                    tapped();
                    setLineFilter(null);
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: !activeFilter }}
                  style={[
                    styles.chip,
                    { backgroundColor: theme.backgroundElement, borderColor: !activeFilter ? theme.text : 'transparent' },
                  ]}>
                  <ThemedText type="footnote" weight="semibold">
                    Wszystkie
                  </ThemedText>
                </Pressable>
                {lines.map(({ line, type }) => {
                const selected = activeFilter === line;
                return (
                  <Pressable
                    key={line}
                    onPress={() => {
                      tapped();
                      setLineFilter(selected ? null : line);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`Tylko linia ${line}`}
                    accessibilityState={{ selected }}
                    style={({ pressed }) => [
                      styles.lineChip,
                      { borderColor: selected ? theme.text : 'transparent' },
                      !selected && activeFilter !== null && styles.dimmed,
                      pressed && styles.pressed,
                    ]}>
                    <LineBadge line={line} type={type} size="small" />
                  </Pressable>
                );
              })}
              </ScrollView>
            ) : (
              <View style={styles.chipScroll} />
            )}

            <View style={[styles.segmented, { backgroundColor: theme.backgroundElement }]} accessibilityRole="tablist">
              {(
                [
                  ['time', 'Kolejno'],
                  ['route', 'Wg linii'],
                ] as const
              ).map(([view, title]) => {
                const selected = boardView === view;
                return (
                  <Pressable
                    key={view}
                    onPress={() => setView(view)}
                    accessibilityRole="tab"
                    accessibilityState={{ selected }}
                    style={[styles.segment, selected && { backgroundColor: theme.backgroundCard }]}>
                    <ThemedText
                      type="caption"
                      weight={selected ? 'semibold' : 'regular'}
                      themeColor={selected ? 'text' : 'textSecondary'}>
                      {title}
                    </ThemedText>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {boardView === 'route' ? (
            <View style={[styles.board, { backgroundColor: theme.backgroundCard }]}>
              {routes.map((route, index) => (
                <RouteRow
                  key={route.key}
                  first={index === 0}
                  line={route.line}
                  type={route.type}
                  headsign={route.headsign}
                  seconds={route.departures.slice(0, ROUTE_DEPARTURES).map(secondsTo)}
                  live={Boolean(route.departures[0]?.realtime)}
                  walk={walk}
                  onOpen={
                    onOpenVehicle && route.departures[0] && canOpenVehicle?.(route.departures[0])
                      ? () => onOpenVehicle(route.departures[0])
                      : undefined
                  }
                />
              ))}
            </View>
          ) : (
            <View style={[styles.board, { backgroundColor: theme.backgroundCard }]}>
              {shown.slice(0, TIME_ROWS).map((departure, index) => {
                const seconds = secondsTo(departure);
                const eta = etaParts(seconds);
                const scheduled = formatScheduled(departure.departure);
                const leave = walk === null ? null : leaveLabel(leaveInSeconds(seconds, walk));
                const openable = Boolean(onOpenVehicle && canOpenVehicle?.(departure));

                return (
                  <Pressable
                    key={`${departure.tripId}-${departure.departure}`}
                    disabled={!openable}
                    onPress={() => onOpenVehicle?.(departure)}
                    accessibilityRole={openable ? 'button' : undefined}
                    accessibilityHint={openable ? 'Pokazuje pojazd na mapie' : undefined}
                    style={({ pressed }) => [
                      styles.row,
                      index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.separator },
                      // Still listed — it is on the board at the stop too — but it
                      // steps back so the first catchable one leads.
                      leave?.missed && styles.missed,
                      pressed && styles.pressed,
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
                    <OpenMark visible={openable} />
                  </Pressable>
                );
              })}
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}

/**
 * One line in one direction: when it next leaves, big, and the two after it,
 * small — so "missed it, when's the next one" is answered on the same row.
 */
function RouteRow({
  first,
  line,
  type,
  headsign,
  seconds,
  live,
  walk,
  onOpen,
}: {
  first: boolean;
  line: string;
  type: string;
  headsign: string | null;
  seconds: number[];
  live: boolean;
  walk: number | null;
  /** Present when the next departure's vehicle is on the road. */
  onOpen?: () => void;
}) {
  const theme = useTheme();
  const [next, ...later] = seconds;
  const eta = etaParts(next);
  const leave = walk === null || next === undefined ? null : leaveLabel(leaveInSeconds(next, walk));
  const laterText = later
    .map((value) => etaParts(value))
    .map((parts) => (parts.unit ? `${parts.value} ${parts.unit}` : parts.value))
    .join(', ');

  return (
    <Pressable
      disabled={!onOpen}
      onPress={onOpen}
      style={({ pressed }) => [
        styles.row,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.separator },
        pressed && styles.pressed,
      ]}
      accessible
      accessibilityRole={onOpen ? 'button' : undefined}
      accessibilityHint={onOpen ? 'Pokazuje pojazd na mapie' : undefined}
      accessibilityLabel={`Linia ${line}${headsign ? ` do ${headsign}` : ''}: ${eta.value} ${eta.unit}${laterText ? `, potem ${laterText}` : ''}`}>
      <LineBadge line={line} type={type} size="small" />
      <View style={styles.rowText}>
        <ThemedText type="callout" numberOfLines={1}>
          {headsign ?? '—'}
        </ThemedText>
        <ThemedText type="footnote" themeColor="textSecondary" numberOfLines={1}>
          {laterText ? `Potem: ${laterText}` : 'Brak kolejnych w rozkładzie'}
          {live ? ' · ' : null}
          {live && (
            <ThemedText type="footnote" color={theme.success}>
              na żywo
            </ThemedText>
          )}
        </ThemedText>
        {leave && (
          <ThemedText type="footnote" weight="semibold" themeColor="textSecondary" numberOfLines={1}>
            {leave.text}
          </ThemedText>
        )}
      </View>
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
      <OpenMark visible={Boolean(onOpen)} />
    </Pressable>
  );
}

/**
 * The chevron on a row whose vehicle can be shown. The space is kept when it
 * cannot, so the countdowns stay in one column down the board.
 */
function OpenMark({ visible }: { visible: boolean }) {
  const theme = useTheme();
  return (
    <View style={styles.openMark}>
      {visible && <Ionicons name="chevron-forward" size={16} color={theme.textTertiary} />}
    </View>
  );
}

const styles = StyleSheet.create({
  summary: { flexDirection: 'row', alignItems: 'center', gap: Space.md, paddingBottom: Space.md, minHeight: 48 },
  mark: { width: 38, height: 38, borderRadius: Radius.md, alignItems: 'center', justifyContent: 'center' },
  markPlate: { width: 16, height: 16, borderRadius: 4.5, alignItems: 'center', justifyContent: 'center' },
  markPip: { width: 6, height: 6, borderRadius: Radius.pill },
  summaryText: { flex: 1, gap: 1, minWidth: 0 },
  scroll: { flex: 1 },
  content: { paddingHorizontal: Space.lg, paddingBottom: Space.xxl, gap: Space.md },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Space.xl, gap: Space.sm },
  empty: { borderRadius: Radius.lg, padding: Space.lg, gap: Space.xs },
  controls: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  chipScroll: { flex: 1 },
  segmented: { flexDirection: 'row', borderRadius: Radius.sm + 2, padding: 2 },
  segment: {
    height: CONTROL_HEIGHT - 4,
    paddingHorizontal: Space.sm + 2,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chips: { gap: Space.xs, alignItems: 'center', paddingRight: Space.sm },
  // The same height and selection ring as a line chip, so "Wszystkie" reads as
  // one of the choices rather than a black button shouting over them.
  chip: {
    height: CONTROL_HEIGHT,
    paddingHorizontal: Space.md,
    borderRadius: Radius.sm,
    borderWidth: 2,
    justifyContent: 'center',
  },
  lineChip: { borderWidth: 2, borderRadius: Radius.sm, padding: 2 },
  openMark: { width: 16, marginLeft: -Space.xs, alignItems: 'flex-end' },
  dimmed: { opacity: 0.45 },
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

import Ionicons from '@expo/vector-icons/Ionicons';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Divider, LinkRow, Row, RowIcon, Section } from './list';
import { StopAreaRow } from './stop-area-row';
import { ThemedText } from './themed-text';
import { Motion, Radius, Space } from '@/constants/design';
import { useTheme } from '@/hooks/use-theme';
import type { Stop } from '@/lib/api';
import type { ArrivalAlert } from '@/lib/arrival-alerts';
import type { FavouriteBoard } from '@/lib/favourite-boards';
import type { FavouriteStop } from '@/lib/favourite-stops';
import { tripTitle, type FavouriteTrip } from '@/lib/favourite-trips';
import type { TripBoard } from '@/lib/widgets';
import { LineBadge } from './line-badge';
import { arrivalSeconds, clockIn, departureSeconds } from '@/lib/departures';
import { etaParts, formatDistance, plural } from '@/lib/format';
import type { StopArea } from '@/lib/stops-api';

export type LiveStatus = {
  text: string;
  freshness: string;
  tone: 'live' | 'stale' | 'loading' | 'error';
};

/**
 * The part of the sheet that is always on screen.
 *
 * Everything the old HUD card carried — the city, the vehicle count, the
 * freshness, search and settings — lives here instead, at the bottom of the
 * screen where a thumb reaches and where it stops covering the map.
 */
export function MapSheetHeader({
  status,
  onSearch,
  onSettings,
}: {
  status: LiveStatus;
  onSearch: () => void;
  onSettings: () => void;
}) {
  const theme = useTheme();
  const dotColor =
    status.tone === 'live'
      ? theme.success
      : status.tone === 'error'
        ? theme.danger
        : theme.textTertiary;

  return (
    <View style={styles.header}>
      <View style={styles.headerRow}>
        <Pressable
          onPress={onSearch}
          accessibilityRole="button"
          accessibilityLabel="Szukaj linii i przystanków"
          accessibilityHint="Otwiera wyszukiwanie"
          style={({ pressed }) => [
            styles.search,
            { backgroundColor: theme.backgroundElement },
            pressed && styles.pressed,
          ]}>
          <Ionicons name="search" size={17} color={theme.textSecondary} />
          <ThemedText type="callout" themeColor="textSecondary" numberOfLines={1}>
            Szukaj linii lub przystanku
          </ThemedText>
        </Pressable>

        <Pressable
          onPress={onSettings}
          accessibilityRole="button"
          accessibilityLabel="Ustawienia"
          style={({ pressed }) => [
            styles.settings,
            { backgroundColor: theme.backgroundElement },
            pressed && styles.pressed,
          ]}>
          <Ionicons name="settings-outline" size={19} color={theme.text} />
        </Pressable>
      </View>

      <View style={styles.statusRow}>
        <View style={[styles.liveDot, { backgroundColor: dotColor }]} />
        <ThemedText type="footnote" weight="semibold" numberOfLines={1} style={styles.statusText}>
          {status.text}
        </ThemedText>
        <ThemedText type="footnote" themeColor="textSecondary" numberOfLines={1}>
          {status.freshness}
        </ThemedText>
      </View>
    </View>
  );
}

export type MapSheetHomeProps = {
  selectedLineCount: number;
  alertCount: number | null;
  /** Places, not platforms — grouped by `groupStopAreas`. */
  nearbyAreas: StopArea[];
  /** The armed arrival alert, if any — it outlives the vehicle's sheet. */
  arrivalAlert: ArrivalAlert | null;
  onOpenAlert: () => void;
  onDisarmAlert: () => void;
  /** Starred stops, in the rider's order. */
  favouriteStops: FavouriteStop[];
  /** Next departures for the first few of them, when fetched. */
  favouriteBoards: FavouriteBoard[];
  /** Seconds since those boards were fetched, so the minutes count down between polls. */
  boardsAgeSeconds: number;
  /** Whether the rider's position is known, which is what makes the list mean anything. */
  located: boolean;
  locating: boolean;
  /** Why the last locate attempt produced nothing, if it produced nothing. */
  locateProblem: 'denied' | 'failed' | null;
  /** The fleet poll is failing — the map is showing the last thing it knew. */
  offline: boolean;
  onLines: () => void;
  onAlerts: () => void;
  onLocate: () => void;
  onRetry: () => void;
  onStop: (stop: Stop) => void;
  /** Rename, reorder, remove — and how to put a stop on a widget. */
  onManageFavourites: () => void;
  /** Saved journeys and their next departures that get there. */
  trips: FavouriteTrip[];
  tripBoards: TripBoard[];
  /** When the boards were fetched: a trip's arrival clock is counted from it. */
  boardsReceivedAt: number | null;
  onTrip: (trip: FavouriteTrip) => void;
  onNewTrip: () => void;
};

/** How many places fit before the list stops being a glance and becomes a scroll. */
const NEARBY_LIMIT = 6;

/** What the sheet shows when nothing is selected. */
export function MapSheetHome({
  selectedLineCount,
  alertCount,
  nearbyAreas,
  arrivalAlert,
  onOpenAlert,
  onDisarmAlert,
  favouriteStops,
  favouriteBoards,
  boardsAgeSeconds,
  located,
  locating,
  locateProblem,
  offline,
  onLines,
  onAlerts,
  onLocate,
  onRetry,
  onStop,
  onManageFavourites,
  trips,
  tripBoards,
  boardsReceivedAt,
  onTrip,
  onNewTrip,
}: MapSheetHomeProps) {
  const theme = useTheme();

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}>
      {/*
       * A dead connection is the one thing worth interrupting the layout for:
       * everything below it is the last thing the app knew, not what is
       * happening now, and the rider needs both facts and a way to act.
       */}
      {offline && (
        <Pressable
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel="Spróbuj połączyć ponownie"
          style={({ pressed }) => [
            styles.banner,
            { backgroundColor: theme.backgroundCard, borderColor: theme.danger },
            pressed && styles.pressed,
          ]}>
          <Ionicons name="cloud-offline" size={18} color={theme.danger} />
          <View style={styles.bannerText}>
            <ThemedText type="callout" weight="semibold">
              Brak połączenia
            </ThemedText>
            <ThemedText type="footnote" themeColor="textSecondary">
              Pokazujemy ostatnie znane pozycje.
            </ThemedText>
          </View>
          <ThemedText type="footnote" weight="semibold" color={theme.accent}>
            Ponów
          </ThemedText>
        </Pressable>
      )}

      {/*
       * An armed alert keeps following its tram after the sheet is closed, so
       * the home says so — otherwise the only trace of it is a notification
       * the rider may not remember asking for.
       */}
      {arrivalAlert && (
        <View style={[styles.banner, { backgroundColor: theme.backgroundCard, borderColor: theme.separator }]}>
          <Pressable
            onPress={onOpenAlert}
            accessibilityRole="button"
            accessibilityLabel={
              arrivalAlert.kind === 'trip'
                ? `Linia ${arrivalAlert.line}, wysiadasz na przystanku ${arrivalAlert.stopName}`
                : `Linia ${arrivalAlert.line}, powiadomienie przed przystankiem ${arrivalAlert.stopName}`
            }
            accessibilityHint="Pokazuje pojazd"
            style={({ pressed }) => [styles.bannerMain, pressed && styles.pressed]}>
            <Ionicons name={arrivalAlert.kind === 'trip' ? 'flag' : 'notifications'} size={18} color={theme.text} />
            <View style={styles.bannerText}>
              <ThemedText type="callout" weight="semibold" numberOfLines={1}>
                {arrivalAlert.kind === 'trip'
                  ? `Jedziesz do: ${arrivalAlert.stopName}`
                  : `Linia ${arrivalAlert.line}${arrivalAlert.towards ? ` → ${arrivalAlert.towards}` : ''}`}
              </ThemedText>
              <ThemedText type="footnote" themeColor="textSecondary" numberOfLines={1}>
                {arrivalAlert.kind === 'trip'
                  ? `Linia ${arrivalAlert.line}${
                      arrivalAlert.stopsAway === undefined
                        ? ''
                        : arrivalAlert.stopsAway === 0
                          ? ' · to Twój przystanek'
                          : ` · jeszcze ${arrivalAlert.stopsAway} ${plural(arrivalAlert.stopsAway, ['przystanek', 'przystanki', 'przystanków'])}`
                    }`
                  : `Powiadomienie przed: ${arrivalAlert.stopName}`}
              </ThemedText>
            </View>
          </Pressable>
          <Pressable
            onPress={onDisarmAlert}
            accessibilityRole="button"
            accessibilityLabel={arrivalAlert.kind === 'trip' ? 'Zakończ śledzenie przejazdu' : 'Wyłącz powiadomienie'}
            hitSlop={8}>
            <ThemedText type="footnote" weight="semibold" color={theme.accent}>
              {arrivalAlert.kind === 'trip' ? 'Zakończ' : 'Wyłącz'}
            </ThemedText>
          </Pressable>
        </View>
      )}

      {/*
       * Chosen stops above nearby ones: a regular opens the app to ask about
       * their own stop, and nearest-first answers that only when they are
       * already standing at it. Absent until something is starred — an empty
       * "Ulubione" card would be a tutorial, not information.
       */}
      {favouriteStops.length > 0 && (
        <Section title="Ulubione">
          {favouriteStops.map((stop, index) => (
            <View key={stop.id}>
              {index > 0 && <Divider />}
              <FavouriteRow
                stop={stop}
                board={favouriteBoards.find((board) => board.stop.id === stop.id) ?? null}
                ageSeconds={boardsAgeSeconds}
                onPress={() => onStop(stop)}
              />
            </View>
          ))}
          <Divider />
          <Pressable
            onPress={onManageFavourites}
            accessibilityRole="button"
            accessibilityLabel="Zarządzaj ulubionymi"
            accessibilityHint="Zmiana nazw, kolejności i widżety"
            style={({ pressed }) => [styles.manage, pressed && styles.pressed]}>
            <ThemedText type="footnote" weight="semibold" color={theme.accent}>
              Zarządzaj ulubionymi i widżetami
            </ThemedText>
          </Pressable>
        </Section>
      )}

      {/*
       * A saved journey answers the regular's real question — which of my
       * trams, and when am I there — so it sits with the favourites.
       */}
      {trips.length > 0 && (
        <Section title="Przejazdy">
          {trips.map((trip, index) => (
            <View key={trip.id}>
              {index > 0 && <Divider />}
              <TripRow
                trip={trip}
                board={tripBoards.find((board) => board.trip.id === trip.id) ?? null}
                ageSeconds={boardsAgeSeconds}
                receivedAt={boardsReceivedAt}
                onPress={() => onTrip(trip)}
              />
            </View>
          ))}
        </Section>
      )}

      {/*
       * Nearest first, because it is the only thing here a rider needs *now*.
       * The line filter and the alerts are settings you visit; where the next
       * tram goes from is the question you opened the app with.
       */}
      <Section
        title="Blisko Ciebie"
        footer={
          located && nearbyAreas.length > NEARBY_LIMIT
            ? `i ${nearbyAreas.length - NEARBY_LIMIT} ${plural(nearbyAreas.length - NEARBY_LIMIT, ['dalszy przystanek', 'dalsze przystanki', 'dalszych przystanków'])} na mapie`
            : undefined
        }>
        {locateProblem === 'denied' ? (
          // Nothing this button can do now lives inside the app, so it stops
          // pretending and points at the place that can.
          <LinkRow
            label="Brak dostępu do lokalizacji"
            hint="Włącz go w Ustawieniach systemu, aby zobaczyć przystanki wokół siebie"
            leading={<RowIcon name="locate" color={theme.danger} />}
            onPress={() => Linking.openSettings()}
          />
        ) : !located ? (
          <LinkRow
            label={locating ? 'Szukanie lokalizacji…' : 'Pokaż przystanki w pobliżu'}
            hint={
              locateProblem === 'failed'
                ? 'Nie udało się ustalić pozycji — spróbuj ponownie'
                : 'Przystanki na mapie działają bez lokalizacji — wystarczy przybliżyć'
            }
            leading={
              <RowIcon
                name="locate"
                color={locateProblem === 'failed' ? theme.danger : theme.accent}
              />
            }
            onPress={onLocate}
          />
        ) : nearbyAreas.length === 0 ? (
          <Row
            label="Brak przystanków w pobliżu"
            hint="Najbliższy jest dalej niż 700 m"
          />
        ) : (
          nearbyAreas.slice(0, NEARBY_LIMIT).map((area, index) => (
            <View key={area.primary.id}>
              {index > 0 && <Divider />}
              <StopAreaRow
                area={area}
                trailing={
                  formatDistance(area.distance) ? (
                    <ThemedText type="footnote" weight="semibold" themeColor="textSecondary">
                      {formatDistance(area.distance)}
                    </ThemedText>
                  ) : null
                }
                onPress={() => onStop(area.primary)}
              />
            </View>
          ))
        )}
      </Section>

      <Section>
        <LinkRow
          label="Linie"
          leading={<RowIcon name="git-branch" color={theme.textSecondary} />}
          value={
            selectedLineCount === 0
              ? 'Cała sieć'
              : `${selectedLineCount} ${plural(selectedLineCount, ['wybrana', 'wybrane', 'wybranych'])}`
          }
          onPress={onLines}
        />
        <Divider />
        <LinkRow
          label="Utrudnienia"
          leading={<RowIcon name="warning" color={alertCount ? theme.danger : theme.textSecondary} />}
          value={alertCount === null ? null : String(alertCount)}
          onPress={onAlerts}
        />
        <Divider />
        <LinkRow
          label={trips.length ? 'Nowy przejazd' : 'Zapisz stały przejazd'}
          hint={trips.length ? null : 'Np. dom → szkoła: kiedy wyjść i o której będziesz na miejscu'}
          leading={<RowIcon name="navigate-circle" color={theme.textSecondary} />}
          onPress={onNewTrip}
        />
      </Section>
    </ScrollView>
  );
}

/**
 * A starred stop with what leaves it next — the answer, not a link to it. The
 * rider who starred a stop opens the app to ask exactly this, and a row that
 * only says the stop's name makes them tap through for it every time.
 */
function FavouriteRow({
  stop,
  board,
  ageSeconds,
  onPress,
}: {
  stop: FavouriteStop;
  board: FavouriteBoard | null;
  ageSeconds: number;
  onPress: () => void;
}) {
  const theme = useTheme();
  const age = Math.min(Math.max(ageSeconds, 0), 90);
  const next = (board?.departures ?? [])
    .map((departure) => ({
      departure,
      seconds: departureSeconds(departure) - age,
    }))
    .filter((entry) => entry.seconds > -30)
    .slice(0, 2);

  const spoken = next
    .map(({ departure, seconds }) => `linia ${departure.line} ${etaParts(seconds).value} ${etaParts(seconds).unit}`)
    .join(', ');

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={[stop.label, stop.name].filter(Boolean).join(', ') + (spoken ? `: ${spoken}` : '')}
      style={({ pressed }) => [styles.favourite, pressed && styles.pressed]}>
      <Ionicons name="star" size={16} color={theme.textSecondary} />
      <View style={styles.favouriteName}>
        <ThemedText type="callout" numberOfLines={1}>
          {stop.label || stop.name}
        </ThemedText>
        {!!stop.label && (
          <ThemedText type="caption" themeColor="textSecondary" numberOfLines={1}>
            {stop.name}
          </ThemedText>
        )}
      </View>
      {next.map(({ departure, seconds }) => {
        const eta = etaParts(seconds);
        return (
          <View key={`${departure.tripId}-${departure.departure}`} style={styles.favouriteNext}>
            <LineBadge line={departure.line} type={departure.type} size="small" />
            <ThemedText type="footnote" weight="semibold" color={theme.amber} style={styles.favouriteEta}>
              {eta.unit ? `${eta.value} ${eta.unit}` : eta.value}
            </ThemedText>
          </View>
        );
      })}
      {next.length === 0 && <Ionicons name="chevron-forward" size={16} color={theme.textTertiary} />}
    </Pressable>
  );
}

/**
 * A saved journey: the next departure that gets there, and when it does —
 * "4 za 3 min · na miejscu 7:54" — with the one after it for a rider who
 * will not make the first.
 */
function TripRow({
  trip,
  board,
  ageSeconds,
  receivedAt,
  onPress,
}: {
  trip: FavouriteTrip;
  board: TripBoard | null;
  ageSeconds: number;
  receivedAt: number | null;
  onPress: () => void;
}) {
  const theme = useTheme();
  const age = Math.min(Math.max(ageSeconds, 0), 90);
  const next = (board?.departures ?? [])
    .map((departure) => ({ departure, seconds: departureSeconds(departure) - age, arrives: arrivalSeconds(departure) }))
    .filter((entry) => entry.seconds > -30)
    .slice(0, 2);
  const first = next[0];
  const eta = first ? etaParts(first.seconds) : null;
  const status = !board
    ? 'Sprawdzamy połączenia…'
    : !board.supported
      ? 'Wymaga nowszej wersji serwera'
      : !first
        ? 'Brak bezpośrednich połączeń w najbliższych godzinach'
        : [
            first.arrives === null || receivedAt === null ? null : `na miejscu ${clockIn(first.arrives, receivedAt)}`,
            next[1] ? `potem ${next[1].departure.line} za ${etaParts(next[1].seconds).value} min` : null,
          ]
            .filter(Boolean)
            .join(' · ');

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${tripTitle(trip)}, ${trip.from.name} do ${trip.to.name}. ${
        first ? `Linia ${first.departure.line} za ${eta?.value} ${eta?.unit}. ${status}` : status
      }`}
      style={({ pressed }) => [styles.trip, pressed && styles.pressed]}>
      <View style={styles.favouriteName}>
        <ThemedText type="callout" weight="semibold" numberOfLines={1}>
          {tripTitle(trip)}
        </ThemedText>
        {!!trip.label && (
          <ThemedText type="caption" themeColor="textSecondary" numberOfLines={1}>
            {trip.from.name} → {trip.to.name}
          </ThemedText>
        )}
        <ThemedText type="footnote" themeColor="textSecondary" numberOfLines={1}>
          {status}
        </ThemedText>
      </View>
      {first && eta && (
        <View style={styles.favouriteNext}>
          <LineBadge line={first.departure.line} type={first.departure.type} size="small" />
          <ThemedText type="headline" color={theme.amber} style={styles.favouriteEta}>
            {eta.unit ? `${eta.value} ${eta.unit}` : eta.value}
          </ThemedText>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  favourite: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, minHeight: 52, paddingHorizontal: Space.lg },
  favouriteName: { flex: 1, minWidth: 0 },
  manage: { minHeight: 44, justifyContent: 'center', paddingHorizontal: Space.lg },
  trip: { flexDirection: 'row', alignItems: 'center', gap: Space.md, minHeight: 64, paddingHorizontal: Space.lg, paddingVertical: Space.sm },
  favouriteNext: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  favouriteEta: { fontVariant: ['tabular-nums'] },
  header: { gap: Space.sm, paddingBottom: Space.md },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  search: {
    flex: 1,
    // minHeight, not height: at the larger Dynamic Type sizes the placeholder
    // has to be allowed to push the field taller rather than be clipped by it.
    minHeight: 44,
    paddingVertical: Space.sm,
    borderRadius: Radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    paddingHorizontal: Space.md,
  },
  settings: {
    width: 44,
    minHeight: 44,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, minHeight: 20 },
  liveDot: { width: 7, height: 7, borderRadius: Radius.pill },
  statusText: { flex: 1, minWidth: 0 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.md,
    minHeight: 56,
  },
  bannerText: { flex: 1, gap: 1, minWidth: 0 },
  bannerMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: Space.md, minWidth: 0 },
  scroll: { flex: 1 },
  content: { paddingHorizontal: Space.lg, paddingTop: Space.xs, paddingBottom: Space.xxl, gap: Space.xl },
  pressed: { opacity: Motion.pressedOpacity },
});

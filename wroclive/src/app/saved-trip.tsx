import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Location from 'expo-location';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LineBadge } from '@/components/line-badge';
import { Section } from '@/components/list';
import { ModalScreen } from '@/components/modal-screen';
import { ThemedText } from '@/components/themed-text';
import { Motion, Radius, Space } from '@/constants/design';
import { usePoll } from '@/hooks/use-poll';
import { useTheme } from '@/hooks/use-theme';
import { getJourneyDepartures, type Departure } from '@/lib/api';
import { arrivalSeconds, clockIn, departureSeconds } from '@/lib/departures';
import { etaParts } from '@/lib/format';
import { tripTitle, useFavouriteTrips, type FavouriteTrip } from '@/lib/favourite-trips';
import { failed, tapped } from '@/lib/haptics';
import {
  leaveAlertStore,
  leaveAlertsAvailable,
  useLeaveAlert,
} from '@/lib/leave-alerts';
import { mapIntentStore } from '@/lib/map-intent';
import { leaveInSeconds, leaveLabel, walkSeconds } from '@/lib/walking';

const REFRESH_MS = 30_000;

export default function SavedTripScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const trips = useFavouriteTrips();
  const trip = trips.find((item) => item.id === id) ?? null;
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const alert = useLeaveAlert();
  const board = usePoll(
    (signal) =>
      trip
        ? getJourneyDepartures(trip.from.ids, trip.to.ids, { signal })
        : Promise.reject(new Error('Trip not found')),
    REFRESH_MS,
    { enabled: Boolean(trip), key: trip?.id ?? '' },
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!trip || !board.data || board.receivedAt === null) return;
    void leaveAlertStore.follow({ trip, ...board.data }, board.receivedAt);
  }, [board.data, board.receivedAt, trip]);

  const departures = useMemo(() => {
    const age = board.receivedAt === null ? 0 : Math.max(0, (now - board.receivedAt) / 1_000);
    return (board.data?.departures ?? [])
      .map((departure) => ({ departure, seconds: departureSeconds(departure) - age }))
      .filter((item) => item.seconds > -30)
      .slice(0, 8);
  }, [board.data, board.receivedAt, now]);

  if (!trip) {
    return (
      <ModalScreen title="Zapisany przejazd">
        <View style={styles.centered}>
          <Ionicons name="bookmark-outline" size={36} color={theme.textTertiary} />
          <ThemedText type="headline">Ten przejazd nie jest już zapisany</ThemedText>
        </View>
      </ModalScreen>
    );
  }

  return (
    <ModalScreen title={tripTitle(trip)} subtitle={`${trip.from.name} → ${trip.to.name}`}>
      {(scroll) => (
        <Animated.ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Space.xxl }]}
          showsVerticalScrollIndicator={false}
          onScroll={scroll.onScroll}
          scrollEventThrottle={scroll.scrollEventThrottle}>
          {alert?.favouriteTripId === trip.id && (
            <View style={[styles.armed, { backgroundColor: theme.backgroundCard }]}>
              <View style={[styles.armedIcon, { backgroundColor: theme.backgroundSelected }]}>
                <Ionicons name="notifications" size={18} color={theme.accent} />
              </View>
              <View style={styles.armedCopy}>
                <ThemedText type="callout" weight="semibold">
                  Powiadomimy, kiedy wyjść
                </ThemedText>
                <ThemedText type="footnote" themeColor="textSecondary">
                  Linia {alert.line} · około {clockAt(alert.firesAt)}
                </ThemedText>
              </View>
              <Pressable
                onPress={() => void leaveAlertStore.disarm()}
                accessibilityRole="button"
                accessibilityLabel="Wyłącz przypomnienie"
                hitSlop={8}
                style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
                <Ionicons name="close" size={18} color={theme.textSecondary} />
              </Pressable>
            </View>
          )}

          <Section
            title="Najbliższe odjazdy"
            icon="time-outline"
            plain
            footer="Rozpoczęcie przejazdu śledzi konkretny pojazd i kończy trasę na zapisanym przystanku.">
            {board.loading && !board.data ? (
              <View style={styles.loading}>
                <ActivityIndicator />
                <ThemedText type="footnote" themeColor="textSecondary">
                  Sprawdzamy połączenia…
                </ThemedText>
              </View>
            ) : board.error && !board.data ? (
              <StateCard
                icon="cloud-offline-outline"
                title="Nie udało się pobrać odjazdów"
                action="Spróbuj ponownie"
                onPress={board.refresh}
              />
            ) : board.data && !board.data.supported ? (
              <StateCard icon="server-outline" title="Ta funkcja wymaga nowszej wersji serwera" />
            ) : departures.length === 0 ? (
              <StateCard icon="time-outline" title="Brak bezpośrednich połączeń w najbliższych godzinach" />
            ) : (
              <View style={styles.departures}>
                {departures.map(({ departure, seconds }) => (
                  <DepartureCard
                    key={`${departure.tripId}-${departure.departure}-${departure.serviceDay}`}
                    trip={trip}
                    departure={departure}
                    seconds={seconds}
                    receivedAt={board.receivedAt ?? now}
                    alert={alert}
                  />
                ))}
              </View>
            )}
          </Section>
        </Animated.ScrollView>
      )}
    </ModalScreen>
  );
}

function DepartureCard({
  trip,
  departure,
  seconds,
  receivedAt,
  alert,
}: {
  trip: FavouriteTrip;
  departure: Departure;
  seconds: number;
  receivedAt: number;
  alert: ReturnType<typeof useLeaveAlert>;
}) {
  const theme = useTheme();
  const router = useRouter();
  const [arming, setArming] = useState(false);
  const eta = etaParts(seconds);
  const arrives = arrivalSeconds(departure);
  const active =
    alert?.departureTripId === departure.tripId &&
    alert.departureClock === departure.departure &&
    alert.serviceDay === departure.serviceDay;

  const start = () => {
    if (!departure.vehicleId) return;
    tapped();
    mapIntentStore.startJourney({
      vehicleId: departure.vehicleId,
      line: departure.line,
      destinationIds: trip.to.ids,
      destinationName: trip.to.name,
      arrivalStopId: departure.arrivalStopId ?? null,
    });
    router.back();
  };

  const arm = async () => {
    if (!leaveAlertsAvailable || arming) return;
    setArming(true);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== 'granted') {
        failed();
        Alert.alert(
          'Potrzebna jest lokalizacja',
          'Używamy jej tylko do oszacowania spaceru na przystanek.',
          permission.canAskAgain
            ? [{ text: 'OK' }]
            : [
                { text: 'Anuluj', style: 'cancel' },
                { text: 'Ustawienia', onPress: () => void Linking.openSettings() },
              ],
        );
        return;
      }
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const walk = walkSeconds(
        { lat: position.coords.latitude, lon: position.coords.longitude },
        trip.from,
      );
      if (walk === null) {
        failed();
        Alert.alert('Za daleko od przystanku', 'Przypomnienie działa dla spaceru do około 15 minut.');
        return;
      }
      const leaveIn = leaveInSeconds(Math.max(0, seconds), walk);
      if (leaveIn < -30) {
        failed();
        Alert.alert('Nie zdążysz na ten odjazd', 'Wybierz późniejsze połączenie.');
        return;
      }
      const result = await leaveAlertStore.arm(trip, departure, receivedAt, walk);
      if (result === 'denied') {
        failed();
        Alert.alert(
          'Powiadomienia są wyłączone',
          'Włącz je w ustawieniach telefonu, aby dostać przypomnienie o wyjściu.',
          [
            { text: 'Anuluj', style: 'cancel' },
            { text: 'Ustawienia', onPress: () => void Linking.openSettings() },
          ],
        );
      } else if (result === 'passed') {
        Alert.alert('Ten odjazd jest za blisko', 'Wybierz późniejsze połączenie.');
      } else {
        tapped();
        const label = leaveLabel(leaveIn);
        Alert.alert('Przypomnienie ustawione', `${label.text}. Spacer zajmie około ${Math.max(1, Math.ceil(walk / 60))} min.`);
      }
    } catch {
      failed();
      Alert.alert('Nie udało się ustawić przypomnienia', 'Sprawdź lokalizację i spróbuj ponownie.');
    } finally {
      setArming(false);
    }
  };

  return (
    <View style={[styles.departureCard, { backgroundColor: theme.backgroundCard }]}>
      <View style={styles.departureHeader}>
        <LineBadge line={departure.line} type={departure.type} />
        <View style={styles.departureCopy}>
          <ThemedText type="callout" weight="semibold" numberOfLines={1}>
            {departure.headsign ?? `Linia ${departure.line}`}
          </ThemedText>
          <ThemedText type="footnote" themeColor="textSecondary" numberOfLines={1}>
            {arrives === null ? `Odjazd ${departure.departure}` : `Na miejscu ${clockIn(arrives, receivedAt)}`}
            {departure.realtime ? ' · na żywo' : ' · rozkład'}
          </ThemedText>
        </View>
        <ThemedText type="headline" weight="bold" color={theme.amber}>
          {eta.unit ? `${eta.value} ${eta.unit}` : eta.value}
        </ThemedText>
      </View>

      <View style={styles.actions}>
        <Pressable
          onPress={() => (active ? void leaveAlertStore.disarm() : void arm())}
          disabled={!leaveAlertsAvailable || arming}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.secondaryAction,
            { backgroundColor: theme.backgroundElement },
            pressed && styles.pressed,
          ]}>
          {arming ? (
            <ActivityIndicator size="small" />
          ) : (
            <Ionicons
              name={active ? 'notifications' : 'notifications-outline'}
              size={17}
              color={active ? theme.accent : theme.textSecondary}
            />
          )}
          <ThemedText type="footnote" weight="semibold">
            {active ? 'Wyłącz alarm' : 'Kiedy wyjść'}
          </ThemedText>
        </Pressable>
        <Pressable
          onPress={start}
          disabled={!departure.vehicleId}
          accessibilityRole="button"
          accessibilityHint={departure.vehicleId ? 'Uruchamia śledzenie przejazdu' : 'Pojazd nie jest jeszcze widoczny na żywo'}
          style={({ pressed }) => [
            styles.primaryAction,
            { backgroundColor: departure.vehicleId ? theme.accent : theme.backgroundElement },
            pressed && styles.pressed,
          ]}>
          <Ionicons
            name="navigate"
            size={17}
            color={departure.vehicleId ? '#ffffff' : theme.textTertiary}
          />
          <ThemedText
            type="footnote"
            weight="semibold"
            color={departure.vehicleId ? '#ffffff' : theme.textTertiary}>
            {departure.vehicleId ? 'Rozpocznij' : 'Jeszcze bez live'}
          </ThemedText>
        </Pressable>
      </View>
    </View>
  );
}

function StateCard({
  icon,
  title,
  action,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  action?: string;
  onPress?: () => void;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.stateCard, { backgroundColor: theme.backgroundCard }]}>
      <Ionicons name={icon} size={24} color={theme.textTertiary} />
      <ThemedText type="callout" themeColor="textSecondary" style={styles.stateText}>
        {title}
      </ThemedText>
      {!!action && !!onPress && (
        <Pressable onPress={onPress} accessibilityRole="button">
          <ThemedText type="callout" weight="semibold" color={theme.accent}>
            {action}
          </ThemedText>
        </Pressable>
      )}
    </View>
  );
}

const clockAt = (timestamp: number) => {
  const date = new Date(timestamp);
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
};

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { paddingHorizontal: Space.lg, gap: Space.lg },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Space.md, padding: Space.xl },
  armed: {
    minHeight: 64,
    borderRadius: Radius.lg,
    padding: Space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
  },
  armedIcon: { width: 36, height: 36, borderRadius: Radius.md, alignItems: 'center', justifyContent: 'center' },
  armedCopy: { flex: 1, gap: 2 },
  iconButton: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  loading: { minHeight: 120, alignItems: 'center', justifyContent: 'center', gap: Space.sm },
  departures: { gap: Space.sm },
  departureCard: { borderRadius: Radius.lg, padding: Space.md, gap: Space.md },
  departureHeader: { flexDirection: 'row', alignItems: 'center', gap: Space.md },
  departureCopy: { flex: 1, minWidth: 0, gap: 2 },
  actions: { flexDirection: 'row', gap: Space.sm },
  primaryAction: {
    flex: 1,
    minHeight: 42,
    borderRadius: Radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Space.xs,
  },
  secondaryAction: {
    flex: 1,
    minHeight: 42,
    borderRadius: Radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Space.xs,
  },
  stateCard: {
    minHeight: 120,
    borderRadius: Radius.lg,
    padding: Space.lg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Space.sm,
  },
  stateText: { textAlign: 'center' },
  pressed: { opacity: Motion.pressedOpacity },
});
